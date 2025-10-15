const express = require('express');
const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const serverless = require('serverless-http');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static('client'));

const uri = process.env.MONGO_URI || process.env.DB_URI;
if (!uri) {
  console.error('❌ Missing Mongo URI in environment variables');
}

let dbPromise = null;
async function initDb() {
  if (!dbPromise) {
    try {
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });
      dbPromise = client.connect().then(c => {
        console.log('✅ MongoDB connected successfully');
        return c.db('secure_app_db');
      });
    } catch (error) {
      console.error('❌ MongoDB connection failed:', error);
      throw error;
    }
  }
  return dbPromise;
}

// --- Health check (for /api/ping) ---
app.get('/api/ping', async (req, res) => {
  try {
    const db = await initDb();
    await db.command({ ping: 1 });
    res.status(200).send('pong ✅ Database connected');
  } catch (err) {
    console.error('Ping failed:', err.message);
    res.status(500).send('Database not reachable ❌');
  }
});

let routesSetup = false;
function setupRoutes() {
  if (routesSetup) return;
  routesSetup = true;

  const USERS = {
    'user1': { id: 1, username: 'user1', password: 'password1', role: 'user' },
    'user2': { id: 2, username: 'user2', password: 'password2', role: 'user' },
    'admin': { id: 99, username: 'admin', password: 'adminpass', role: 'admin' }
  };

  const logger = async (user, action) => {
    try {
      const db = await initDb();
      await db.collection('audit_logs').insertOne({
        timestamp: new Date(),
        username: user.username,
        role: user.role,
        action,
      });
    } catch (error) {
      console.error('❌ Logger error:', error);
    }
  };

  const dbHandler = {
    getNotes: async () => {
      const db = await initDb();
      const collectionName = global.PRIMARY_DB_IS_DOWN ? 'notes_fallback' : 'notes_primary';
      return await db.collection(collectionName).find({}).sort({ timestamp: -1 }).toArray();
    },
    addNote: async (note) => {
      const db = await initDb();
      await db.collection('notes_primary').insertOne(note);
      await db.collection('notes_fallback').insertOne(note);
    },
    deleteNote: async (noteId) => {
      const db = await initDb();
      const filter = { id: noteId };
      await db.collection('notes_primary').deleteOne(filter);
      await db.collection('notes_fallback').deleteOne(filter);
    }
  };

  const authRequired = (req, res, next) => {
    // Check cookie first, then Authorization header
    let token = req.cookies.auth_token;
    
    if (!token && req.headers.authorization) {
      const parts = req.headers.authorization.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
      }
    }
    
    if (!token) {
      console.log('❌ No token found in request');
      return res.status(401).json({ message: "Authentication required" });
    }
    
    try {
      const user = jwt.verify(token, process.env.JWT_SECRET || 'your-jwt-secret');
      req.user = user;
      console.log('✅ User authenticated:', user.username);
      next();
    } catch (err) {
      console.error("❌ JWT Verification Error:", err.message);
      return res.status(401).json({ message: "Invalid or expired token" });
    }
  };

  app.post("/api/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      console.log('🔐 Login attempt:', username);
      
      const user = USERS[username];
      if (!user || user.password !== password) {
        await logger({ username, role: 'unknown' }, 'LOGIN_FAILED');
        console.log('❌ Invalid credentials for:', username);
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const tokenPayload = { id: user.id, username: user.username, role: user.role };
      const token = jwt.sign(
        tokenPayload, 
        process.env.JWT_SECRET || 'your-jwt-secret', 
        { expiresIn: '1d' }
      );

      // Set cookie (will work if same-origin)
      res.cookie('auth_token', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 24 * 60 * 60 * 1000,
        path: '/'
      });

      await logger(user, 'LOGIN_SUCCESS');
      console.log('✅ Login successful for:', username);
      
      // ALSO return token in response body (for localStorage fallback)
      res.json({ 
        message: "Login successful", 
        user: tokenPayload,
        token: token
      });
    } catch (err) {
      console.error("❌ Login error:", err);
      res.status(500).json({ error: "Server error", details: err.message });
    }
  });

  app.get('/api/logout', authRequired, async (req, res) => {
    await logger(req.user, 'LOGOUT');
    res.clearCookie('auth_token', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/'
    });
    res.json({ message: 'Logged out' });
  });

  app.get('/api/notes', authRequired, async (req, res) => {
    try {
      const notes = await dbHandler.getNotes();
      const visible = req.user.role === 'admin'
        ? notes
        : notes.filter(n => n.authorId === req.user.id);
      res.json(visible);
    } catch (error) {
      console.error('❌ Error fetching notes:', error);
      res.status(500).json({ error: 'Failed to fetch notes' });
    }
  });

  app.post('/api/notes', authRequired, async (req, res) => {
    try {
      const newNote = {
        id: Date.now(),
        content: req.body.content,
        authorId: req.user.id,
        authorUsername: req.user.username,
        timestamp: new Date()
      };
      await dbHandler.addNote(newNote);
      await logger(req.user, 'CREATE_NOTE');
      res.status(201).json(newNote);
    } catch (error) {
      console.error('❌ Error creating note:', error);
      res.status(500).json({ error: 'Failed to create note' });
    }
  });

  app.delete('/api/notes/:id', authRequired, async (req, res) => {
    try {
      const noteId = parseInt(req.params.id, 10);
      const notes = await dbHandler.getNotes();
      const note = notes.find(n => n.id === noteId);
      if (!note) return res.status(404).json({ message: "Note not found" });

      const canDelete = note.authorId === req.user.id || req.user.role === 'admin';
      if (!canDelete) {
        await logger(req.user, 'DELETE_NOTE_DENIED');
        return res.status(403).json({ message: 'Access Denied' });
      }

      await dbHandler.deleteNote(noteId);
      await logger(req.user, 'DELETE_NOTE');
      res.status(200).json({ message: 'Note deleted' });
    } catch (error) {
      console.error('❌ Error deleting note:', error);
      res.status(500).json({ error: 'Failed to delete note' });
    }
  });

  app.get('/api/audit', authRequired, async (req, res) => {
    try {
      if (req.user.role !== 'admin')
        return res.status(403).json({ message: "Admin access required" });
      const db = await initDb();
      const logs = await db.collection('audit_logs').find({}).sort({ timestamp: -1 }).toArray();
      res.json(logs);
    } catch (error) {
      console.error('❌ Error fetching audit logs:', error);
      res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
  });

  app.post('/api/toggle_db', authRequired, (req, res) => {
    global.PRIMARY_DB_IS_DOWN = !global.PRIMARY_DB_IS_DOWN;
    console.log(`🔄 Database toggled. Primary is now ${global.PRIMARY_DB_IS_DOWN ? 'DOWN' : 'UP'}`);
    res.json({ isDown: global.PRIMARY_DB_IS_DOWN });
  });

  app.get('/api/session', authRequired, (req, res) => {
    res.json({ user: req.user });
  });
}

setupRoutes();
module.exports = serverless(app);

if (require.main === module) {
  (async () => {
    await initDb();
    setupRoutes();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`✅ Server running at http://localhost:${port}`));
  })();
}