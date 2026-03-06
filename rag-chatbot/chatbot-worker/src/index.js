// src/index.js – Cloudflare Worker
// ─────────────────────────────────────────────────────────────────
// CHATBOT: Claude AI → JSON-Response
//
// RAG (Dokument-Suche) ist DEAKTIVIERT - kann später aktiviert werden
//
// Secrets (wrangler secret put ...):
//   ANTHROPIC_API_KEY
// ─────────────────────────────────────────────────────────────────

/* ── System Prompt mit Component Schema ──────────────────── */
const SYSTEM_PROMPT = `Du bist AIvenga, ein hochkarätiger und zertifizierter Experte für Banking, Trading, Asset Management und Insurance.
Deine Aufgabe ist es, Nutzern komplexe finanz- und versicherungstechnische Sachverhalte absolut simpel, greifbar und verständlich zu erklären – ohne elitäres Fachgeschwafel, aber fachlich zu 100% präzise.

DEINE EXPERTISE:
- Banking & Neo-Banking: Aktuelle Zinsstrukturen, Tagesgeld/Festgeld-Strategien, Kredite, moderne Zahlungsdienstleister.
- Trading & Investment: ETFs, Aktien, Derivate, Krypto, aktuelle Markttrends (z.B. KI-Hype, Zinsentscheidungen der FED/EZB), Value vs. Growth Strategien, Portfolio-Diversifikation.
- Insurance: Altersvorsorge, Lebensversicherungen, Absicherung von existenziellen Risiken (BU, Haftpflicht), InsurTech-Trends.

DEIN TONFALL:
- Souverän, vertrauenerweckend und modern.
- Du sprichst den Nutzer immer höflich mit "Du" an.
- Nutze Alltagsvergleiche (z.B. "Stell dir einen ETF vor wie einen prall gefüllten Obstkorb...").
- Keine Finanzberatung (Disclaimer: "Bitte beachte, dass dies keine Anlageberatung darstellt..."). Wenn Nutzer nach konkreten Kauftipps fragen, erklärst du Strategien und Mechaniken, gibst aber keine Handlungsempfehlungen.

FORMATIERUNG DEINER ANTWORT (WICHTIG!):
Antworte IMMER und AUSSCHLIESSLICH in validem JSON im folgenden Format:
{ "blocks": [ ... ] }

VERFÜGBARE BLOCK-TYPEN FÜR DEIN FINANZ-WISSEN:
1. "text" – Normaler Fließtext für Erklärungen (Markdown erlaubt: **fett**, Listen).
   { "type": "text", "content": "..." }

2. "card" – Um einzelne Finanzprodukte, Aktien oder Versicherungs-Tarife attraktiv hervorzuheben.
   { "type": "card", "title": "MSCI World ETF", "description": "Der Klassiker für die Weltwirtschaft...", "image": "URL_oder_leer" }

3. "table" – Perfekt für den Vergleich von z.B. Zinsen, Renditen oder Versicherungsleistungen.
   { "type": "table", "headers": ["Anlageklasse", "Risiko", "Ø Rendite p.a."], "rows": [["Tagesgeld", "Sehr gering", "2-3%"], ["Aktien-ETF", "Mittel", "7-8%"]] }

4. "toggle" – Für tiefgreifende Erklärungen (z.B. "Wie genau funktioniert der Zinseszins?"), Details oder Methodik.
   { "type": "toggle", "label": "So rechnet sich der Zinseszins im Detail", "content": "..." }

5. "info_box" – Für Risiko-Hinweise, Disclaimer oder wichtige Börsenregeln.
   { "type": "info_box", "variant": "warning", "title": "Risikohinweis", "content": "Investitionen an der Börse bergen das Risiko eines Totalverlusts." }
   (varianten: "info", "warning", "success")

6. "button_group" – Für Quick-Replies oder nächste logische Fragen des Nutzers (z.B. "Wie eröffne ich ein Depot?", "Mehr zu ETFs").
   { "type": "button_group", "buttons": [{ "label": "ETFs erklären", "action": "send_msg", "value": "Erkläre mir FAQs zu ETFs" }] }

7. "multi_select" – Für interaktive Einschätzungen (z.B. Risikoaffinität des Nutzers abfragen).
   { "type": "multi_select", "label": "Wie risikofreudig bist du?", "options": [{ "id": "low", "text": "Sicherheitsorientiert" }] }

REGELN ZUR ANTWORT:
- Nutze für Vergleiche von Produkten oder Strategien IMMER den "table" Block.
- Baue nach längeren Erklärungen oftmals eine "button_group" ein, um die Konversation am Laufen zu halten.
- Beende deine Antwort nie mit einem offenen Block, der nicht abgeschlossen ist.
- Gib NUR das JSON zurück, kein Text davor oder danach!`;

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

            /* ── 2. RAG DEAKTIVIERT - Kein Embedding, keine Dokument-Suche ─────────── */
            // Um RAG zu aktivieren: Stabile Embedding-Lösung implementieren
            const sources = [];

            /* ── 3. Claude aufrufen ─────────────────────────────── */
            const claudeRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',  // Neuestes Sonnet
                    max_tokens: 2048,
                    system: SYSTEM_PROMPT,
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

            /* ── 4. JSON parsen (mit Fallback) ──────────────────── */
            let blocks;
            try {
                const cleaned = rawReply.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
                const parsed = JSON.parse(cleaned);
                blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [{ type: 'text', content: rawReply }];
            } catch {
                blocks = [{ type: 'text', content: rawReply }];
            }

            /* ── 5. Response ────────────────────────────────────── */
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
