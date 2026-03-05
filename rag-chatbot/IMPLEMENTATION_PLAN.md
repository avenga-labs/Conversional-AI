# RAG-Chatbot mit Claude, Supabase & GitHub Pages

## Architektur

```
┌─────────────────────┐     ┌──────────────────────────────┐     ┌──────────────┐
│   GitHub Pages      │────▶│   Cloudflare Worker          │────▶│ Anthropic API│
│   (Frontend)        │◀────│   (Proxy + RAG + Schema)     │◀────│ (Claude)     │
│                     │     │                              │     └──────────────┘
│   Block-Renderer    │     │  1. Embedding der Frage      │
│   mappt JSON →      │     │  2. Supabase Vektor-Suche    │────▶┌──────────────┐
│   Rich Components   │     │  3. Kontext + Schema → Claude│◀────│ Supabase     │
└─────────────────────┘     │  4. JSON Response zurück     │     │ (pgvector)   │
                            └──────────────────────────────┘     └──────────────┘
```

**Flow**: User-Frage → Worker erstellt Embedding → Supabase findet relevante Docs → Worker baut Prompt (Kontext + Component Schema) → Claude antwortet als JSON mit Blöcken → Frontend rendert Blöcke als Rich UI.

---

## Teil 1: Supabase Setup

### 1.1 pgvector + Tabelle

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON documents
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

### 1.2 Similarity-Search-Funktion

```sql
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) AS similarity
  FROM documents
  WHERE 1 - (documents.embedding <=> query_embedding) > match_threshold
  ORDER BY (documents.embedding <=> query_embedding)
  LIMIT match_count;
$$;
```

### 1.3 Ingestion-Script (Node.js)

```javascript
// scripts/ingest.js
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fs from 'fs';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function chunkText(text, chunkSize = 500, overlap = 50) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, Math.min(start + chunkSize, text.length)));
    start += chunkSize - overlap;
  }
  return chunks;
}

async function getEmbedding(text) {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return res.data[0].embedding;
}

async function ingest(filePath, metadata = {}) {
  const chunks = chunkText(fs.readFileSync(filePath, 'utf-8'));
  for (const chunk of chunks) {
    const embedding = await getEmbedding(chunk);
    const { error } = await supabase.from('documents').insert({
      content: chunk, metadata: { ...metadata, source: filePath }, embedding,
    });
    if (error) console.error('Error:', error);
    else console.log(`✅ Chunk inserted (${chunk.length} chars)`);
  }
}

// Alle .txt/.md Dateien im /docs-Ordner einlesen
const files = fs.readdirSync('./docs').filter(f => /\.(txt|md)$/.test(f));
for (const file of files) await ingest(`./docs/${file}`, { category: 'knowledge-base' });
```

> [!NOTE]
> Für Embeddings wird ein **OpenAI API Key** benötigt (`text-embedding-3-small`). Claude bietet kein eigenes Embedding-Modell.

---

## Teil 2: Component Schema (UI-Blöcke)

Claude entscheidet pro Antwort, welche Darstellungsform am besten passt.

### 2.1 Verfügbare Block-Typen

| Typ | Zweck | Beispiel-Trigger |
|---|---|---|
| `text` | Fließtext (Markdown) | Einfache Fragen |
| `card` | Einzelne Entität | "Zeig mir Produkt X" |
| `image_gallery` | Bildergalerie | "Zeig Bilder von..." |
| `table` | Vergleiche, Daten | "Vergleiche A und B" |
| `multi_select` | User soll auswählen | "Welche Optionen habe ich?" |
| `toggle` | Ausklappbare Details | Lange Zusatzinfos |
| `button_group` | Aktionen / Quick-Replies | Nächste Schritte |
| `info_box` | Hinweise / Warnungen | Wichtige Infos |

### 2.2 Schema-Definition

```json
{
  "text":          { "content": "string (Markdown)" },
  "card":          { "title": "string", "description": "string", "image?": "url", "link?": "url" },
  "image_gallery": { "images": [{ "src": "url", "alt": "string" }] },
  "table":         { "headers": ["string"], "rows": [["string"]] },
  "multi_select":  { "label": "string", "options": [{ "id": "string", "text": "string" }] },
  "toggle":        { "label": "string", "content": "string (Markdown)" },
  "button_group":  { "buttons": [{ "label": "string", "action": "string", "value": "string" }] },
  "info_box":      { "variant": "info|warning|success", "title": "string", "content": "string" }
}
```

---

## Teil 3: Cloudflare Worker

### 3.1 Setup

```bash
npm create cloudflare@latest chatbot-worker -- --type=hello-world
cd chatbot-worker
```

