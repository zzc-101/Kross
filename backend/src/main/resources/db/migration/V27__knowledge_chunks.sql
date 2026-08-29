-- Chunks and embeddings live in Postgres. Requires a pgvector-enabled image.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  space_id text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  modality text NOT NULL CHECK (modality IN ('text', 'image')),
  source_key text,
  published boolean NOT NULL DEFAULT false,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_chunks_document ON knowledge_chunks (document_id);
CREATE INDEX knowledge_chunks_space_published ON knowledge_chunks (space_id, published);
