// js/app.js
// ─────────────────────────────────────────────────────────────────
// Haupt-Chat-Logik: API-Anbindung, History, UI-State.
// Konfiguration: WORKER_URL anpassen nach Cloudflare-Deployment.
// ─────────────────────────────────────────────────────────────────

'use strict';

/* ══════════════════════════════════
   KONFIGURATION – bitte anpassen!
══════════════════════════════════ */
const WORKER_URL = 'https://chatbot-worker.avenga-labs.workers.dev';
const MAX_HISTORY = 20; // Letzte N Nachrichten im Kontext

/* ══════════════════════════════════
   State
══════════════════════════════════ */
let conversationHistory = [];
let isLoading = false;
let currentSessionId = null; // Eindeutige ID für aktuelle Chat-Session
/* ══════════════════════════════════
   DOM References
══════════════════════════════════ */
const messagesEl = document.getElementById('chat-messages');
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const clearBtn = document.getElementById('clear-btn');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const chatHistory = document.getElementById('chat-history');

/* ══════════════════════════════════
   Initialisierung
══════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    loadChatHistory();
    setupTextareaAutoResize();
    setupGlobalErrorHandler();
    setupWelcomeSendButton();
    updateHeaderBadge();
});

/* ══════════════════════════════════
   Events
══════════════════════════════════ */
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || isLoading) return;
    await sendMessage(message);
});

// Shift+Enter = neue Zeile | Enter = senden
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.dispatchEvent(new Event('submit', { bubbles: true }));
    }
});

newChatBtn?.addEventListener('click', startNewChat);
clearBtn?.addEventListener('click', startNewChat);
sidebarToggle?.addEventListener('click', () => sidebar?.classList.toggle('open'));

/* ══════════════════════════════════
   Core: Nachricht senden
══════════════════════════════════ */
async function sendMessage(message) {
    setLoading(true);

    // Willkommens-Screen ausblenden & Input-Area einblenden
    const welcomeScreen = document.querySelector('.welcome-screen');
    const inputArea = document.getElementById('input-area');

    if (welcomeScreen) {
        welcomeScreen.remove();

        // Chat Messages List Container erstellen
        const messagesList = document.createElement('div');
        messagesList.classList.add('chat-messages-list');
        messagesEl.appendChild(messagesList);

        // Input-Area einblenden
        if (inputArea) {
            inputArea.classList.remove('hidden');
        }
    }

    // User-Bubble
    appendMessage('user', [{ type: 'text', content: message }]);

    // Input leeren (entweder Welcome-Input oder Bottom-Input)
    const activeInput = document.getElementById('chat-input');
    if (activeInput) {
        activeInput.value = '';
        activeInput.style.height = 'auto';
    }

    // Typing-Indikator
    const loaderEl = appendLoader();

    try {
        const response = await fetch(WORKER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, history: conversationHistory }),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`HTTP ${response.status}: ${err}`);
        }

        const data = await response.json();
        loaderEl.remove();

        const blocks = data.blocks || [{ type: 'text', content: 'Keine Antwort erhalten.' }];
        appendMessage('assistant', blocks);

        // History aktualisieren
        conversationHistory.push(
            { role: 'user', content: message },
            { role: 'assistant', content: JSON.stringify({ blocks }) }
        );
        if (conversationHistory.length > MAX_HISTORY) {
            conversationHistory = conversationHistory.slice(-MAX_HISTORY);
        }

        saveChatHistory();
        updateHeaderBadge();

    } catch (err) {
        loaderEl.remove();
        console.error('Fetch error:', err);
        appendMessage('assistant', [{
            type: 'info_box',
            variant: 'warning',
            title: 'Verbindungsfehler',
            content: `Konnte den Worker nicht erreichen. Überprüfe die WORKER_URL in app.js und stelle sicher, dass der Cloudflare Worker deployed ist. (${err.message})`
        }]);
    }

    setLoading(false);
}

