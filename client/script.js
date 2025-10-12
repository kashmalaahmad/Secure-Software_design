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
        options.credentials = 'include';
        const res = await fetch(API_URL + endpoint, options);

        if (!res.ok) {
            // Attempt to read JSON body for an error message
            const text = await res.text();
            let errorMessage = `Server error: ${res.status} ${res.statusText}`;

            try {
                // If the response is JSON, use the message field
                errorMessage = JSON.parse(text).message || JSON.parse(text).error || errorMessage;
            } catch (e) {
                // If it's not JSON (like an empty body for a 405), use the status text
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

const updateUI = async () => {
    try {
        const data = await api.request('/session');
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
    const notes = await api.request('/notes');
    notesList.innerHTML = '';
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
};

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    try {
        await api.request('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
         console.log('Login successful! Updating UI...'); 
        await updateUI();
    } catch (error) {
        document.getElementById('login-error').textContent = error.message;
    }
});

logoutButton.addEventListener('click', async () => {
    await api.request('/logout');
    await updateUI();
});

noteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = document.getElementById('note-content').value;
    await api.request('/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
    });
    document.getElementById('note-content').value = '';
    await renderNotes();
});

notesList.addEventListener('click', async (e) => {
    if (e.target.classList.contains('delete-button')) {
        const noteId = e.target.dataset.id;
        await api.request(`/notes/${noteId}`, { method: 'DELETE' });
        await renderNotes();
    }
});

dbFailToggle.addEventListener('change', async () => {
    const { isDown } = await api.request('/toggle_db', { method: 'POST' });
    alert(`Primary database is now ${isDown ? 'OFFLINE' : 'ONLINE'}.`);
});

viewAuditLink.addEventListener('click', async () => {
    const logs = await api.request('/audit');
    auditLogContent.textContent = logs.map(log =>
        `[${new Date(log.timestamp).toLocaleString()}] ${log.username}(${log.role}): ${log.action}`
    ).join('\n');
    showView('audit-view');
});

backToNotesButton.addEventListener('click', () => showView('notes-view'));

updateUI();