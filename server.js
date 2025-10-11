// server.js
const express = require('express');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const serverless = require('serverless-http');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('client'));

let clientPromise = null;
let db = null;

async function initDb() {
  if (db) return db;

  if (!clientPromise) {
    const uri = process.env.MONGO_URI || process.env.DB_URI;
    if (!uri) throw new Error('Missing MONGO_URI or DB_URI environment variable');

    const client = new MongoClient(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    clientPromise = client.connect().catch(err => {
      clientPromise = null; // reset cache if connection fails
      throw err;
    });
  }

  const connectedClient = await clientPromise;
  db = connectedClient.db('secure_app_db');
  return db;
}

// Initialize session store once
let sessionSetup = false;
async function ensureSessionMiddleware() {
  if (sessionSetup) return;
  await initDb();
  const store = MongoStore.create({
    clientPromise,
    dbName: 'secure_app_db',
  });
  app.use(session({
    secret: process.env.SESSION_SECRET || 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    store,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    }
  }));
  sessionSetup = true;
}

// Define routes
let routesSetup = false;
function setupRoutes() {
  if (routesSetup) return;
  routesSetup = true;

  const USERS = {
    'user1': { id: 1, password: 'password1', role: 'user' },
    'user2': { id: 2, password: 'password2', role: 'user' },
    'admin': { id: 99, password: 'adminpass', role: 'admin' }
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

  const loginRequired = (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ message: "Authentication required" });
    next();
  };

  // --- ROUTES ---
  app.post('/api/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = USERS[username];
      if (user && user.password === password) {
        req.session.user = { username, ...user };
        await logger(req.session.user, 'LOGIN_SUCCESS');
        res.json(req.session.user);
      } else {
        await logger({ username, role: 'N/A' }, 'LOGIN_FAILURE');
        res.status(401).json({ message: 'Invalid credentials' });
      }
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ message: 'Server error during login', details: err.message });
    }
  });

  app.get('/api/logout', loginRequired, async (req, res) => {
    await logger(req.session.user, 'LOGOUT');
    req.session.destroy(() => res.json({ message: 'Logged out' }));
  });

  app.get('/api/notes', loginRequired, async (req, res) => {
    const notes = await dbHandler.getNotes();
    const visible = req.session.user.role === 'admin'
      ? notes
      : notes.filter(n => n.authorId === req.session.user.id);
    res.json(visible);
  });

  app.post('/api/notes', loginRequired, async (req, res) => {
    const newNote = {
      id: Date.now(),
      content: req.body.content,
      authorId: req.session.user.id,
      authorUsername: req.session.user.username,
      timestamp: new Date()
    };
    await dbHandler.addNote(newNote);
    await logger(req.session.user, 'CREATE_NOTE');
    res.status(201).json(newNote);
  });

  app.delete('/api/notes/:id', loginRequired, async (req, res) => {
    const noteId = parseInt(req.params.id, 10);
    const notes = await dbHandler.getNotes();
    const note = notes.find(n => n.id === noteId);
    if (!note) return res.status(404).json({ message: "Note not found" });

    const canDelete = note.authorId === req.session.user.id || req.session.user.role === 'admin';
    if (!canDelete) {
      await logger(req.session.user, 'DELETE_NOTE_DENIED');
      return res.status(403).json({ message: 'Access Denied' });
    }

    await dbHandler.deleteNote(noteId);
    await logger(req.session.user, 'DELETE_NOTE');
    res.status(200).json({ message: 'Note deleted' });
  });

  app.get('/api/audit', loginRequired, async (req, res) => {
    if (req.session.user.role !== 'admin')
      return res.status(403).json({ message: "Admin access required" });

    const db = await initDb();
    const logs = await db.collection('audit_logs').find({}).sort({ timestamp: -1 }).toArray();
    res.json(logs);
  });

  app.post('/api/toggle_db', loginRequired, (req, res) => {
    global.PRIMARY_DB_IS_DOWN = !global.PRIMARY_DB_IS_DOWN;
    res.json({ isDown: global.PRIMARY_DB_IS_DOWN });
  });

  app.get('/api/session', (req, res) => {
    if (req.session.user) res.json({ user: req.session.user });
    else res.status(401).json({ message: 'Not authenticated' });
  });
}

// --- Export handler for Vercel ---
let handler;
module.exports = async (req, res) => {
  if (!sessionSetup) await ensureSessionMiddleware();
  setupRoutes();
  if (!handler) handler = serverless(app);
  return handler(req, res);
};

// --- Local Development ---
if (require.main === module) {
  (async () => {
    await ensureSessionMiddleware();
    setupRoutes();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
  })();
}
