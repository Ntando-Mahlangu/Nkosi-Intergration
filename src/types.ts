export type LeadSource =
  | "crm"
  | "website_form"
  | "missed_call"
  | "booking_software"
  | "email"
  | "sms"
  | "whatsapp"
  | "spreadsheet"
  | "customer_database"
  | "other";

export type LeadStatus =
  | "new"
  | "contacted_no_response"
  | "responded"
  | "booked"
  | "converted"
  | "do_not_contact"
  | "unqualified"
  | "fraudulent"
  | "active_conversation"
  | "opted_out";

export type Priority = "HIGH" | "MEDIUM" | "LOW";

export type Channel = "sms" | "whatsapp" | "email";

/**
 * Channels in the order LeadRecovery prefers to use them (STEP 4).
 * A concrete channel is only usable if the lead has the matching contact
 * info (phone for sms/whatsapp, email for email).
 */
export const CHANNEL_PRIORITY: Channel[] = ["sms", "whatsapp", "email"];

export interface Lead {
  id: string;
  name?: string;
  phone?: string;
  email?: string;
  source: LeadSource;
  createdAt: string; // ISO date
  lastContactedAt?: string; // ISO date
  previousConversationSummary?: string;
  requestedService?: string;
  previousQuote?: string;
  appointmentStatus?: "none" | "requested" | "abandoned" | "booked";
  notes?: string;
  status: LeadStatus;
  /** Channel the business has configured for this lead/business, if any. */
  preferredChannel?: Channel;
  hadMissedCall?: boolean;
  respondedAfterContact?: boolean;
}

export interface ScoredLead {
  lead: Lead;
  priority: Priority;
  priorityReasons: string[];
}

export interface ContactReason {
  /** True reason grounded in known lead data, or undefined if none can be determined. */
  text?: string;
  /** Whether the reason was derived from known facts (true) or is a neutral fallback (false). */
  grounded: boolean;
}

export interface ComposedMessage {
  channel: Channel;
  body: string;
}

export interface RecoveryPlan {
  lead: Lead;
  priority: Priority;
  priorityReasons: string[];
  reason: ContactReason;
  message: ComposedMessage;
}

export interface SkippedLead {
  lead: Lead;
  reason: string;
}

export interface WorkflowResult {
  plans: RecoveryPlan[];
  skipped: SkippedLead[];
}
