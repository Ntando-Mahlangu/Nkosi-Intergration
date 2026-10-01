-- Phone-number + one-time-code sign-in for tenants (src/routes/auth.ts),
-- the primary account-creation/login path going forward — a client signs in
-- with the number they already use for this business, no password to set or
-- forget. Alongside (not replacing) the existing email/password and raw
-- API-key/magic-link paths, which keep working for any tenant already using
-- them.
--
-- login_phone: the tenant's login identity, distinct from contact_phone
-- (migration 0012, reference-only) and from channels->sms->fromNumber (the
-- number *leads* are texted from). Nullable — a tenant with no phone login
-- set just uses another path. Unique when set so a code request resolves to
-- exactly one tenant.
--
-- otp_code_hash: SHA-256 hash of the current one-time code, never the raw
-- code (same principle as the password-reset token). otp_expires_at is a
-- short window (minutes, not the 24-hour reset-token TTL — see
-- src/routes/auth.ts). otp_attempts counts failed verify attempts since the
-- current code was issued and locks out past a small limit, since a 6-digit
-- code has far less entropy than a 256-bit reset token.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS login_phone TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS otp_code_hash TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS otp_attempts INT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_login_phone_unique_idx ON tenants (login_phone) WHERE login_phone IS NOT NULL;