`wrangler.toml`:
```toml
name = "chatbot-worker"
main = "src/index.js"

[vars]
SUPABASE_URL = "https://dein-projekt.supabase.co"
# wrangler secret put ANTHROPIC_API_KEY
# wrangler secret put SUPABASE_SERVICE_KEY
# wrangler secret put OPENAI_API_KEY
```

### 3.2 Worker-Code

```javascript
// src/index.js

const SYSTEM_PROMPT = `Du bist ein intelligenter Assistent. Antworte IMMER als JSON.
Wähle die Darstellung, die die Information am besten vermittelt.

FORMAT: { "blocks": [ ... ] }

VERFÜGBARE BLOCK-TYPEN:

1. "text" – Fließtext (Markdown erlaubt)
   { "type": "text", "content": "..." }

2. "card" – Einzelne Entität (Produkt, Person, Ort)
   { "type": "card", "title": "...", "description": "...", "image": "url", "link": "url" }

3. "image_gallery" – Bildergalerie
   { "type": "image_gallery", "images": [{ "src": "url", "alt": "..." }] }

4. "table" – Vergleiche, Datenlisten
   { "type": "table", "headers": [...], "rows": [[...]] }

5. "multi_select" – User soll auswählen
   { "type": "multi_select", "label": "...", "options": [{ "id": "...", "text": "..." }] }

6. "toggle" – Ausklappbare Details
   { "type": "toggle", "label": "...", "content": "..." }

7. "button_group" – Aktionen oder Quick-Replies
   { "type": "button_group", "buttons": [{ "label": "...", "action": "...", "value": "..." }] }

8. "info_box" – Hinweise/Warnungen
   { "type": "info_box", "variant": "info|warning|success", "title": "...", "content": "..." }

REGELN:
- NUR valides JSON zurückgeben, kein Text davor oder danach
- Kombiniere Blöcke frei (z.B. text + table + button_group)
- Einfache Antworten = "text"
- Vergleiche = "table"
- Wenn der Nutzer wählen soll = "multi_select"
- Antworte auf Deutsch, sofern nicht anders gewünscht`;

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://DEIN-USERNAME.github.io',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS')
      return new Response(null, { headers: corsHeaders });
    if (request.method !== 'POST')
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });

    try {
      const { message, history = [] } = await request.json();

      // 1. Embedding der User-Frage
      const embRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: message }),
      });
      const embData = await embRes.json();

      // 2. Relevante Dokumente aus Supabase
      const matchRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_documents`, {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query_embedding: embData.data[0].embedding,
          match_threshold: 0.7,
          match_count: 5,
        }),
      });
      const docs = await matchRes.json();
      const context = docs.map(d => d.content).join('\n\n---\n\n');

      // 3. Claude mit Kontext + Schema
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          system: `${SYSTEM_PROMPT}\n\nKONTEXT:\n${context}`,
          messages: [...history, { role: 'user', content: message }],
        }),
      });
      const claudeData = await claudeRes.json();
      const rawReply = claudeData.content[0].text;

      // 4. JSON parsen mit Fallback
      let blocks;
      try {
        const parsed = JSON.parse(rawReply);
        blocks = parsed.blocks || [{ type: 'text', content: rawReply }];
      } catch {
        blocks = [{ type: 'text', content: rawReply }];
      }

      return new Response(
        JSON.stringify({ blocks, sources: docs.map(d => d.metadata) }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  },
};
```

### 3.3 Deployen

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put OPENAI_API_KEY
wrangler deploy
```

---

## Teil 4: Frontend (GitHub Pages)

### 4.1 Projektstruktur

```
chatbot-frontend/
├── index.html
├── css/style.css
├── js/
│   ├── app.js          # Hauptlogik + API-Calls
│   └── renderer.js     # Block-Renderer (JSON → HTML)
└── assets/
```

### 4.2 HTML

```html
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mein Chatbot</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <div id="chat-container">
    <div id="chat-header"><h1>💬 Mein Chatbot</h1></div>
    <div id="chat-messages"></div>
    <form id="chat-form">
      <input type="text" id="chat-input" placeholder="Stelle eine Frage..." autocomplete="off" />
      <button type="submit" id="send-btn">Senden</button>
    </form>
  </div>
  <script src="js/renderer.js"></script>
  <script src="js/app.js"></script>
</body>
</html>
```

### 4.3 Block-Renderer

