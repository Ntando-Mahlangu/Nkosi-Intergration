import type { Lead, Message, Tenant } from "../types.js";
import type { LeadStore, MessageStore, TenantStore } from "./types.js";

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

  async findLeadByContact(
    tenantId: string,
    contact: { phone?: string; email?: string }
  ): Promise<Lead | undefined> {
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

  async updateLead(tenantId: string, id: string, patch: Partial<Lead>): Promise<Lead | undefined> {
    const existing = this.leads.get(id);
    if (!existing || existing.tenantId !== tenantId) return undefined;
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
}
