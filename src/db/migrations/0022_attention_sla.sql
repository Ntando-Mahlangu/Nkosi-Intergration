-- Opt-in SLA alerting on stale needs-attention items (see src/worker.ts's
-- alertStaleAttentionItems, Tenant.attentionSlaHours).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS attention_sla_hours INTEGER;
