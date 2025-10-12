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
    const client = new MongoClient(uri);
    dbPromise = client.connect().then(c => c.db('secure_app_db'));
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
    const db = await initDb();
    await db.collection('audit_logs').insertOne({
      timestamp: new Date(),
      username: user.username,
      role: user.role,
      action,
    });
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
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ message: "Authentication required" });
    try {
      const user = jwt.verify(token, process.env.JWT_SECRET || 'your-jwt-secret');
      req.user = user;
      next();
    } catch (err) {
      console.error("JWT Verification Error:", err.message);
      return res.status(401).json({ message: "Invalid or expired token" });
    }
  };

  app.post("/api/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = USERS[username];
      if (!user || user.password !== password) {
        await logger({ username, role: 'unknown' }, 'LOGIN_FAILED');
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const tokenPayload = { id: user.id, username: user.username, role: user.role };
      const token = jwt.sign(tokenPayload, process.env.JWT_SECRET || 'your-jwt-secret', { expiresIn: '1d' });

      res.cookie('auth_token', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 24 * 60 * 60 * 1000,
      });

      await logger(user, 'LOGIN_SUCCESS');
      res.json({ message: "Login successful", user: tokenPayload });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ error: "Server error", details: err.message });
    }
  });

  app.get('/api/logout', authRequired, async (req, res) => {
    await logger(req.user, 'LOGOUT');
    res.cookie('auth_token', '', {
      expires: new Date(0),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });
    res.json({ message: 'Logged out' });
  });

  app.get('/api/notes', authRequired, async (req, res) => {
    const notes = await dbHandler.getNotes();
    const visible = req.user.role === 'admin'
      ? notes
      : notes.filter(n => n.authorId === req.user.id);
    res.json(visible);
  });

  app.post('/api/notes', authRequired, async (req, res) => {
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
  });

  app.delete('/api/notes/:id', authRequired, async (req, res) => {
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
  });

  app.get('/api/audit', authRequired, async (req, res) => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ message: "Admin access required" });
    const db = await initDb();
    const logs = await db.collection('audit_logs').find({}).sort({ timestamp: -1 }).toArray();
    res.json(logs);
  });

  app.post('/api/toggle_db', authRequired, (req, res) => {
    global.PRIMARY_DB_IS_DOWN = !global.PRIMARY_DB_IS_DOWN;
    res.json({ isDown: global.PRIMARY_DB_IS_DOWN });
  });

  app.get('/api/session', authRequired, (req, res) => {
    res.json({ user: req.user });
  });
}

setupRoutes();
module.exports = require('serverless-http')(app);

if (require.main === module) {
  (async () => {
    await initDb();
    setupRoutes();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`✅ Server running at http://localhost:${port}`));
  })();
}
