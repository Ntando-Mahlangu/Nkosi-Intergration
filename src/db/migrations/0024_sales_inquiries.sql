-- Prospective-client inquiries from the public marketing page
-- (public/get-started.html's "tell us about your business" form).
-- Deliberately unrelated to tenants/leads: this is a business inquiring
-- about *becoming* a LeadRecovery client, not a lead belonging to one.
CREATE TABLE IF NOT EXISTS sales_inquiries (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_inquiries_created_idx ON sales_inquiries (created_at DESC);
