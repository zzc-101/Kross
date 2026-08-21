CREATE TABLE auth_login_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('login', 'logout')),
  method text NOT NULL CHECK (method IN ('password', 'sso', 'session')),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  username text,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  ip text,
  user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_login_events_time ON auth_login_events (occurred_at DESC, id DESC);
CREATE INDEX auth_login_events_user_time ON auth_login_events (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;
