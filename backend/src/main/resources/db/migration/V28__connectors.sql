-- Inbound chat connectors (Feishu first). Channel adapters map external
-- identities onto existing users; core conversation tables stay channel-agnostic.

CREATE TABLE connector_bindings (
  id text PRIMARY KEY,
  channel text NOT NULL,
  tenant_id text NOT NULL,
  external_user_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, tenant_id, external_user_id),
  UNIQUE (channel, user_id)
);

CREATE TABLE connector_threads (
  id text PRIMARY KEY,
  channel text NOT NULL,
  external_chat_id text NOT NULL,
  conversation_id text NOT NULL,
  binding_id text NOT NULL REFERENCES connector_bindings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_chat_id)
);

CREATE INDEX connector_threads_conversation
  ON connector_threads (conversation_id);

CREATE TABLE connector_inbox (
  id text PRIMARY KEY,
  channel text NOT NULL,
  event_id text NOT NULL,
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, event_id)
);

CREATE INDEX connector_inbox_retry
  ON connector_inbox (status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');
