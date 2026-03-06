-- ═══════════════════════════════════════════════════
-- Migration: Von OpenAI zu Supabase Embeddings
-- ═══════════════════════════════════════════════════
-- Führe diese Datei aus, wenn du bereits eine Datenbank
-- mit 1536-dimensionalen Vektoren (OpenAI) hast.
-- ═══════════════════════════════════════════════════

-- WARNUNG: Löscht alle bestehenden Embeddings!
-- Du musst danach deine Dokumente neu ingestieren.

-- 1. Tabelle löschen und neu erstellen mit korrekter Dimension
DROP TABLE IF EXISTS documents CASCADE;

CREATE TABLE documents (
  id         BIGSERIAL PRIMARY KEY,
  content    TEXT        NOT NULL,
  metadata   JSONB       DEFAULT '{}',
  embedding  VECTOR(384) NOT NULL,  -- Supabase gte-small
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Index erstellen
CREATE INDEX documents_embedding_idx
  ON documents
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 3. Match-Funktion updaten
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding  VECTOR(384),
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

-- 4. Embedding-Funktion erstellen
CREATE OR REPLACE FUNCTION embed_text(input TEXT)
RETURNS VECTOR(384)
LANGUAGE plpgsql
AS $$
DECLARE
  embedding_result VECTOR(384);
BEGIN
  SELECT vec INTO embedding_result
  FROM ai.gte_small_embed(input);

  RETURN embedding_result;
END;
$$;

-- 5. Row-Level-Security
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON documents
  USING (true)
  WITH CHECK (true);

-- 6. Permissions
GRANT EXECUTE ON FUNCTION match_documents TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION embed_text TO anon, authenticated, service_role;
