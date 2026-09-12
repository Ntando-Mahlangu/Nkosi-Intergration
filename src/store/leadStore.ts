import type { Lead } from "../types.js";

/**
 * Pluggable source of leads. The in-memory implementation below is for
 * local development and tests. In production this would be backed by a
 * CRM API, a database, or an aggregation of several such sources (per
 * STEP 1 — IDENTIFY in SYSTEM_PROMPT.md).
 */
export interface LeadStore {
  getAllLeads(): Promise<Lead[]>;
  updateLead(id: string, patch: Partial<Lead>): Promise<Lead | undefined>;
}

export class InMemoryLeadStore implements LeadStore {
  private leads: Map<string, Lead>;

  constructor(initialLeads: Lead[] = []) {
    this.leads = new Map(initialLeads.map((lead) => [lead.id, lead]));
  }

  async getAllLeads(): Promise<Lead[]> {
    return Array.from(this.leads.values());
  }

  async updateLead(id: string, patch: Partial<Lead>): Promise<Lead | undefined> {
    const existing = this.leads.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.leads.set(id, updated);
    return updated;
  }
}
