-- "Connect this client's existing number" (see src/numberHosting.ts) — tracks
-- an in-progress or completed Twilio Hosted Number Order per tenant, the
-- missedcall.io-style alternative to assigning a brand new number.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS number_hosting_order JSONB;
