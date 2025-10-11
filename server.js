const express = require('express');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  credentials: true,
  origin: [
    'http://127.0.0.1:5500',
    'https://your-frontend-name.onrender.com'
  ]
}));

app.use(express.json());
app.use(express.static('client'));
app.use(session({
    secret: 'secret-key-for-demonstration',
    resave: false,
    saveUninitialized: true,
}));

let PRIMARY_DB_IS_DOWN = false;
const USERS = {
    'user1': { id: 1, password: 'password1', role: 'user' },
    'user2': { id: 2, password: 'password2', role: 'user' },
    'admin': { id: 99, password: 'adminpass', role: 'admin' }
};

const client = new MongoClient(process.env.DB_URI);
let db;

async function connectDB() {
    try {
        await client.connect();
        db = client.db('secure_app_db');
        console.log("Connected to MongoDB.");
    } catch (e) {
        console.error("Could not connect to MongoDB", e);
        process.exit(1);
    }
}

const logger = async (user, action) => {
    await db.collection('audit_logs').insertOne({
        timestamp: new Date(),
        username: user.username,
        role: user.role,
        action,
    });
};

const dbHandler = {
    getNotes: async () => {
        let collectionName = PRIMARY_DB_IS_DOWN ? 'notes_fallback' : 'notes_primary';
        if (PRIMARY_DB_IS_DOWN) console.log("Primary DB down, using fallback.");
        return await db.collection(collectionName).find({}).sort({ timestamp: -1 }).toArray();
    },
    addNote: async (note) => {
        await db.collection('notes_primary').insertOne(note);
        await db.collection('notes_fallback').insertOne(note);
    },
    deleteNote: async (noteId) => {
        const filter = { id: noteId };
        await db.collection('notes_primary').deleteOne(filter);
        await db.collection('notes_fallback').deleteOne(filter);
    }
};

const loginRequired = (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ message: "Authentication required" });
    next();
};

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = USERS[username];
    if (user && user.password === password) {
        req.session.user = { username, ...user };
        await logger(req.session.user, 'LOGIN_SUCCESS');
        res.json(req.session.user);
    } else {
        await logger({ username: username, role: 'N/A' }, 'LOGIN_FAILURE');
        res.status(401).json({ message: 'Invalid credentials' });
    }
});

app.get('/api/logout', loginRequired, async (req, res) => {
    await logger(req.session.user, 'LOGOUT');
    req.session.destroy(() => res.json({ message: 'Logged out' }));
});

app.get('/api/notes', loginRequired, async (req, res) => {
    let notes = await dbHandler.getNotes();
    if (req.session.user.role !== 'admin') {
        notes = notes.filter(note => note.authorId === req.session.user.id);
    }
    res.json(notes);
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
    const noteToDelete = notes.find(n => n.id === noteId);

    if (!noteToDelete) return res.status(404).json({ message: "Note not found" });

    const isOwner = noteToDelete.authorId === req.session.user.id;
    const isAdmin = req.session.user.role === 'admin';

    if (isOwner || isAdmin) {
        await dbHandler.deleteNote(noteId);
        await logger(req.session.user, 'DELETE_NOTE');
        res.status(200).json({ message: 'Note deleted' });
    } else {
        await logger(req.session.user, 'DELETE_NOTE_DENIED');
        res.status(403).json({ message: 'Access Denied' });
    }
});

app.get('/api/audit', loginRequired, async (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ message: "Admin access required" });
    }
    const logs = await db.collection('audit_logs').find({}).sort({ timestamp: -1 }).toArray();
    res.json(logs);
});

app.post('/api/toggle_db', loginRequired, (req, res) => {
    PRIMARY_DB_IS_DOWN = !PRIMARY_DB_IS_DOWN;
    res.json({ isDown: PRIMARY_DB_IS_DOWN });
});

app.get('/api/session', (req, res) => {
    if (req.session.user) {
        res.json({ user: req.session.user });
    } else {
        res.status(401).json({ message: 'Not authenticated' });
    }
});

connectDB().then(() => {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
});