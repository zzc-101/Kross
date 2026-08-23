-- Durable per-user memories. Organization dataRetentionDays must not delete these rows.
CREATE TABLE agent_memories (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  agent_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('preference', 'fact')),
  source text NOT NULL CHECK (source IN ('manual', 'remember', 'extract')),
  content text NOT NULL,
  forgotten_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_memories_owner_active_idx
  ON agent_memories (organization_id, user_id, kind, updated_at DESC)
  WHERE forgotten_at IS NULL;

CREATE INDEX agent_memories_owner_forgotten_idx
  ON agent_memories (organization_id, user_id, forgotten_at DESC)
  WHERE forgotten_at IS NOT NULL;

ALTER TABLE agent_settings
  ADD COLUMN memory_extracted_at timestamptz;
