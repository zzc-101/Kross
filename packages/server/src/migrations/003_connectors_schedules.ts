export const connectorsSchedulesMigration = String.raw`
CREATE TABLE connector_definitions (
  id text PRIMARY KEY,
  name text NOT NULL,
  transport text NOT NULL CHECK (transport = 'streamable_http'),
  endpoint_url text NOT NULL CHECK (endpoint_url ~ '^https://'),
  allowed_tools jsonb NOT NULL DEFAULT '[]',
  required_scopes jsonb NOT NULL DEFAULT '[]',
  risk_policy jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'unavailable' CHECK (status IN ('available','unavailable')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connector_installations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text,
  connector_definition_id text NOT NULL REFERENCES connector_definitions(id),
  display_name text NOT NULL,
  credential_handle text,
  granted_scopes jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK (status IN ('pending','available','unavailable','revoked')),
  last_error_code text,
  installed_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  CHECK (credential_handle IS NULL OR credential_handle ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$')
);

CREATE TABLE schedules (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  task_id text NOT NULL,
  cron_expression text NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleted')),
  concurrency_policy text NOT NULL DEFAULT 'skip' CHECK (concurrency_policy = 'skip'),
  external_action_policy text NOT NULL DEFAULT 'draft_only' CHECK (external_action_policy = 'draft_only'),
  selected_source_ids jsonb NOT NULL DEFAULT '[]',
  next_run_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX schedules_due ON schedules (next_run_at, id) WHERE status = 'active';

CREATE TABLE schedule_occurrences (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  schedule_id text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('triggered','skipped_active_run','failed')),
  run_id text,
  idempotency_key text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, schedule_id, scheduled_for),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, schedule_id) REFERENCES schedules(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id) ON DELETE SET NULL
);
`;
