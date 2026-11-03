-- Per-lead consent evidence (Lead.consentStatus/consentTimestamp/
-- consentSource/consentScope/privacyNoticeVersion — see types.ts's own
-- doc comments), distinct from the tenant-level consent_basis_confirmed_at
-- attestation made once at onboarding. consent_scope is stored as a single
-- comma-separated TEXT column (e.g. "sms,email") rather than a Postgres
-- array type, consistent with every other multi-value-shaped field in this
-- schema being a flat column, not because an array type wouldn't work.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_status TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_timestamp TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_source TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_scope TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS privacy_notice_version TEXT;
