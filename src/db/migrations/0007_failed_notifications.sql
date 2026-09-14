-- Dead-letter store for notify.ts: an "interested"/escalation notification
-- that failed to reach tenant.notifyWebhookUrl even after the inline retry.
-- tenant_id has no foreign key so a record survives tenant deletion (it's
-- evidence of what happened, not live per-tenant state).
CREATE TABLE IF NOT EXISTS failed_notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lead_id TEXT,
  reason TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS failed_notifications_status_idx ON failed_notifications (status);
