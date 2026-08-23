-- Promote model profiles and their credentials from organization-owned records
-- to platform-owned records. Existing UUID primary keys remain globally unique.

ALTER TABLE agent_conversations
  DROP CONSTRAINT IF EXISTS agent_conversations_model_fk;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class source_table ON source_table.oid = c.conrelid
    JOIN pg_class target_table ON target_table.oid = c.confrelid
    WHERE source_table.relname = 'model_profiles'
      AND target_table.relname = 'credential_handles'
  LOOP
    EXECUTE format('ALTER TABLE model_profiles DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE model_profiles
  DROP CONSTRAINT IF EXISTS model_profiles_organization_id_id_key;

ALTER TABLE credential_handles
  DROP CONSTRAINT IF EXISTS credential_handles_organization_id_id_key,
  DROP CONSTRAINT IF EXISTS credential_handles_organization_id_handle_key;

DROP INDEX IF EXISTS model_profiles_tenant_created;
DROP INDEX IF EXISTS credential_handles_tenant_created;

ALTER TABLE model_profiles DROP COLUMN organization_id;
ALTER TABLE credential_handles DROP COLUMN organization_id;

ALTER TABLE credential_handles
  ADD CONSTRAINT credential_handles_handle_key UNIQUE (handle);

ALTER TABLE model_profiles
  ADD CONSTRAINT model_profiles_credential_handle_fk
  FOREIGN KEY (credential_handle_id)
  REFERENCES credential_handles(id)
  ON DELETE RESTRICT;

ALTER TABLE agent_conversations
  ADD CONSTRAINT agent_conversations_model_fk
  FOREIGN KEY (model_id)
  REFERENCES model_profiles(id)
  ON DELETE SET NULL;

CREATE INDEX credential_handles_platform_created
  ON credential_handles (created_at DESC, id DESC);
CREATE INDEX model_profiles_platform_created
  ON model_profiles (created_at DESC, id DESC);

-- Persist content-free usage reported by the Worker for every assistant turn.
ALTER TABLE agent_messages
  ADD COLUMN usage jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN context_usage jsonb NOT NULL DEFAULT '{}';

CREATE INDEX agent_messages_usage_created
  ON agent_messages (created_at DESC)
  WHERE role = 'agent' AND usage <> '{}'::jsonb;
