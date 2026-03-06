// src/index.js – Cloudflare Worker
// ─────────────────────────────────────────────────────────────────
// RAG-Proxy: Embedding → Supabase Vektor-Suche → Claude → JSON-Response
//
// Secrets (wrangler secret put ...):
//   ANTHROPIC_API_KEY
//   SUPABASE_SERVICE_KEY
//   HUGGINGFACE_API_KEY (optional aber empfohlen für bessere Rate Limits)
//
// Vars (wrangler.toml):
//   SUPABASE_URL
// ─────────────────────────────────────────────────────────────────

/* ── System Prompt mit Component Schema ──────────────────── */
const SYSTEM_PROMPT = `Du bist ein intelligenter Assistent. Beantworte Fragen ausschließlich auf Basis des bereitgestellten KONTEXTS.
Wenn der Kontext keine passenden Informationen enthält, sage das ehrlich.
Antworte IMMER in validem JSON im folgenden Format:

{ "blocks": [ ... ] }

VERFÜGBARE BLOCK-TYPEN:

1. "text" – Normaler Fließtext (Markdown erlaubt: **fett**, *kursiv*, Listen, Code)
   { "type": "text", "content": "..." }

2. "card" – Einzelne Entität (Produkt, Person, Konzept)
   { "type": "card", "title": "...", "description": "...", "image": "url_oder_weglassen", "link": "url_oder_weglassen" }

3. "image_gallery" – Wenn Bilder gezeigt werden sollen
   { "type": "image_gallery", "images": [{ "src": "url", "alt": "Beschreibung" }] }

4. "table" – Für Vergleiche, strukturierte Daten, Listen mit mehreren Attributen
   { "type": "table", "headers": ["Spalte1", "Spalte2"], "rows": [["Wert1", "Wert2"]] }

5. "multi_select" – Wenn der User zwischen Optionen wählen soll
   { "type": "multi_select", "label": "Wähle eine oder mehrere Optionen:", "options": [{ "id": "opt1", "text": "Option 1" }] }

6. "toggle" – Für ausklappbare Zusatzinfos, Details, lange Erklärungen
   { "type": "toggle", "label": "Mehr Details", "content": "..." }

7. "button_group" – Für Aktionen, Weiterführung, Quick-Replies
   { "type": "button_group", "buttons": [{ "label": "Aktion", "action": "action_name", "value": "wert" }] }

8. "info_box" – Für wichtige Hinweise, Warnungen, Erfolgsmeldungen
   { "type": "info_box", "variant": "info", "title": "Hinweis", "content": "..." }
   (variant: "info" | "warning" | "success")

ENTSCHEIDUNGSREGELN:
- Einfache Fragen → "text"
- Vergleiche / Daten → "table"  
- Einzelne Entität vorstellen → "card"
- User soll wählen → "multi_select"
- Lange Details → "toggle"
- Nächste Schritte / Aktionen → "button_group"
- Wichtige Hinweise → "info_box"
- Kombiniere Blöcke frei: z.B. text + table + button_group
- Antworte auf Deutsch (es sei denn, der User schreibt auf einer anderen Sprache)
- Gib NUR das JSON zurück, kein Text davor oder danach`;

/* ── Hilfsfunktion: Cloudflare fetch mit Timeout ─────────── */
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(id);
    }
}

/* ── CORS Headers ─────────────────────────────────────────── */
function corsHeaders(origin) {
    // In Produktion: spezifische GitHub Pages URL eintragen
    const allowed = [
        'https://avenga-labs.github.io',
    ];

    // Lokale Entwicklung: alle localhost/127.0.0.1 Ports erlauben
    const isLocalhost = origin && (
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.startsWith('http://[::1]:')
    );

    const allowedOrigin = allowed.includes(origin) || isLocalhost ? origin : allowed[0];

    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

/* ── Haupt-Handler ────────────────────────────────────────── */
export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const cors = corsHeaders(origin);

        // Preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }

        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405, headers: cors });
        }

        try {
            /* ── 1. Request parsen ─────────────────────────────── */
            const { message, history = [] } = await request.json();
            if (!message?.trim()) {
                return jsonError('Leere Nachricht.', 400, cors);
            }

            /* ── 2. Embedding der User-Frage (via Hugging Face - kostenlos) ───────── */
            const hfHeaders = {
                'Content-Type': 'application/json',
            };

            // API Key hinzufügen falls vorhanden (empfohlen für bessere Rate Limits)
            if (env.HUGGINGFACE_API_KEY) {
                hfHeaders['Authorization'] = `Bearer ${env.HUGGINGFACE_API_KEY}`;
            }

            const embRes = await fetchWithTimeout(
                'https://router.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2',
                {
                    method: 'POST',
                    headers: hfHeaders,
                    body: JSON.stringify({ inputs: message }),
                }
            );

            if (!embRes.ok) {
                const err = await embRes.text();
                throw new Error(`Embedding API error: ${err}`);
            }
            const embData = await embRes.json();
            // Hugging Face gibt direkt einen Array zurück
            const queryEmbedding = Array.isArray(embData) ? embData : embData[0];

            /* ── 3. Supabase: Ähnliche Dokumente finden ────────── */
            const matchRes = await fetchWithTimeout(
                `${env.SUPABASE_URL}/rest/v1/rpc/match_documents`,
                {
                    method: 'POST',
                    headers: {
                        'apikey': env.SUPABASE_SERVICE_KEY,
                        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        query_embedding: queryEmbedding,
                        match_threshold: 0.65,
                        match_count: 6,
                    }),
                }
            );

            const docs = matchRes.ok ? await matchRes.json() : [];
            const context = docs.map(d => d.content).join('\n\n---\n\n');
            const sources = docs.map(d => d.metadata);

            /* ── 4. Claude aufrufen ─────────────────────────────── */
            const claudeRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',  // Kosteneffizient: ~$3/M Tokens (vs. Opus ~$15/M)
                    max_tokens: 2048,
                    system: `${SYSTEM_PROMPT}\n\n${context ? `KONTEXT:\n${context}` : 'Kein spezifischer Kontext gefunden.'}`,
                    messages: [
                        ...history.slice(-14), // Letzte 7 Runden
                        { role: 'user', content: message },
                    ],
                }),
            });

            if (!claudeRes.ok) {
                const err = await claudeRes.text();
                throw new Error(`Claude API error: ${err}`);
            }
            const claudeData = await claudeRes.json();
            const rawReply = claudeData.content?.[0]?.text ?? '';

            /* ── 5. JSON parsen (mit Fallback) ──────────────────── */
            let blocks;
            try {
                const cleaned = rawReply.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
                const parsed = JSON.parse(cleaned);
                blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [{ type: 'text', content: rawReply }];
            } catch {
                blocks = [{ type: 'text', content: rawReply }];
            }

            /* ── 6. Response ────────────────────────────────────── */
            return new Response(
                JSON.stringify({ blocks, sources }),
                { headers: { ...cors, 'Content-Type': 'application/json' } }
            );

        } catch (err) {
            console.error('Worker error:', err);
            return jsonError(err.message, 500, cors);
        }
    },
};

function jsonError(msg, status, cors) {
    return new Response(
        JSON.stringify({
            blocks: [{
                type: 'info_box',
                variant: 'warning',
                title: 'Fehler',
                content: msg,
            }],
        }),
        { status, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
}
