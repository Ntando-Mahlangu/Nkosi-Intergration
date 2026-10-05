-- Team accounts per tenant (see src/types.ts's TenantUser, README "Team
-- accounts"). A tenant's own email/password/apiKey remains an implicit,
-- unremovable "owner" account — these rows are *additional* accounts.
--
-- email: login identity, globally unique case-insensitively (same
-- precedent as tenants.email, migration 0015) so /auth/login can resolve it
-- without first knowing which tenant to search within.
--
-- login_key: this person's own bearer credential (src/idgen.ts's
-- generateTenantUserKey), a per-person equivalent of tenants.api_key —
-- globally unique and looked up directly, same as tenants.api_key.
--
-- password_hash / password_reset_token_hash / password_reset_expires_at:
-- identical shape and purpose to the matching tenants.* columns (migration
-- 0015) — see that migration's own comment.
--
-- ON DELETE CASCADE: unlike audit_log (deliberately FK-less so entries
-- survive tenant deletion), a team member's own account has no reason to
-- outlive the tenant it belongs to.
CREATE TABLE IF NOT EXISTS tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT,
  login_key TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  password_reset_token_hash TEXT,
  password_reset_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_users_email_unique_idx ON tenant_users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS tenant_users_login_key_unique_idx ON tenant_users (login_key);
CREATE INDEX IF NOT EXISTS tenant_users_tenant_id_idx ON tenant_users (tenant_id);
