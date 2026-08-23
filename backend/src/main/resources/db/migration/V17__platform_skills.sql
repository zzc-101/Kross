CREATE TABLE platform_skills (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,63}$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '办公效率',
  icon text NOT NULL DEFAULT 'sparkles',
  launch_mode text NOT NULL DEFAULT 'instant'
    CHECK (launch_mode IN ('instant', 'form', 'file')),
  starter_prompt text NOT NULL DEFAULT '',
  content text NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_skills_catalog
  ON platform_skills (status, category, name, id);

CREATE TABLE organization_skill_installations (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  skill_id text NOT NULL REFERENCES platform_skills(id) ON DELETE RESTRICT,
  installed_by text NOT NULL REFERENCES users(id),
  display_order integer NOT NULL DEFAULT 0,
  configuration jsonb NOT NULL DEFAULT '{}',
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, skill_id)
);

CREATE INDEX organization_skill_installations_order
  ON organization_skill_installations (organization_id, display_order, installed_at, skill_id);

ALTER TABLE agent_conversations
  ADD COLUMN skill_id text REFERENCES platform_skills(id) ON DELETE SET NULL;

CREATE INDEX agent_conversations_skill
  ON agent_conversations (skill_id)
  WHERE skill_id IS NOT NULL;
