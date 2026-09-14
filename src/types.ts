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
 * info (phone for sms/whatsapp, email for email) AND the tenant has that
 * channel configured (or is in devMode, for local/demo use).
 */
export const CHANNEL_PRIORITY: Channel[] = ["sms", "whatsapp", "email"];

export interface Lead {
  id: string;
  tenantId: string;
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
  /** Number of follow-up nudges already sent since the initial message. */
  followUpCount?: number;
  /** Earliest time the next follow-up may be sent (ISO date). */
  nextFollowUpAt?: string;
  /**
   * When LeadRecovery itself first messaged this lead (ISO date), distinct
   * from `lastContactedAt`/`status`, which may reflect the business's own
   * prior (pre-LeadRecovery) contact history imported from a CRM. Unset
   * means this lead is still eligible for an initial-outreach plan even if
   * its imported status/lastContactedAt already show a contact attempt.
   */
  firstOutreachSentAt?: string;
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

// --- Multi-tenancy ---

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** E.164 sender number. For WhatsApp, the bare number without the "whatsapp:" prefix. */
  fromNumber: string;
}

export interface SendGridCredentials {
  apiKey: string;
  fromEmail: string;
  fromName?: string;
}

export interface ChannelCredentials {
  sms?: TwilioCredentials;
  whatsapp?: TwilioCredentials;
  email?: SendGridCredentials;
}

export interface QuietHours {
  /** Local hour (0-23) quiet hours begin. */
  startHour: number;
  /** Local hour (0-23) quiet hours end. */
  endHour: number;
}

/**
 * Optional per-tenant overrides for outreach copy. Each string is run
 * through substituteTemplate with placeholders {name}, {businessName},
 * {reason} (initialGrounded only), {service} (initialUngrounded only).
 * Unset fields fall back to the built-in default wording.
 */
export interface MessageTemplates {
  initialGrounded?: string;
  initialUngrounded?: string;
  /** Indexed by follow-up attempt (0 = first follow-up, 1 = second, ...). */
  followUps?: string[];
  /** Sent when a reply classifies as not_interested — a fixed, no-LLM-needed polite close-out. */
  notInterestedCloser?: string;
}

export interface Tenant {
  id: string;
  name: string;
  /** Bearer token this tenant uses to call the API. */
  apiKey: string;
  /** IANA timezone, e.g. "Africa/Johannesburg". Used to evaluate quiet hours. */
  timezone: string;
  /** Local send window restriction; sends outside this are deferred, not dropped. */
  quietHours?: QuietHours;
  /**
   * When true, channels without real provider credentials fall back to
   * logging to the console instead of refusing to send. Intended for local
   * development/demos only — never set this for a real client.
   */
  devMode?: boolean;
  channels: ChannelCredentials;
  /** Where to POST a notification when a reply classifies as "interested" or needs a human (e.g. a Slack incoming webhook URL). */
  notifyWebhookUrl?: string;
  templates?: MessageTemplates;
  /**
   * Plain-text/FAQ knowledge the auto-reply chatbot may draw on (services,
   * pricing, hours, policies, ...). The bot answers ONLY from this text and
   * escalates to a human for anything it doesn't clearly cover — see
   * src/chatbot.ts. Unset means no chatbot knowledge is configured.
   */
  knowledgeBase?: string;
  /**
   * Opt-in: when true (and knowledgeBase is set), inbound questions get an
   * automated grounded reply instead of always waiting for a human. Off by
   * default — a business must deliberately turn this on.
   */
  autoReplyEnabled?: boolean;
  createdAt: string;
}

/** Tenant fields safe to expose over the API (no secrets). */
export type PublicTenant = Omit<Tenant, "channels" | "apiKey"> & {
  channels: { sms: boolean; whatsapp: boolean; email: boolean };
};

export function toPublicTenant(tenant: Tenant): PublicTenant {
  const { channels, apiKey: _apiKey, ...rest } = tenant;
  return {
    ...rest,
    channels: {
      sms: Boolean(channels.sms),
      whatsapp: Boolean(channels.whatsapp),
      email: Boolean(channels.email),
    },
  };
}

export type MessageDirection = "outbound" | "inbound";

export type ReplyClassification = "stop" | "interested" | "not_interested" | "question" | "unknown";

export interface Message {
  id: string;
  tenantId: string;
  leadId: string;
  channel: Channel;
  direction: MessageDirection;
  body: string;
  at: string; // ISO date
  classification?: ReplyClassification;
  /** Provider's own message id (Twilio SID, etc.), when the send returned one. */
  providerMessageId?: string;
  /** Latest delivery status reported by the provider (e.g. "delivered", "failed", "bounce"). */
  deliveryStatus?: string;
  /**
   * What produced an outbound message: unset/"campaign" = the scheduled
   * recovery workflow (initial outreach or a follow-up nudge), "auto_reply"
   * = the knowledge-base-grounded chatbot, "closer" = the fixed
   * not-interested acknowledgment. Inbound messages leave this unset.
   */
  kind?: "campaign" | "auto_reply" | "closer";
}
