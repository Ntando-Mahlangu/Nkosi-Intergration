import type { Lead, Message, Tenant } from "../types.js";

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
  updateLead(tenantId: string, id: string, patch: Partial<Lead>): Promise<Lead | undefined>;
}

export interface TenantStore {
  getTenant(id: string): Promise<Tenant | undefined>;
  getTenantByApiKey(apiKey: string): Promise<Tenant | undefined>;
  listTenants(): Promise<Tenant[]>;
  createTenant(tenant: Tenant): Promise<Tenant>;
  updateTenant(id: string, patch: Partial<Tenant>): Promise<Tenant | undefined>;
}

export interface MessageStore {
  logMessage(message: Message): Promise<Message>;
  getMessagesForLead(tenantId: string, leadId: string): Promise<Message[]>;
}
