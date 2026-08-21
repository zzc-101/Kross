-- Collapse org roles to admin/member. Super admin stays on users.platform_role.

UPDATE organization_memberships SET role = 'admin' WHERE role = 'owner';
UPDATE organization_memberships SET role = 'member' WHERE role = 'viewer';

ALTER TABLE organization_memberships DROP CONSTRAINT organization_memberships_role_check;
ALTER TABLE organization_memberships
  ADD CONSTRAINT organization_memberships_role_check CHECK (role IN ('admin', 'member'));
