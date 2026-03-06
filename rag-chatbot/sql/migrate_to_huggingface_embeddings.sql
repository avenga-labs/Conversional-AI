-- ═══════════════════════════════════════════════════
-- Migration: Zu Hugging Face Embeddings (kostenlos!)
-- ═══════════════════════════════════════════════════
-- Model: sentence-transformers/all-MiniLM-L6-v2
-- Dimensionen: 384
-- ═══════════════════════════════════════════════════

-- WARNUNG: Löscht alle bestehenden Embeddings!
-- Du musst danach deine Dokumente neu ingestieren.

-- 1. Tabelle löschen und neu erstellen
DROP TABLE IF EXISTS documents CASCADE;

CREATE TABLE documents (
  id         BIGSERIAL PRIMARY KEY,
  content    TEXT        NOT NULL,
  metadata   JSONB       DEFAULT '{}',
  embedding  VECTOR(384) NOT NULL,  -- all-MiniLM-L6-v2
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Index erstellen
CREATE INDEX documents_embedding_idx
  ON documents
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 3. Match-Funktion
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

-- 4. Row-Level-Security
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON documents
  USING (true)
  WITH CHECK (true);

-- 5. Permissions
GRANT EXECUTE ON FUNCTION match_documents TO anon, authenticated, service_role;
