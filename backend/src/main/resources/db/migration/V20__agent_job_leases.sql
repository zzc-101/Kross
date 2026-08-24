ALTER TABLE agent_messages
  ADD COLUMN lease_id text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;

CREATE INDEX agent_messages_processing_lease
  ON agent_messages (lease_expires_at, agent_id)
  WHERE role = 'user' AND status = 'processing';

CREATE TABLE agent_delivery_receipts (
  delivery_id text PRIMARY KEY,
  agent_id text NOT NULL,
  message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX agent_delivery_receipts_created
  ON agent_delivery_receipts (created_at);