/* ══════════════════════════════════
   UI: Nachrichten hinzufügen
══════════════════════════════════ */
function appendMessage(role, blocks) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('message-wrapper', role);

    const avatar = document.createElement('div');
    avatar.classList.add('avatar');
    avatar.textContent = role === 'user' ? '👤' : '✦';

    const bubble = document.createElement('div');
    bubble.classList.add('message-bubble', role);
    bubble.innerHTML = renderBlocks(blocks);

    if (role === 'user') {
        wrapper.append(bubble, avatar);
    } else {
        wrapper.append(avatar, bubble);
    }

    // Append to chat-messages-list if exists, otherwise to messagesEl
    const messagesList = document.querySelector('.chat-messages-list');
    const container = messagesList || messagesEl;
    container.appendChild(wrapper);

    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    return wrapper;
}

function appendLoader() {
    const wrapper = document.createElement('div');
    wrapper.classList.add('message-wrapper', 'assistant');

    const avatar = document.createElement('div');
    avatar.classList.add('avatar');
    avatar.textContent = '✦';

    const bubble = document.createElement('div');
    bubble.classList.add('message-bubble', 'assistant', 'loading');
    bubble.innerHTML = `
    <div class="typing-indicator">
      <span></span><span></span><span></span>
    </div>`;

    wrapper.append(avatar, bubble);

    // Append to chat-messages-list if exists, otherwise to messagesEl
    const messagesList = document.querySelector('.chat-messages-list');
    const container = messagesList || messagesEl;
    container.appendChild(wrapper);

    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    return wrapper;
}

/* ══════════════════════════════════
   UI: State Management
══════════════════════════════════ */
function setLoading(state) {
    isLoading = state;
    input.disabled = state;
    sendBtn.disabled = state;
    sendBtn.classList.toggle('loading', state);
    if (!state) input.focus();
}

function startNewChat() {
    conversationHistory = [];
    currentSessionId = null; // Neue Session-ID generieren

    // Input-Area verstecken
    const inputArea = document.getElementById('input-area');
    if (inputArea) {
        inputArea.classList.add('hidden');
    }

    messagesEl.innerHTML = `
    <div class="welcome-screen">
      <div class="welcome-headline">
        <div class="welcome-icon" aria-hidden="true">✦</div>
        <h2>Guten Tag, Jon Doe</h2>
      </div>
      <div class="chat-input-container">
        <div class="chat-input-wrapper">
          <textarea placeholder="Wie kann ich dir heute helfen?" rows="1"></textarea>
          <div class="input-actions">
            <button class="attach-btn" aria-label="Anhang hinzufügen">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <rect x="6" y="0" width="1.3" height="13" rx="0.65" fill="#d9d9d9"/>
                <rect x="0" y="7" width="1.3" height="13" rx="0.65" transform="rotate(-90 0 7)" fill="#d9d9d9"/>
              </svg>
            </button>
            <button id="welcome-send-btn" aria-label="Nachricht senden">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </div>
        </div>
        <div class="suggestion-chips" role="group" aria-label="Vorschläge">
          <button class="chip" onclick="sendSuggestion(this)">Ruf mein Depot auf</button>
          <button class="chip" onclick="sendSuggestion(this)">Was sind aktuelle News</button>
          <button class="chip" onclick="sendSuggestion(this)">Zeig mir alle Optionen an</button>
          <button class="chip" onclick="sendSuggestion(this)">Password zurücksetzen</button>
        </div>
      </div>
    </div>`;

    // Re-attach event listener for welcome send button
    setupWelcomeSendButton();
    updateHeaderBadge();
}

/* ══════════════════════════════════
   Suggestion-Chips
══════════════════════════════════ */
function sendSuggestion(btn) {
    input.value = btn.textContent;
    form.dispatchEvent(new Event('submit', { bubbles: true }));
}

/* ══════════════════════════════════
   Textarea: Auto-Resize
══════════════════════════════════ */
function setupTextareaAutoResize() {
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });
}

