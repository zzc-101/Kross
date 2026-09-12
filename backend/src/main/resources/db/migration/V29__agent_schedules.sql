-- Timed Agent turns. Definitions and due times live in Postgres so every
-- control-plane replica can claim a beat with SKIP LOCKED. No replica owner.
CREATE TABLE agent_schedules (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  agent_id text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  prompt text NOT NULL,
  skill_id text,
  conversation_mode text NOT NULL CHECK (conversation_mode IN ('new_conversation', 'pinned_conversation')),
  conversation_id text,
  timezone text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('once', 'cron')),
  cron_expr text,
  run_at timestamptz,
  next_run_at timestamptz,
  last_run_at timestamptz,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'done', 'error')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, conversation_id) REFERENCES agent_conversations (organization_id, id) ON DELETE SET NULL (conversation_id)
);

CREATE INDEX agent_schedules_due_idx
  ON agent_schedules (status, next_run_at, id)
  WHERE status = 'active' AND next_run_at IS NOT NULL;

CREATE INDEX agent_schedules_owner_idx
  ON agent_schedules (organization_id, user_id, updated_at DESC, id DESC);

CREATE TABLE agent_schedule_runs (
  id text PRIMARY KEY,
  schedule_id text NOT NULL REFERENCES agent_schedules (id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  conversation_id text,
  user_message_id text,
  due_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('started', 'skipped', 'failed')),
  error text
);

CREATE INDEX agent_schedule_runs_timeline_idx
  ON agent_schedule_runs (schedule_id, claimed_at DESC, id DESC);
