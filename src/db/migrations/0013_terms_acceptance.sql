-- Terms of Service / Privacy Policy acceptance (src/types.ts
-- Tenant.termsAcceptedAt/termsVersion; version constant in src/terms.ts).
-- A tenant with no acceptance recorded is blocked from having outbound
-- messages actually sent (see worker.ts, webhooks/index.ts, and
-- POST /workflow/run) until it accepts via POST /tenants/me/accept-terms.
--
-- Existing tenants predate this consent step entirely — retroactively
-- blocking them would silently stop sending for real, already-onboarded
-- clients. They're grandfathered here instead: backfilled as accepted as
-- of their own createdAt, under a distinct "grandfathered" version marker
-- so it's visibly not the same as a real acceptance of CURRENT_TERMS_VERSION.
-- Only tenants created after this migration runs start out unaccepted.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS terms_version TEXT;
UPDATE tenants SET terms_accepted_at = created_at, terms_version = 'grandfathered' WHERE terms_accepted_at IS NULL;
