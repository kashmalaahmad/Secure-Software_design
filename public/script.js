const API_URL = '/api';

const loginView = document.getElementById('login-view');
const notesView = document.getElementById('notes-view');
const auditView = document.getElementById('audit-view');
const loginForm = document.getElementById('login-form');
const noteForm = document.getElementById('note-form');
const userInfo = document.getElementById('user-info');
const logoutButton = document.getElementById('logout-button');
const dbFailToggle = document.getElementById('db-fail-toggle');
const notesList = document.getElementById('notes-list');
const viewAuditLink = document.getElementById('view-audit-link');
const backToNotesButton = document.getElementById('back-to-notes-button');
const auditLogContent = document.getElementById('audit-log-content');

let currentUser = null;

const api = {
    async request(endpoint, options = {}) {
        const token = localStorage.getItem('auth_token');
        
        if (token) {
            options.headers = {
                ...options.headers,
                'Authorization': `Bearer ${token}`
            };
        }
        
        const res = await fetch(API_URL + endpoint, options);

        if (!res.ok) {
            if (res.status === 401) {
                localStorage.removeItem('auth_token');
                currentUser = null;
                showView('login-view');
            }
            
            const text = await res.text();
            let errorMessage = `Error: ${res.status}`;
            try {
                const json = JSON.parse(text);
                errorMessage = json.message || json.error || errorMessage;
            } catch (e) {
                errorMessage = text || errorMessage;
            }
            throw new Error(errorMessage);
        }

        if (res.status !== 204) return res.json();
    }
};

const showView = (viewId) => {
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.getElementById(viewId).style.display = 'block';
};

const updateUI = async (userData = null) => { 
    try {
        let data;
        if (userData) {
            data = { user: userData }; 
        } else {
            data = await api.request('/session');
        }
        
        currentUser = data.user;
        userInfo.textContent = `${currentUser.username} (${currentUser.role})`;
        viewAuditLink.style.display = currentUser.role === 'admin' ? 'inline' : 'none';
        await renderNotes();
        showView('notes-view');
    } catch (e) {
        currentUser = null;
        showView('login-view');
    }
};

const renderNotes = async () => {
    try {
        const notes = await api.request('/notes');
        notesList.innerHTML = '';
        
        if (notes.length === 0) {
            notesList.innerHTML = '<p class="text-gray-500">No notes yet. Create your first note!</p>';
            return;
        }
        
        notes.forEach(note => {
            const noteEl = document.createElement('div');
            noteEl.className = 'note';
            noteEl.innerHTML = `
                <div>
                    <p>${note.content}</p>
                    <div class="note-meta">By: ${note.authorUsername} on ${new Date(note.timestamp).toLocaleDateString()}</div>
                </div>
                <button class="delete-button" data-id="${note.id}">Delete</button>
            `;
            notesList.appendChild(noteEl);
        });
    } catch (error) {
        console.error('Error loading notes:', error);
        notesList.innerHTML = '<p class="text-red-500">Failed to load notes</p>';
    }
};

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('login-error');
    
    try {
        errorDiv.textContent = 'Logging in...';
        const response = await api.request('/login', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        localStorage.setItem('auth_token', response.token);
        errorDiv.textContent = '';
        document.getElementById('username').value = '';
        document.getElementById('password').value = '';
        await updateUI(response.user); 
    } catch (error) {
        errorDiv.textContent = error.message;
    }
});

logoutButton.addEventListener('click', async () => {
    try {
        await api.request('/logout', { method: 'POST' });
    } catch (error) {
        console.error('Logout error:', error);
    }
    localStorage.removeItem('auth_token');
    await updateUI();
});

noteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = document.getElementById('note-content').value;
    try {
        await api.request('/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        document.getElementById('note-content').value = '';
        await renderNotes();
    } catch (error) {
        alert('Failed to create note: ' + error.message);
    }
});

notesList.addEventListener('click', async (e) => {
    if (e.target.classList.contains('delete-button')) {
        const noteId = e.target.dataset.id;
        try {
            await api.request(`/notes/${noteId}`, { method: 'DELETE' });
            await renderNotes();
        } catch (error) {
            alert('Failed to delete note: ' + error.message);
        }
    }
});

dbFailToggle.addEventListener('change', async () => {
    try {
        const { isDown } = await api.request('/toggle_db', { method: 'POST' });
        alert(`Primary database is now ${isDown ? 'OFFLINE' : 'ONLINE'}.`);
    } catch (error) {
        alert('Failed to toggle database');
    }
});

viewAuditLink.addEventListener('click', async () => {
    try {
        const logs = await api.request('/audit');
        auditLogContent.textContent = logs.map(log =>
            `[${new Date(log.timestamp).toLocaleString()}] ${log.username}(${log.role}): ${log.action}`
        ).join('\n');
        showView('audit-view');
    } catch (error) {
        alert('Failed to load audit logs');
    }
});

backToNotesButton.addEventListener('click', () => showView('notes-view'));

updateUI();