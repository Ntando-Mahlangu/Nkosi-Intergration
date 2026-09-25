-- Closes several legal-compliance gaps (src/types.ts Tenant fields):
--
-- consent_basis_confirmed_at / carrier_approval_confirmed_at: audit records
-- of the agency operator's own onboarding attestations (COMPLIANCE.md
-- "Consent basis" and "SMS / WhatsApp (Twilio)"), not something the system
-- can independently verify. carrier_approval_confirmed_at additionally
-- gates the sms/whatsapp channels (see src/channels/index.ts selectChannel).
--
-- bot_disclosure_enabled: whether the auto-reply chatbot proactively
-- discloses it's automated (COMPLIANCE.md "Bot disclosure"); NULL means
-- "unset", read as true (the recommended default) by the application.
--
-- data_retention_days: per-tenant override for how long a closed-out lead's
-- data is kept before the worker purges it (COMPLIANCE.md "Data handling");
-- NULL means "use DEFAULT_DATA_RETENTION_DAYS" (src/dataRetention.ts).
--
-- As with migration 0013's terms acceptance, pre-existing tenants predate
-- these attestations entirely — retroactively blocking their sending would
-- stop real, already-onboarded clients rather than newly-onboarded ones.
-- They're grandfathered as of their own createdAt; only tenants created
-- after this migration runs are required to attest at creation time
-- (consent basis) or need an explicit carrier-approval confirmation before
-- their sms/whatsapp channels are usable.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS consent_basis_confirmed_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS carrier_approval_confirmed_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bot_disclosure_enabled BOOLEAN;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS data_retention_days INT;

UPDATE tenants
SET consent_basis_confirmed_at = created_at, carrier_approval_confirmed_at = created_at
WHERE consent_basis_confirmed_at IS NULL;
