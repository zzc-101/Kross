CREATE TABLE agent_settings (
  agent_id text PRIMARY KEY,
  organization_id text NOT NULL,
  mcp_servers jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, agent_id),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents (organization_id, id) ON DELETE CASCADE
);
