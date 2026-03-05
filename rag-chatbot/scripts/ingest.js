// scripts/ingest.js
// ─────────────────────────────────────────────────────────────────
// Liest Textdateien aus dem /docs-Ordner, teilt sie in Chunks auf,
// erstellt Embeddings via OpenAI und speichert sie in Supabase.
//
// Setup:
//   npm install @supabase/supabase-js openai dotenv
//   cp .env.example .env   →  .env befüllen
//   node scripts/ingest.js
// ─────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import cliProgress from 'cli-progress';

/* ── Konfiguration ─────────────────────────────────────── */
const CHUNK_SIZE = 500;   // Zeichen pro Chunk
const CHUNK_OVERLAP = 80;    // Überlappung zwischen Chunks
const EMBED_MODEL = 'text-embedding-3-small';
const DOCS_DIR = './docs';
const SUPPORTED_EXT = ['.txt', '.md'];

/* ── Clients ────────────────────────────────────────────── */
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ── Text-Chunking ──────────────────────────────────────── */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + size, text.length);
        const chunk = text.slice(start, end).trim();
        if (chunk.length > 20) chunks.push(chunk); // Sehr kurze Chunks überspringen
        start += size - overlap;
    }
    return chunks;
}

/* ── Embedding via OpenAI ───────────────────────────────── */
async function getEmbedding(text) {
    const response = await openai.embeddings.create({
        model: EMBED_MODEL,
        input: text.replace(/\n/g, ' '), // Zeilenumbrüche normalisieren
    });
    return response.data[0].embedding;
}

/* ── Einzelne Datei verarbeiten ─────────────────────────── */
async function ingestFile(filePath, extraMetadata = {}, progressBar) {
    const filename = path.basename(filePath);
    const text = fs.readFileSync(filePath, 'utf-8');
    const chunks = chunkText(text);

    console.log(`\n📄 ${filename} → ${chunks.length} Chunks`);

    // Progress Bar erstellen
    const bar = new cliProgress.SingleBar({
        format: '  Progress |{bar}| {percentage}% | {value}/{total} Chunks | ETA: {eta}s',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true
    }, cliProgress.Presets.shades_classic);

    bar.start(chunks.length, 0);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        try {
            const embedding = await getEmbedding(chunk);

            const { error } = await supabase.from('documents').insert({
                content: chunk,
                metadata: {
                    source: filename,
                    chunk_index: i,
                    total_chunks: chunks.length,
                    ...extraMetadata,
                },
                embedding,
            });

            if (error) {
                bar.stop();
                console.error(`\n❌ Supabase-Fehler: ${error.message}`);
                bar.start(chunks.length, i + 1);
            }

            bar.update(i + 1);

            // Rate-Limit vermeiden: kurz warten
            await new Promise(r => setTimeout(r, 200));

        } catch (err) {
            bar.stop();
            console.error(`\n❌ Fehler bei Chunk ${i}: ${err.message}`);
            bar.start(chunks.length, i + 1);
        }
    }

    bar.stop();
    console.log(`  ✅ ${filename} erfolgreich verarbeitet!\n`);
}

/* ── Hauptprogramm ──────────────────────────────────────── */
async function main() {
    // Prüfen ob /docs-Ordner existiert
    if (!fs.existsSync(DOCS_DIR)) {
        fs.mkdirSync(DOCS_DIR, { recursive: true });
        console.log(`📁 /docs-Ordner erstellt. Bitte Textdateien (.txt, .md) dort ablegen und erneut ausführen.`);
        process.exit(0);
    }

    const files = fs.readdirSync(DOCS_DIR)
        .filter(f => SUPPORTED_EXT.includes(path.extname(f).toLowerCase()));

    if (files.length === 0) {
        console.log(`⚠️  Keine Dateien (${SUPPORTED_EXT.join(', ')}) im /docs-Ordner gefunden.`);
        process.exit(0);
    }

    console.log(`🚀 Ingestion gestartet: ${files.length} Datei(en)`);
    console.log(`   Chunk-Größe: ${CHUNK_SIZE} Zeichen | Overlap: ${CHUNK_OVERLAP} Zeichen\n`);

    for (const file of files) {
        await ingestFile(path.join(DOCS_DIR, file), { category: 'knowledge-base' });
    }

    console.log('\n✅ Alle Dokumente erfolgreich in Supabase gespeichert!');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
