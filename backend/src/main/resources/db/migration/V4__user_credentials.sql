-- Account passwords, platform super-admin, and the registration switch.

ALTER TABLE users
  ADD COLUMN username text,
  ADD COLUMN password_hash text,
  ADD COLUMN platform_role text NOT NULL DEFAULT 'user'
    CHECK (platform_role IN ('super_admin', 'user'));

UPDATE users SET username = id WHERE username IS NULL;

ALTER TABLE users
  ALTER COLUMN username SET NOT NULL;

CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

CREATE TABLE platform_settings (
  id text PRIMARY KEY CHECK (id = 'default'),
  registration_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (id, registration_enabled)
VALUES ('default', false);
