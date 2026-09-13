CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL,
  quiet_hours_start INT,
  quiet_hours_end INT,
  dev_mode BOOLEAN NOT NULL DEFAULT FALSE,
  channels JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  email TEXT,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_contacted_at TIMESTAMPTZ,
  previous_conversation_summary TEXT,
  requested_service TEXT,
  previous_quote TEXT,
  appointment_status TEXT,
  notes TEXT,
  status TEXT NOT NULL,
  preferred_channel TEXT,
  had_missed_call BOOLEAN,
  responded_after_contact BOOLEAN,
  follow_up_count INT,
  next_follow_up_at TIMESTAMPTZ,
  first_outreach_sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS leads_tenant_idx ON leads (tenant_id);
CREATE INDEX IF NOT EXISTS leads_tenant_phone_idx ON leads (tenant_id, phone);
CREATE INDEX IF NOT EXISTS leads_tenant_email_idx ON leads (tenant_id, email);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  classification TEXT
);

CREATE INDEX IF NOT EXISTS messages_tenant_lead_idx ON messages (tenant_id, lead_id);
