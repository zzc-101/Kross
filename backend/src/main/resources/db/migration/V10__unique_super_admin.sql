-- First-user bootstrap must not race into multiple platform super admins.
CREATE UNIQUE INDEX users_one_super_admin
  ON users (platform_role)
  WHERE platform_role = 'super_admin';
