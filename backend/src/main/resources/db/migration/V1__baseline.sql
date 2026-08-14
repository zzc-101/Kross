-- Persistent per-user Agent workspace. No Run-sandbox compatibility.

CREATE TABLE users (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','suspended','deleted')),
  default_timezone text NOT NULL,
  data_retention_days integer CHECK (data_retention_days > 0),
  approval_policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  status text NOT NULL CHECK (status IN ('invited','active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id)
);

CREATE TABLE agents (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'stopped'
    CHECK (status IN ('stopped','starting','running','stopping','error')),
  volume_name text NOT NULL,
  container_name text NOT NULL,
  container_id text,
  last_error text,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id)
);

CREATE TABLE agent_messages (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  agent_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','agent','system')),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'done'
    CHECK (status IN ('queued','processing','done','failed')),
  error_summary text,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_messages_timeline
  ON agent_messages (organization_id, agent_id, created_at ASC, id ASC);
CREATE INDEX agent_messages_jobs
  ON agent_messages (agent_id, created_at ASC)
  WHERE status = 'queued' AND role = 'user';

CREATE TABLE agent_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  organization_id text NOT NULL,
  agent_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, agent_id, token_hash),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_tokens_active
  ON agent_tokens (agent_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX audit_events_tenant_time ON audit_events (organization_id, occurred_at DESC, id DESC);

CREATE TABLE idempotency_keys (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  resource_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, scope, idempotency_key)
);

CREATE TABLE credential_handles (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL,
  handle text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  secret_ciphertext text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, handle),
  CHECK (secret_ciphertext IS NULL OR secret_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
);

CREATE TABLE model_profiles (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  credential_handle_id text,
  configuration jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, credential_handle_id)
    REFERENCES credential_handles(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX credential_handles_tenant_created
  ON credential_handles (organization_id, created_at DESC, id DESC);
CREATE INDEX model_profiles_tenant_created
  ON model_profiles (organization_id, created_at DESC, id DESC);
