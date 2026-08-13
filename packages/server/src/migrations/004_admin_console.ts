export const adminConsoleMigration = String.raw`
CREATE TABLE credential_handles (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL,
  handle text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, handle)
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
`;
