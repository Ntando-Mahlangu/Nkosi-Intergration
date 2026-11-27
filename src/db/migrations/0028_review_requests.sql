-- One-time automated review requests for converted leads who explicitly
-- opted in (see src/reviewRequest.ts, COMPLIANCE.md "Review requests").
-- Reuses leads.marketing_opt_in (added by migration 0019) as its consent
-- gate rather than adding a second opt-in column — see that file's own
-- comment for why.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS review_request_sent_at TIMESTAMPTZ;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS review_request_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS review_request_delay_days INT;
