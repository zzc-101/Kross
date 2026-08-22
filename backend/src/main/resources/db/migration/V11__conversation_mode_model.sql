-- Persist per-conversation agent mode and optional model override.

ALTER TABLE agent_conversations
  ADD COLUMN mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN model_id text;

ALTER TABLE agent_conversations
  ADD CONSTRAINT agent_conversations_mode_chk
  CHECK (mode IN ('auto', 'plan', 'conductor'));

ALTER TABLE agent_conversations
  ADD CONSTRAINT agent_conversations_model_fk
  FOREIGN KEY (organization_id, model_id)
  REFERENCES model_profiles (organization_id, id)
  ON DELETE SET NULL;
