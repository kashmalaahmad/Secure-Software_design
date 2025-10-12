const express = require('express');
const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');      // NEW: For creating and verifying tokens
const cookieParser = require('cookie-parser'); // NEW: For reading the token from the cookie
const serverless = require('serverless-http');
require('dotenv').config();

console.log('DB_URI loaded status:', !!process.env.DB_URI ? 'LOADED' : 'MISSING/EMPTY');
if (!!process.env.DB_URI && !process.env.DB_URI.startsWith('mongodb')) {
    console.error('DB_URI value starts with:', process.env.DB_URI.substring(0, 30));
}

const app = express();
app.use(express.json());
app.use(cookieParser()); // Use cookie parser to read tokens
app.use(express.static('client'));

let client;
let db;
let routesSetup = false; // sessionSetup and ensureSessionMiddleware are removed

async function initDb() {
    if (db) return db;
    if (!client) {
        const uri = process.env.MONGO_URI || process.env.DB_URI;
        if (!uri) throw new Error('Missing MONGO_URI or DB_URI');
        client = new MongoClient(uri);
        await client.connect();
    }
    db = client.db('secure_app_db');
    return db;
}

// REMOVED: async function ensureSessionMiddleware() - No longer needed with JWT

function setupRoutes() {
    if (routesSetup) return;
    routesSetup = true;

    const USERS = {
        'user1': { id: 1, username: 'user1', password: 'password1', role: 'user' },
        'user2': { id: 2, username: 'user2', password: 'password2', role: 'user' },
        'admin': { id: 99, username: 'admin', password: 'adminpass', role: 'admin' }
    };

    const logger = async (user, action) => {
        // NOTE: 'user' now comes from the JWT payload (req.user), not req.session.user
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

    // NEW: Authentication Middleware using JWT
    const authRequired = (req, res, next) => {
        const token = req.cookies.auth_token;

        if (!token) return res.status(401).json({ message: "Authentication required" });

        try {
            // Verify and decode the token using the secret key
            const user = jwt.verify(token, process.env.JWT_SECRET || 'your-jwt-secret');
            req.user = user; // Attach user payload to the request for use in routes
            next();
        } catch (err) {
            // Token is invalid or expired
            return res.status(401).json({ message: "Invalid or expired token" });
        }
    };
    
    // Use the authRequired middleware for all protected routes

    app.post("/api/login", async (req, res) => {
        try {
            const { username, password } = req.body;
            const user = USERS[username]; // Note: USERS object now contains 'username' field too for consistency
            
            if (!user || user.password !== password) {
                // If invalid credentials, log the attempt and return 401
                await logger({ username, role: 'unknown' }, 'LOGIN_FAILED');
                return res.status(401).json({ error: "Invalid credentials" });
            }
            
            // 1. Create the JWT payload (only necessary data, NOT the password)
            const tokenPayload = { id: user.id, username: user.username, role: user.role };

            // 2. Sign the token
            const token = jwt.sign(
                tokenPayload, 
                process.env.JWT_SECRET || 'your-jwt-secret', 
                { expiresIn: '1d' } // Token expires in 1 day
            );

            // 3. Set the token as an HTTP-only cookie
            res.cookie('auth_token', token, {
                httpOnly: true, // Prevents client-side JS access (security)
                secure: process.env.NODE_ENV === 'production', // Use 'secure' only over HTTPS
                sameSite: 'lax',
                maxAge: 24 * 60 * 60 * 1000, // 1 day expiration
            });

            await logger(user, 'LOGIN_SUCCESS');
            // Return user info to the client to update the UI immediately
            res.json({ message: "Login successful", user: tokenPayload }); 

        } catch (err) {
            console.error("Login error:", err);
            res.status(500).json({ error: "Server error", details: err.message });
        }
    });

    app.get('/api/logout', authRequired, async (req, res) => {
        await logger(req.user, 'LOGOUT');
        // Clear the cookie to log the user out
        res.cookie('auth_token', '', { expires: new Date(0), httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
        res.json({ message: 'Logged out' });
    });

    // Replace loginRequired with authRequired for all protected routes below

    app.get('/api/notes', authRequired, async (req, res) => {
        const notes = await dbHandler.getNotes();
        const visible = req.user.role === 'admin'
            ? notes
            : notes.filter(n => n.authorId === req.user.id); // Use req.user
        res.json(visible);
    });

    app.post('/api/notes', authRequired, async (req, res) => {
        const newNote = {
            id: Date.now(),
            content: req.body.content,
            authorId: req.user.id, // Use req.user
            authorUsername: req.user.username, // Use req.user
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

        const canDelete = note.authorId === req.user.id || req.user.role === 'admin'; // Use req.user
        if (!canDelete) {
            await logger(req.user, 'DELETE_NOTE_DENIED');
            return res.status(403).json({ message: 'Access Denied' });
        }

        await dbHandler.deleteNote(noteId);
        await logger(req.user, 'DELETE_NOTE');
        res.status(200).json({ message: 'Note deleted' });
    });

    app.get('/api/audit', authRequired, async (req, res) => {
        if (req.user.role !== 'admin') // Use req.user
            return res.status(403).json({ message: "Admin access required" });
        const db = await initDb();
        const logs = await db.collection('audit_logs').find({}).sort({ timestamp: -1 }).toArray();
        res.json(logs);
    });

    app.post('/api/toggle_db', authRequired, (req, res) => {
        global.PRIMARY_DB_IS_DOWN = !global.PRIMARY_DB_IS_DOWN;
        res.json({ isDown: global.PRIMARY_DB_IS_DOWN });
    });

    // Updated /api/session to use authRequired
    app.get('/api/session', authRequired, (req, res) => {
        // If authRequired passes, req.user contains the decoded JWT payload
        res.json({ user: req.user });
    });
}

let handler;
module.exports = async (req, res) => {
    // Only call setupRoutes()
    setupRoutes(); 
    
    // We run initDb() and setupRoutes() directly outside of serverless handler
    // to ensure they are available, though for Vercel, serverless-http calls
    // the setup routes function on every request.
    
    if (!handler) handler = serverless(app);
    return handler(req, res);
};

if (require.main === module) {
    (async () => {
        // initDb is implicitly called by logger/dbHandler. 
        // We only call setupRoutes now
        setupRoutes(); 
        const port = process.env.PORT || 3000;
        app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
    })();
}