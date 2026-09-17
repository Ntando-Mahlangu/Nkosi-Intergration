import type { Lead, LeadStatus, Message, Tenant } from "../types.js";

/**
 * A notification (an "interested" reply, or a chatbot escalation) that
 * failed to reach tenant.notifyWebhookUrl even after notify.ts's inline
 * retry — persisted so it isn't silently lost. The worker retries pending
 * ones on each tick; after MAX_NOTIFICATION_ATTEMPTS (see notify.ts) it's
 * marked "dead" and stays visible via the admin API for someone to notice
 * and fix (e.g. a broken notifyWebhookUrl) rather than retrying forever.
 */
export interface FailedNotification {
  id: string;
  tenantId: string;
  leadId?: string;
  reason: "interested" | "needs_human_reply";
  webhookUrl: string;
  /** The exact JSON body that would be POSTed on a successful delivery. */
  payload: Record<string, unknown>;
  attempts: number;
  lastError?: string;
  status: "pending" | "dead";
  createdAt: string;
  lastAttemptAt: string;
}

export interface NotificationStore {
  recordFailure(input: {
    tenantId: string;
    leadId?: string;
    reason: FailedNotification["reason"];
    webhookUrl: string;
    payload: Record<string, unknown>;
    error: string;
  }): Promise<FailedNotification>;
  /** All not-yet-dead notifications, across every tenant — the worker redelivers these each tick. */
  listPending(): Promise<FailedNotification[]>;
  /** Every failed notification (pending + dead), for admin visibility. */
  listAll(): Promise<FailedNotification[]>;
  markDelivered(id: string): Promise<void>;
  /** Records another failed attempt; flips to "dead" once attempts reaches maxAttempts. */
  markAttemptFailed(id: string, error: string, maxAttempts: number): Promise<void>;
}

/**
 * Records admin actions (tenant create/update/delete/key-rotation) for
 * accountability. `actor` is whichever admin key's name authenticated the
 * request (see requireAdminAuth's parseAdminKeys in middleware/auth.ts) —
 * "admin" for the legacy single ADMIN_API_KEY, or a per-person name when
 * ADMIN_API_KEYS is configured — showing *who* changed *what* and *when*,
 * which is the part that matters for "who suspended tenant X and why is a
 * client locked out."
 */
export interface AuditLogEntry {
  id: string;
  tenantId?: string;
  action: "tenant.create" | "tenant.admin_update" | "tenant.delete" | "tenant.key_rotate";
  actor: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogStore {
  record(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<AuditLogEntry>;
  list(params: { limit?: number; offset: number }): Promise<AuditLogEntry[]>;
  count(): Promise<number>;
}

/**
 * Guards an updateLead call against clobbering a status change that
 * happened concurrently (e.g. a lead replying STOP mid-send). When given,
 * the patch is applied only if the lead's current status is still one of
 * `onlyIfStatusIn` — otherwise the update is skipped and the lead's current
 * (unmodified) state is returned instead.
 */
export interface UpdateLeadGuard {
  onlyIfStatusIn: LeadStatus[];
}

/**
 * Pluggable source of leads, scoped per tenant. The in-memory implementation
 * in memory.ts is for local development and tests. PostgresLeadStore (in
 * postgres.ts) is the production-shaped implementation.
 */
export interface LeadStore {
  getAllLeads(tenantId: string): Promise<Lead[]>;
  getLeadById(tenantId: string, id: string): Promise<Lead | undefined>;
  /** Finds a lead by phone or email within a tenant — used to match inbound replies to a lead. */
  findLeadByContact(tenantId: string, contact: { phone?: string; email?: string }): Promise<Lead | undefined>;
  createLead(lead: Lead): Promise<Lead>;
  updateLead(tenantId: string, id: string, patch: Partial<Lead>, guard?: UpdateLeadGuard): Promise<Lead | undefined>;
}

export interface TenantStore {
  getTenant(id: string): Promise<Tenant | undefined>;
  getTenantByApiKey(apiKey: string): Promise<Tenant | undefined>;
  listTenants(): Promise<Tenant[]>;
  createTenant(tenant: Tenant): Promise<Tenant>;
  updateTenant(id: string, patch: Partial<Tenant>): Promise<Tenant | undefined>;
  /** Permanently removes a tenant. Postgres cascades to its leads/messages; returns false if no such tenant. */
  deleteTenant(id: string): Promise<boolean>;
}

export interface MessageStore {
  logMessage(message: Message): Promise<Message>;
  getMessagesForLead(tenantId: string, leadId: string): Promise<Message[]>;
  /** Updates delivery status for a message previously logged with this id (used by provider delivery-status webhooks). */
  updateMessageStatus(tenantId: string, messageId: string, deliveryStatus: string): Promise<Message | undefined>;
  /**
   * Every message across a tenant (not scoped to one lead), optionally
   * bounded to `[since, until]` on `at` — the activity feed the reporting
   * endpoint (GET /tenants/me/report) aggregates over.
   */
  listForTenant(tenantId: string, range?: { since?: string; until?: string }): Promise<Message[]>;
}
