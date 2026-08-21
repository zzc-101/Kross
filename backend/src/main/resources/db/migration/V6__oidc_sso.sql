-- Platform OIDC SSO. Kross is the relying party; the enterprise IdP issues identity.

ALTER TABLE platform_settings
  ADD COLUMN sso_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN sso_display_name text,
  ADD COLUMN sso_issuer text,
  ADD COLUMN sso_client_id text,
  ADD COLUMN sso_client_secret_cipher text;

ALTER TABLE users
  ADD COLUMN email text,
  ADD COLUMN sso_issuer text,
  ADD COLUMN sso_subject text;

CREATE UNIQUE INDEX users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_sso_subject ON users (sso_issuer, sso_subject)
  WHERE sso_issuer IS NOT NULL AND sso_subject IS NOT NULL;
