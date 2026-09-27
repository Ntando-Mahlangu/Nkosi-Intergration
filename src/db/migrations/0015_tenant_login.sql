-- Adds a SaaS-style email/password sign-in path for tenants, alongside the
-- existing API-key/magic-link auth (which stays the actual bearer credential
-- every request is checked against — see src/routes/auth.ts): email/password
-- just resolves to that same API key rather than replacing it with sessions.
--
-- email: the tenant's login identity, distinct from contact_email
-- (migration 0012), which is reference-only and never used to authenticate.
-- Nullable — a tenant onboarded before this feature, or one that only ever
-- uses its raw API key/magic link, need not have one. Unique when set
-- (case-insensitively, enforced by the partial index below) so a login
-- attempt resolves to exactly one tenant.
--
-- password_hash: scrypt output (src/password.ts), never the plaintext.
-- Unset until the tenant actually sets a password via the emailed
-- set-password link (src/routes/auth.ts's reset-password endpoint, shared
-- between initial setup and a later "forgot password").
--
-- password_reset_token_hash / password_reset_expires_at: a single-use,
-- time-limited token for the set-password/forgot-password email link. Only
-- the SHA-256 hash is stored (like a webhook shared secret) so a database
-- read alone can't produce a working reset link. Nulled out once used.
--
-- public_form_key: a separate, low-privilege token safe to embed in a
-- client's own public website (see POST /public/leads/:tenantId) — unlike
-- api_key, it can only ever create a lead via that one endpoint, nothing
-- else, so exposing it client-side carries none of api_key's risk. Every
-- tenant gets one at creation time; a pre-existing tenant is lazily
-- backfilled the first time GET /tenants/me reads it (application-side,
-- like every other id/key in this codebase — see src/idgen.ts), not here.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS public_form_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_email_unique_idx ON tenants (LOWER(email)) WHERE email IS NOT NULL;
