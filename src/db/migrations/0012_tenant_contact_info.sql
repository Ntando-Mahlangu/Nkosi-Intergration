-- Reference-only business contact info captured during onboarding
-- (src/types.ts Tenant.contactPhone/contactEmail/website) — display data for
-- the agency's own tenant list, never used to actually send/receive
-- messages (that's channels.sms/whatsapp/email's own provider credentials).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS website TEXT;
