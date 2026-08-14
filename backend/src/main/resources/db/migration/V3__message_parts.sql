-- Canonical message parts for the channel gateway. Adapters must not persist wire format.

ALTER TABLE agent_messages
  ADD COLUMN parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN reply_to text;

CREATE INDEX agent_messages_reply_to
  ON agent_messages (organization_id, reply_to)
  WHERE reply_to IS NOT NULL;
