-- Admin-side onboarding attestation that the client already reviewed and
-- agreed to LeadRecovery's own Terms of Service/Privacy Policy outside the
-- app (e.g. during a sales call or contract signing) — see
-- Tenant.termsAttestedAt. Distinct from terms_accepted_at (migration 0013),
-- the client's own required in-app acceptance, which this does NOT satisfy
-- and does not touch.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS terms_attested_at TIMESTAMPTZ;
