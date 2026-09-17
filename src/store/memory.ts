import type { Lead, Message, Tenant } from "../types.js";
import { generateId } from "../idgen.js";
import type {
  AuditLogEntry,
  AuditLogStore,
  FailedNotification,
  LeadStore,
  MessageStore,
  NotificationStore,
  TenantStore,
  UpdateLeadGuard,
} from "./types.js";

export class InMemoryLeadStore implements LeadStore {
  private leads: Map<string, Lead>;

  constructor(initialLeads: Lead[] = []) {
    this.leads = new Map(initialLeads.map((lead) => [lead.id, lead]));
  }

  async getAllLeads(tenantId: string): Promise<Lead[]> {
    return Array.from(this.leads.values()).filter((lead) => lead.tenantId === tenantId);
  }

  async getLeadById(tenantId: string, id: string): Promise<Lead | undefined> {
    const lead = this.leads.get(id);
    return lead && lead.tenantId === tenantId ? lead : undefined;
  }

  async findLeadByContact(tenantId: string, contact: { phone?: string; email?: string }): Promise<Lead | undefined> {
    return Array.from(this.leads.values()).find(
      (lead) =>
        lead.tenantId === tenantId &&
        ((contact.phone && lead.phone === contact.phone) || (contact.email && lead.email === contact.email))
    );
  }

  async createLead(lead: Lead): Promise<Lead> {
    this.leads.set(lead.id, lead);
    return lead;
  }

  async updateLead(
    tenantId: string,
    id: string,
    patch: Partial<Lead>,
    guard?: UpdateLeadGuard
  ): Promise<Lead | undefined> {
    const existing = this.leads.get(id);
    if (!existing || existing.tenantId !== tenantId) return undefined;
    // Re-reads `this.leads.get(id)` above rather than trusting a snapshot the
    // caller took earlier, so this always merges against the current state —
    // but the patch itself can still carry an explicit, stale status decided
    // before some concurrent update changed it (e.g. a lead replying STOP
    // mid-send); the guard rejects applying such a stale patch.
    if (guard && !guard.onlyIfStatusIn.includes(existing.status)) return existing;
    const updated = { ...existing, ...patch };
    this.leads.set(id, updated);
    return updated;
  }
}

export class InMemoryTenantStore implements TenantStore {
  private tenants: Map<string, Tenant>;

  constructor(initialTenants: Tenant[] = []) {
    this.tenants = new Map(initialTenants.map((tenant) => [tenant.id, tenant]));
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    return this.tenants.get(id);
  }

  async getTenantByApiKey(apiKey: string): Promise<Tenant | undefined> {
    return Array.from(this.tenants.values()).find((tenant) => tenant.apiKey === apiKey);
  }

  async listTenants(): Promise<Tenant[]> {
    return Array.from(this.tenants.values());
  }

  async createTenant(tenant: Tenant): Promise<Tenant> {
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  async updateTenant(id: string, patch: Partial<Tenant>): Promise<Tenant | undefined> {
    const existing = this.tenants.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.tenants.set(id, updated);
    return updated;
  }

  async deleteTenant(id: string): Promise<boolean> {
    // Demo/test store only: unlike PostgresTenantStore, this doesn't cascade
    // to leads/messages in the separate InMemoryLeadStore/InMemoryMessageStore
    // instances — acceptable here since nothing persists across process restarts anyway.
    return this.tenants.delete(id);
  }
}

export class InMemoryMessageStore implements MessageStore {
  private messages: Message[] = [];

  async logMessage(message: Message): Promise<Message> {
    this.messages.push(message);
    return message;
  }

  async getMessagesForLead(tenantId: string, leadId: string): Promise<Message[]> {
    return this.messages
      .filter((m) => m.tenantId === tenantId && m.leadId === leadId)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }

  async updateMessageStatus(tenantId: string, messageId: string, deliveryStatus: string): Promise<Message | undefined> {
    const message = this.messages.find((m) => m.tenantId === tenantId && m.id === messageId);
    if (!message) return undefined;
    message.deliveryStatus = deliveryStatus;
    return message;
  }

  async listForTenant(tenantId: string, range?: { since?: string; until?: string }): Promise<Message[]> {
    const sinceMs = range?.since ? new Date(range.since).getTime() : undefined;
    const untilMs = range?.until ? new Date(range.until).getTime() : undefined;
    return this.messages
      .filter((m) => {
        if (m.tenantId !== tenantId) return false;
        const at = new Date(m.at).getTime();
        if (sinceMs !== undefined && at < sinceMs) return false;
        if (untilMs !== undefined && at > untilMs) return false;
        return true;
      })
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }
}

export class InMemoryNotificationStore implements NotificationStore {
  private failures: FailedNotification[] = [];

  async recordFailure(input: {
    tenantId: string;
    leadId?: string;
    reason: FailedNotification["reason"];
    webhookUrl: string;
    payload: Record<string, unknown>;
    error: string;
  }): Promise<FailedNotification> {
    const now = new Date().toISOString();
    const failure: FailedNotification = {
      id: generateId("failnotif"),
      tenantId: input.tenantId,
      leadId: input.leadId,
      reason: input.reason,
      webhookUrl: input.webhookUrl,
      payload: input.payload,
      attempts: 1,
      lastError: input.error,
      status: "pending",
      createdAt: now,
      lastAttemptAt: now,
    };
    this.failures.push(failure);
    return failure;
  }

  async listPending(): Promise<FailedNotification[]> {
    return this.failures.filter((f) => f.status === "pending");
  }

  async listAll(): Promise<FailedNotification[]> {
    return [...this.failures];
  }

  async markDelivered(id: string): Promise<void> {
    this.failures = this.failures.filter((f) => f.id !== id);
  }

  async markAttemptFailed(id: string, error: string, maxAttempts: number): Promise<void> {
    const failure = this.failures.find((f) => f.id === id);
    if (!failure) return;
    failure.attempts += 1;
    failure.lastError = error;
    failure.lastAttemptAt = new Date().toISOString();
    if (failure.attempts >= maxAttempts) failure.status = "dead";
  }
}

export class InMemoryAuditLogStore implements AuditLogStore {
  private entries: AuditLogEntry[] = [];

  async record(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<AuditLogEntry> {
    const full: AuditLogEntry = { ...entry, id: generateId("audit"), createdAt: new Date().toISOString() };
    this.entries.push(full);
    return full;
  }

  async list({ limit, offset }: { limit?: number; offset: number }): Promise<AuditLogEntry[]> {
    const sorted = [...this.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sorted.slice(offset, limit === undefined ? undefined : offset + limit);
  }

  async count(): Promise<number> {
    return this.entries.length;
  }
}
