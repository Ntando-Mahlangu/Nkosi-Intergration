-- Records *why* a tenant's status last changed ("manual" for an admin's own
-- PATCH /admin/tenants/:id, "billing" for an automatic change made by
-- /webhooks/paddle) so the admin UI can distinguish a deliberate hold from
-- a payment lapse instead of showing the same bare "suspended" badge for
-- both. Purely informational — nothing in the app branches on this value.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status_reason TEXT;
