const express = require('express');
const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();

// Middleware
app.use(express.json());
app.use(cookieParser());

// Environment variables
const uri = process.env.DB_URI || process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-in-production';

// MongoDB connection
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }

  if (!uri) {
    throw new Error('MongoDB URI not found in environment variables');
  }

  try {
    const client = await MongoClient.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    
    cachedDb = client.db('secure_app_db');
    console.log('✅ Connected to MongoDB');
    return cachedDb;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    throw error;
  }
}

// Users data
const USERS = {
  'user1': { id: 1, username: 'user1', password: 'password1', role: 'user' },
  'user2': { id: 2, username: 'user2', password: 'password2', role: 'user' },
  'admin': { id: 99, username: 'admin', password: 'adminpass', role: 'admin' }
};

// Logger function
async function logger(user, action) {
  try {
    const db = await connectToDatabase();
    await db.collection('audit_logs').insertOne({
      timestamp: new Date(),
      username: user.username,
      role: user.role,
      action,
    });
  } catch (error) {
    console.error('Logger error:', error.message);
  }
}

// Auth middleware
function authRequired(req, res, next) {
  let token = req.cookies.auth_token;
  
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }
  
  if (!token) {
    return res.status(401).json({ message: "Authentication required" });
  }
  
  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// Routes

// Health check
app.get('/api/ping', async (req, res) => {
  try {
    const db = await connectToDatabase();
    await db.command({ ping: 1 });
    res.status(200).send('pong ✅ Database connected');
  } catch (err) {
    res.status(500).send('Database not reachable ❌: ' + err.message);
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    
    const user = USERS[username];
    if (!user || user.password !== password) {
      await logger({ username, role: 'unknown' }, 'LOGIN_FAILED');
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const tokenPayload = { id: user.id, username: user.username, role: user.role };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '1d' });

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    });

    await logger(user, 'LOGIN_SUCCESS');
    
    res.json({ 
      message: "Login successful", 
      user: tokenPayload,
      token: token
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Logout
app.get('/api/logout', authRequired, async (req, res) => {
  try {
    await logger(req.user, 'LOGOUT');
    res.clearCookie('auth_token', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/'
    });
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Session check
app.get('/api/session', authRequired, (req, res) => {
  res.json({ user: req.user });
});

// Get notes
app.get('/api/notes', authRequired, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const collectionName = global.PRIMARY_DB_IS_DOWN ? 'notes_fallback' : 'notes_primary';
    const notes = await db.collection(collectionName).find({}).sort({ timestamp: -1 }).toArray();
    
    const visible = req.user.role === 'admin'
      ? notes
      : notes.filter(n => n.authorId === req.user.id);
    
    res.json(visible);
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// Create note
app.post('/api/notes', authRequired, async (req, res) => {
  try {
    if (!req.body.content) {
      return res.status(400).json({ error: 'Note content is required' });
    }
    
    const newNote = {
      id: Date.now(),
      content: req.body.content,
      authorId: req.user.id,
      authorUsername: req.user.username,
      timestamp: new Date()
    };
    
    const db = await connectToDatabase();
    await db.collection('notes_primary').insertOne(newNote);
    await db.collection('notes_fallback').insertOne(newNote);
    
    await logger(req.user, 'CREATE_NOTE');
    res.status(201).json(newNote);
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// Delete note
app.delete('/api/notes/:id', authRequired, async (req, res) => {
  try {
    const noteId = parseInt(req.params.id, 10);
    
    const db = await connectToDatabase();
    const collectionName = global.PRIMARY_DB_IS_DOWN ? 'notes_fallback' : 'notes_primary';
    const notes = await db.collection(collectionName).find({}).toArray();
    
    const note = notes.find(n => n.id === noteId);
    if (!note) {
      return res.status(404).json({ message: "Note not found" });
    }

    const canDelete = note.authorId === req.user.id || req.user.role === 'admin';
    if (!canDelete) {
      await logger(req.user, 'DELETE_NOTE_DENIED');
      return res.status(403).json({ message: 'Access Denied' });
    }

    await db.collection('notes_primary').deleteOne({ id: noteId });
    await db.collection('notes_fallback').deleteOne({ id: noteId });
    
    await logger(req.user, 'DELETE_NOTE');
    res.status(200).json({ message: 'Note deleted' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Get audit logs
app.get('/api/audit', authRequired, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: "Admin access required" });
    }
    
    const db = await connectToDatabase();
    const logs = await db.collection('audit_logs').find({}).sort({ timestamp: -1 }).toArray();
    res.json(logs);
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// Toggle database
app.post('/api/toggle_db', authRequired, (req, res) => {
  global.PRIMARY_DB_IS_DOWN = !global.PRIMARY_DB_IS_DOWN;
  res.json({ isDown: global.PRIMARY_DB_IS_DOWN });
});

// Export for Vercel
module.exports = app;