-- ═══════════════════════════════════════════════════
-- Supabase Setup: RAG Chatbot
-- Führe diese Datei in der Supabase SQL-Konsole aus.
-- ═══════════════════════════════════════════════════

-- 1. pgvector Extension aktivieren
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Dokumente-Tabelle
-- HINWEIS: Nutzt OpenAI text-embedding-3-small mit 1536 Dimensionen
CREATE TABLE IF NOT EXISTS documents (
  id         BIGSERIAL PRIMARY KEY,
  content    TEXT        NOT NULL,
  metadata   JSONB       DEFAULT '{}',
  embedding  VECTOR(1536) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Index für schnelle Cosine-Similarity-Suche
CREATE INDEX IF NOT EXISTS documents_embedding_idx
  ON documents
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 4. Similarity-Search-Funktion
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding  VECTOR(1536),
  match_threshold  FLOAT   DEFAULT 0.65,
  match_count      INT     DEFAULT 6
)
RETURNS TABLE (
  id         BIGINT,
  content    TEXT,
  metadata   JSONB,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    d.id,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  WHERE 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 5. Row-Level-Security (optional, empfohlen)
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Service-Role hat vollen Zugriff (für den Worker)
CREATE POLICY "service_role_all" ON documents
  USING (true)
  WITH CHECK (true);

-- Anonyme Nutzer dürfen die Funktion aufrufen (für den Worker via anon key)
GRANT EXECUTE ON FUNCTION match_documents TO anon, authenticated;


