-- Admin-action audit trail (tenant create/update/delete/key-rotation).
-- tenant_id has no foreign key so an entry survives the tenant it
-- describes being deleted — including the deletion event itself.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
