const express = require('express');
const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

// CORS for Vercel
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const uri = process.env.DB_URI || process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key';

let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  if (!uri) throw new Error('MongoDB URI not configured');

  const client = await MongoClient.connect(uri, {
    serverSelectionTimeoutMS: 10000,
  });
  
  cachedDb = client.db('secure_app_db');
  return cachedDb;
}

const USERS = {
  'user1': { id: 1, username: 'user1', password: 'password1', role: 'user' },
  'user2': { id: 2, username: 'user2', password: 'password2', role: 'user' },
  'admin': { id: 99, username: 'admin', password: 'adminpass', role: 'admin' }
};

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

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: "Invalid token format" });
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// Health check
app.get('/api/ping', async (req, res) => {
  try {
    const db = await connectToDatabase();
    await db.command({ ping: 1 });
    res.status(200).json({ message: 'pong ✅ Database connected' });
  } catch (err) {
    res.status(500).json({ error: 'Database not reachable', details: err.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = USERS[username];
    if (!user || user.password !== password) {
      await logger({ username, role: 'unknown' }, 'LOGIN_FAILED');
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const tokenPayload = { id: user.id, username: user.username, role: user.role };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '1d' });

    await logger(user, 'LOGIN_SUCCESS');
    
    res.json({ 
      message: "Login successful", 
      user: tokenPayload,
      token: token
    });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Logout
app.post('/api/logout', authRequired, async (req, res) => {
  await logger(req.user, 'LOGOUT');
  res.json({ message: 'Logged out' });
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
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// Create note
app.post('/api/notes', authRequired, async (req, res) => {
  try {
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
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// Toggle database
app.post('/api/toggle_db', authRequired, (req, res) => {
  global.PRIMARY_DB_IS_DOWN = !global.PRIMARY_DB_IS_DOWN;
  res.json({ isDown: global.PRIMARY_DB_IS_DOWN });
});

module.exports = app;