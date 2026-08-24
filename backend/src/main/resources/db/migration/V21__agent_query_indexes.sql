CREATE INDEX agent_messages_agent_processing
  ON agent_messages (agent_id)
  WHERE status = 'processing';

CREATE INDEX agent_messages_agent_user_created
  ON agent_messages (agent_id, created_at, id)
  WHERE role = 'user';

CREATE INDEX agent_messages_organization_user_created
  ON agent_messages (organization_id, created_at)
  WHERE role = 'user';
