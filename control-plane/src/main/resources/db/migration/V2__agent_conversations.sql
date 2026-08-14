-- Conversations are threads inside one persistent Agent workspace.

CREATE TABLE agent_conversations (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  agent_id text NOT NULL,
  title text NOT NULL,
  archived_at timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_conversations_sidebar
  ON agent_conversations (agent_id, archived_at, last_message_at DESC);

INSERT INTO agent_conversations (id, organization_id, agent_id, title)
SELECT 'conv-' || id, organization_id, id, '新对话' FROM agents;

ALTER TABLE agent_messages ADD COLUMN conversation_id text;

UPDATE agent_messages
SET conversation_id = 'conv-' || agent_id
WHERE conversation_id IS NULL;

ALTER TABLE agent_messages ALTER COLUMN conversation_id SET NOT NULL;

ALTER TABLE agent_messages
  ADD CONSTRAINT agent_messages_conversation_fk
  FOREIGN KEY (organization_id, conversation_id)
  REFERENCES agent_conversations(organization_id, id) ON DELETE CASCADE;

CREATE INDEX agent_messages_conversation_timeline
  ON agent_messages (conversation_id, created_at ASC, id ASC);