```javascript
// js/renderer.js
function renderBlocks(blocks) {
  return blocks.map(block => {
    switch (block.type) {
      case 'text':
        return `<div class="block-text">${marked.parse(block.content)}</div>`;

      case 'card':
        return `<div class="block-card">
          ${block.image ? `<img src="${block.image}" alt="${block.title}">` : ''}
          <h3>${block.title}</h3>
          <p>${block.description}</p>
          ${block.link ? `<a href="${block.link}" target="_blank">Mehr →</a>` : ''}
        </div>`;

      case 'image_gallery':
        return `<div class="block-gallery">
          ${block.images.map(img => `<img src="${img.src}" alt="${img.alt}">`).join('')}
        </div>`;

      case 'table':
        return `<div class="block-table-wrap"><table class="block-table">
          <thead><tr>${block.headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
          <tbody>${block.rows.map(row =>
            `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`
          ).join('')}</tbody>
        </table></div>`;

      case 'multi_select':
        return `<div class="block-multi-select">
          <p>${block.label}</p>
          <div class="options">${block.options.map(o =>
            `<label class="select-option">
              <input type="checkbox" value="${o.id}"> ${o.text}
            </label>`
          ).join('')}</div>
          <button class="select-confirm" onclick="submitSelection(this)">Bestätigen</button>
        </div>`;

      case 'toggle':
        return `<details class="block-toggle">
          <summary>${block.label}</summary>
          <div>${marked.parse(block.content)}</div>
        </details>`;

      case 'button_group':
        return `<div class="block-buttons">
          ${block.buttons.map(b =>
            `<button class="action-btn" onclick="handleAction('${b.action}','${b.value}')">${b.label}</button>`
          ).join('')}
        </div>`;

      case 'info_box':
        return `<div class="block-info ${block.variant}">
          <strong>${block.title}</strong><p>${block.content}</p>
        </div>`;

      default:
        return `<div class="block-text"><p>${JSON.stringify(block)}</p></div>`;
    }
  }).join('');
}

// Button/Selection Handlers
function handleAction(action, value) {
  // User-Aktion als neue Nachricht an den Bot senden
  const input = document.getElementById('chat-input');
  input.value = `[Aktion: ${action}] ${value}`;
  document.getElementById('chat-form').dispatchEvent(new Event('submit'));
}

function submitSelection(btn) {
  const container = btn.closest('.block-multi-select');
  const selected = [...container.querySelectorAll('input:checked')]
    .map(cb => cb.value);
  const input = document.getElementById('chat-input');
  input.value = `Meine Auswahl: ${selected.join(', ')}`;
  document.getElementById('chat-form').dispatchEvent(new Event('submit'));
}
```

### 4.4 App-Logik

```javascript
// js/app.js
const WORKER_URL = 'https://chatbot-worker.DEIN-ACCOUNT.workers.dev';
const messagesEl = document.getElementById('chat-messages');
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
let history = [];

function addMessage(role, content) {
  const msg = document.createElement('div');
  msg.classList.add('message', role);
  msg.innerHTML = typeof content === 'string' ? content : renderBlocks(content);
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  addMessage('user', `<p>${message}</p>`);
  input.value = '';
  input.disabled = true;

  const loader = document.createElement('div');
  loader.classList.add('message', 'assistant', 'loading');
  loader.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  messagesEl.appendChild(loader);

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
    });
    const data = await res.json();
    loader.remove();

    addMessage('assistant', data.blocks);

    history.push(
      { role: 'user', content: message },
      { role: 'assistant', content: JSON.stringify(data.blocks) }
    );
    if (history.length > 20) history = history.slice(-20);
  } catch {
    loader.remove();
    addMessage('assistant', [{ type: 'info_box', variant: 'warning', title: 'Fehler', content: 'Verbindung fehlgeschlagen. Bitte erneut versuchen.' }]);
  }

  input.disabled = false;
  input.focus();
});
```

### 4.5 Deployment

```bash
git init && git add . && git commit -m "Initial chatbot"
git remote add origin https://github.com/DEIN-USERNAME/chatbot.git
git push -u origin main
# GitHub: Settings → Pages → Source: main → Save
```

---

## Umsetzungsreihenfolge

| # | Schritt | Wo |
|---|---|---|
| 1 | Supabase: pgvector + Tabelle + Funktion | Supabase SQL Editor |
| 2 | Ingestion-Script: Dokumente einpflegen | Lokal (Node.js) |
| 3 | Cloudflare Worker deployen | Cloudflare |
| 4 | Frontend bauen + GitHub Pages deployen | GitHub |
| 5 | CORS-Origin im Worker anpassen | `wrangler.toml` |
| 6 | Testen, Design iterieren, Block-Typen erweitern | Browser |

## Kosten

| Service | Kosten |
|---|---|
| GitHub Pages | Kostenlos |
| Cloudflare Workers | Kostenlos (100k Req/Tag) |
| Supabase | Kostenlos (Free Tier: 500MB) |
| Claude API | ~$3/M Input, ~$15/M Output Tokens |
| OpenAI Embeddings | ~$0.02/M Tokens |
