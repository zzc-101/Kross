CREATE TABLE agent_tool_approvals (
  agent_id text NOT NULL,
  approval_id text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  user_message_id text NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  agent_message_id text NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decision_reason text,
  resolved_by text REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (agent_id, approval_id),
  FOREIGN KEY (organization_id, agent_id)
    REFERENCES agents(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, conversation_id)
    REFERENCES agent_conversations(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_tool_approvals_pending
  ON agent_tool_approvals (organization_id, conversation_id, requested_at DESC)
  WHERE status = 'pending';