/* ══════════════════════════════════
   LocalStorage: Chat-History
══════════════════════════════════ */
function saveChatHistory() {
    try {
        // Keine Session-ID? Neue erstellen
        if (!currentSessionId) {
            currentSessionId = Date.now();
        }

        // Titel aus erster User-Nachricht generieren
        const userMessages = conversationHistory.filter(msg => msg.role === 'user');
        const title = userMessages[0]?.content?.slice(0, 40) || 'Neuer Chat';

        // Bestehende Sessions laden
        const entries = JSON.parse(localStorage.getItem('chatSessions') || '[]');

        // Prüfen ob Session bereits existiert (Update) oder neu ist (Insert)
        const existingIndex = entries.findIndex(e => e.id === currentSessionId);

        const sessionData = {
            id: currentSessionId,
            title,
            ts: Date.now()
        };

        if (existingIndex >= 0) {
            // Existierende Session updaten
            entries[existingIndex] = sessionData;
        } else {
            // Neue Session hinzufügen
            entries.unshift(sessionData);
        }

        // Nur die letzten 20 behalten
        localStorage.setItem('chatSessions', JSON.stringify(entries.slice(0, 20)));
        loadChatHistory();
    } catch { /* ignore */ }
}

function loadChatHistory() {
    if (!chatHistory) return;
    try {
        const entries = JSON.parse(localStorage.getItem('chatSessions') || '[]');
        chatHistory.innerHTML = entries.map(e =>
            `<div class="history-item" title="${escHtml(e.title)}">💬 ${escHtml(e.title)}</div>`
        ).join('') || '<div class="history-empty">Noch kein Verlauf</div>';
    } catch { /* ignore */ }
}

/* ══════════════════════════════════
   Error Boundary
══════════════════════════════════ */
function setupGlobalErrorHandler() {
    // Globale JavaScript-Fehler abfangen
    window.addEventListener('error', (event) => {
        console.error('Global error:', event.error);
        showErrorBoundary('Ein unerwarteter Fehler ist aufgetreten. Bitte lade die Seite neu.');
        return true; // Verhindert Default-Fehlerausgabe
    });

    // Unhandled Promise Rejections abfangen
    window.addEventListener('unhandledrejection', (event) => {
        console.error('Unhandled rejection:', event.reason);
        showErrorBoundary('Ein Verbindungsfehler ist aufgetreten. Bitte überprüfe deine Internetverbindung.');
        event.preventDefault();
    });
}

function showErrorBoundary(message) {
    const existingBoundary = document.getElementById('error-boundary');
    if (existingBoundary) return; // Nur einmal anzeigen

    const boundary = document.createElement('div');
    boundary.id = 'error-boundary';
    boundary.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: linear-gradient(135deg, #dc2626, #b91c1c);
        color: white;
        padding: 16px 24px;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        z-index: 9999;
        max-width: 500px;
        display: flex;
        align-items: center;
        gap: 12px;
        animation: slideDown 0.3s ease;
    `;
    boundary.innerHTML = `
        <span style="font-size: 1.2rem;">⚠️</span>
        <div style="flex: 1;">
            <strong style="display: block; margin-bottom: 4px;">Fehler</strong>
            <p style="margin: 0; font-size: 0.9rem; opacity: 0.9;">${escHtml(message)}</p>
        </div>
        <button onclick="this.parentElement.remove()" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            width: 28px;
            height: 28px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 1.1rem;
        ">×</button>
    `;

    // Animation hinzufügen
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideDown {
            from { opacity: 0; transform: translate(-50%, -20px); }
            to { opacity: 1; transform: translate(-50%, 0); }
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(boundary);

    // Auto-Remove nach 8 Sekunden
    setTimeout(() => boundary.remove(), 8000);
}

/* ══════════════════════════════════
   Welcome Screen Functions
══════════════════════════════════ */
function setupWelcomeSendButton() {
    const welcomeSendBtn = document.getElementById('welcome-send-btn');
    const welcomeTextarea = document.querySelector('.welcome-screen textarea');

    if (welcomeSendBtn && welcomeTextarea) {
        welcomeSendBtn.addEventListener('click', async () => {
            const message = welcomeTextarea.value.trim();
            if (message && !isLoading) {
                await sendMessage(message);
            }
        });

        welcomeTextarea.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const message = welcomeTextarea.value.trim();
                if (message && !isLoading) {
                    await sendMessage(message);
                }
            }
        });
    }
}

function updateHeaderBadge() {
    const badge = document.querySelector('.model-badge');
    const hasMessages = conversationHistory.length > 0;

    if (badge) {
        badge.textContent = hasMessages ? 'New Chat' : 'Today';
    }
}

/* ══════════════════════════════════
   Hilfsfunktionen
══════════════════════════════════ */
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
