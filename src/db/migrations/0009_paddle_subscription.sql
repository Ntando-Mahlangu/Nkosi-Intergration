-- Links a tenant to its Paddle subscription, for /webhooks/paddle's fallback
-- lookup (by subscription id) when an event's custom_data doesn't carry a
-- tenantId. The partial unique index (rather than a plain UNIQUE
-- constraint, which Postgres would still enforce across NULLs-are-distinct
-- semantics anyway) makes the "not every tenant has one" intent explicit
-- and guards against two tenants ever pointing at the same subscription,
-- which would make that fallback lookup return an arbitrary one of them.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_paddle_subscription_id_idx
  ON tenants (paddle_subscription_id) WHERE paddle_subscription_id IS NOT NULL;

-- The `occurred_at` timestamp of the most recent Paddle webhook event
-- actually applied to this tenant — lets /webhooks/paddle detect and skip
-- an out-of-order/delayed-retry event that would otherwise undo a newer
-- status change (see Tenant.paddleLastEventAt's own doc comment). Stored
-- as the raw TEXT Paddle sent, not TIMESTAMPTZ: node-postgres reads a
-- TIMESTAMPTZ column back as a JS Date, which only has millisecond
-- resolution — Paddle's occurred_at carries microsecond precision, so that
-- round trip would silently truncate it, and comparing a truncated stored
-- value against a fresh full-precision one as plain strings can then rank
-- a genuinely later event as "stale" (differing trailing digits sort
-- unpredictably once the two strings have different lengths).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS paddle_last_event_at TEXT;
