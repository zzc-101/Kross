-- Optional knowledge catalog. Search chunks live in the knowledge service, not Postgres.

ALTER TABLE platform_settings
  ADD COLUMN knowledge_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE knowledge_spaces (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('platform', 'organization')),
  organization_id text,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'platform' AND organization_id IS NULL)
    OR (kind = 'organization' AND organization_id IS NOT NULL)
  )
);

INSERT INTO knowledge_spaces (id, kind, name)
VALUES ('platform', 'platform', '平台知识库');

CREATE TABLE knowledge_documents (
  id text PRIMARY KEY,
  space_id text NOT NULL REFERENCES knowledge_spaces (id),
  title text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'processing', 'published', 'failed')),
  source_key text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  error_message text
);

CREATE INDEX knowledge_documents_space_created
  ON knowledge_documents (space_id, created_at DESC);

CREATE TABLE knowledge_jobs (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES knowledge_documents (id),
  kind text NOT NULL CHECK (kind IN ('ingest', 'publish')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_jobs_document ON knowledge_jobs (document_id, created_at DESC);
