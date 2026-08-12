export const workAgentV2Migration = String.raw`
CREATE TABLE users (
  id text PRIMARY KEY,
  display_name text NOT NULL,
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
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id)
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

CREATE TABLE projects (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('general','repository')),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  repository_binding jsonb,
  default_model_profile_id text,
  default_permission_policy jsonb NOT NULL,
  default_task_type text NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK ((kind = 'repository') = (repository_binding IS NOT NULL))
);

CREATE TABLE tasks (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  objective text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '[]',
  acceptance_criteria jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'open',
  latest_run_id text,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  archived_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE sources (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  task_id text,
  kind text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('project','task')),
  status text NOT NULL,
  display_name text NOT NULL,
  mime_type text,
  size_bytes bigint CHECK (size_bytes >= 0),
  sha256 text,
  blob_key text,
  external_locator text,
  origin jsonb NOT NULL,
  previous_source_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, previous_source_id) REFERENCES sources(organization_id, id),
  CHECK ((scope = 'task') = (task_id IS NOT NULL))
);

CREATE TABLE task_sources (
  organization_id text NOT NULL,
  task_id text NOT NULL,
  source_id text NOT NULL,
  PRIMARY KEY (organization_id, task_id, source_id),
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, source_id) REFERENCES sources(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE runs (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  task_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('auto','plan')),
  execution_profile text NOT NULL CHECK (execution_profile = 'work'),
  model_snapshot jsonb NOT NULL,
  permission_policy jsonb NOT NULL,
  resource_limits jsonb NOT NULL,
  selected_source_ids jsonb NOT NULL DEFAULT '[]',
  usage jsonb NOT NULL,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  failure_code text,
  failure_summary text,
  checkpoint_key text,
  execution_workspace_id text,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, task_id, attempt),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX runs_one_active_per_task
  ON runs (organization_id, task_id)
  WHERE status IN ('queued','provisioning','running','waiting_for_approval','cancelling');

ALTER TABLE tasks ADD CONSTRAINT tasks_latest_run_fk
  FOREIGN KEY (organization_id, latest_run_id) REFERENCES runs(organization_id, id);

CREATE TABLE task_messages (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  task_id text NOT NULL,
  run_id text,
  role text NOT NULL CHECK (role IN ('user','agent','system')),
  content jsonb NOT NULL,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE run_events (
  event_id bigserial PRIMARY KEY,
  public_event_id text NOT NULL UNIQUE,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  task_id text NOT NULL,
  run_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  seq bigint NOT NULL CHECK (seq > 0),
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, generation, seq),
  UNIQUE (organization_id, event_id),
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX run_events_replay ON run_events (organization_id, event_id);

CREATE TABLE approvals (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  task_id text NOT NULL,
  run_id text NOT NULL,
  kind text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  risk_level text NOT NULL,
  action_preview text NOT NULL,
  target jsonb NOT NULL,
  request_hash text NOT NULL,
  requested_at timestamptz NOT NULL,
  expires_at timestamptz,
  decided_by text REFERENCES users(id),
  decision_reason text,
  decided_at timestamptz,
  decision_idempotency_key text,
  decision_delivered_generation integer CHECK (decision_delivered_generation > 0),
  decision_delivered_at timestamptz,
  consumed_at timestamptz,
  consumption_idempotency_key text,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, decision_idempotency_key),
  UNIQUE (organization_id, consumption_idempotency_key),
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  CHECK ((status IN ('approved','rejected')) = (decided_at IS NOT NULL)),
  CHECK ((decision_delivered_at IS NULL) = (decision_delivered_generation IS NULL)),
  CHECK ((consumed_at IS NULL) = (consumption_idempotency_key IS NULL))
);

CREATE TABLE artifacts (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  task_id text NOT NULL,
  run_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  display_name text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint,
  sha256 text,
  blob_key text,
  previous_artifact_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, previous_artifact_id) REFERENCES artifacts(organization_id, id)
);

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

CREATE TABLE run_leases (
  run_id text PRIMARY KEY,
  organization_id text NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','leased','released','completed')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, run_id),
  UNIQUE (lease_id),
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id) ON DELETE CASCADE,
  CHECK ((status = 'leased') = (lease_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX run_leases_claimable ON run_leases (available_at, run_id)
  WHERE status IN ('available','released');

CREATE TABLE worker_run_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  organization_id text NOT NULL,
  run_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  lease_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  worker_session_id text,
  worker_id text,
  registered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, run_id, generation, lease_id, worker_session_id),
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX worker_run_tokens_active
  ON worker_run_tokens (organization_id, run_id, generation, lease_id, expires_at)
  WHERE revoked_at IS NULL;
`;
