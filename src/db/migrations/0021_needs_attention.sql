-- In-app "needs attention" inbox (see POST /leads/:id/reply,
-- POST /leads/:id/mark-handled, GET /leads?needsAttention=true).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS needs_attention_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS needs_attention_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attention_alerted_at TIMESTAMPTZ;
