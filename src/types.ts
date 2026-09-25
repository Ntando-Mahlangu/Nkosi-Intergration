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

// Every value LeadSource can take, for validating untrusted input (a webhook
// body, a CSV column) against the type at runtime — kept next to the type
// itself so the two can't drift apart the way two separately-maintained
// copies of this list would.
export const LEAD_SOURCES: ReadonlySet<LeadSource> = new Set([
  "crm",
  "website_form",
  "missed_call",
  "booking_software",
  "email",
  "sms",
  "whatsapp",
  "spreadsheet",
  "customer_database",
  "other",
]);

export function isLeadSource(value: unknown): value is LeadSource {
  return typeof value === "string" && LEAD_SOURCES.has(value as LeadSource);
}

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
  /** When the booked appointment is scheduled for (ISO date) — drives the 24-hours-before reminder. Only meaningful when `appointmentStatus` is "booked". */
  appointmentAt?: string;
  /** When the appointment reminder was actually sent (ISO date) — guards against sending it twice across worker runs. */
  appointmentReminderSentAt?: string;
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
  /**
   * Base64 DER (SPKI) ECDSA public key from SendGrid's Signed Event Webhook
   * setting. When set, /webhooks/:tenantId/sendgrid/events verifies the
   * request signature instead of relying on the shared ?token= guard.
   * SendGrid has no equivalent signing option for Inbound Parse — that
   * route always uses the token guard (see COMPLIANCE.md).
   */
  eventWebhookPublicKey?: string;
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
 * {reason} (initialGrounded only), {service} (initialUngrounded only),
 * {appointmentTime} (appointmentReminder only, formatted in the tenant's
 * own timezone). Unset fields fall back to the built-in default wording.
 */
export interface MessageTemplates {
  initialGrounded?: string;
  initialUngrounded?: string;
  /** Indexed by follow-up attempt (0 = first follow-up, 1 = second, ...). */
  followUps?: string[];
  /** Sent when a reply classifies as not_interested — a fixed, no-LLM-needed polite close-out. */
  notInterestedCloser?: string;
  /** Sent ~24 hours before a lead's booked appointment (see src/appointmentReminder.ts). */
  appointmentReminder?: string;
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
  /**
   * "active" (default) or "suspended". A suspended tenant's API key is
   * rejected by requireTenantAuth — used to pause a client (e.g. non-
   * payment, an issue under investigation) without deleting their data.
   */
  status?: "active" | "suspended";
  /**
   * Why `status` last changed: "manual" for an admin's own PATCH
   * /admin/tenants/:id, "billing" for an automatic change made by
   * /webhooks/paddle. Purely informational (nothing branches on it) — it
   * exists so the admin UI can show *why* a tenant is suspended (a
   * deliberate hold vs. a payment lapse it might want to follow up on)
   * instead of just the bare status. Unset for a tenant that's never had
   * its status changed since creation (e.g. still on its original
   * "active").
   */
  statusReason?: "manual" | "billing";
  /**
   * Paddle subscription id (`sub_...`) backing this tenant's billing, if
   * any — set once, either by the agency operator or automatically by
   * /webhooks/paddle the first time a subscription event for this tenant
   * arrives. Used as a fallback lookup in that webhook when an event's
   * custom_data doesn't carry a tenantId (see src/paddleVerify.ts /
   * webhooks/index.ts's Paddle route); the primary match is always
   * custom_data.tenantId. Not required for a tenant with no billing
   * integration (e.g. the demo tenant, or one invoiced manually).
   */
  paddleSubscriptionId?: string;
  /**
   * The `occurred_at` timestamp (ISO 8601, as Paddle sends it) of the most
   * recent Paddle webhook event actually applied to this tenant's status —
   * guards against an out-of-order/delayed delivery retry undoing a newer
   * status change. Paddle documents that webhooks can arrive out of order
   * (retries, multiple delivery workers); without this, a slow
   * subscription.past_due (suspend) that finally arrives after a later
   * subscription.activated (reactivate) already processed would silently
   * re-suspend an otherwise-current tenant.
   */
  paddleLastEventAt?: string;
  /**
   * Reference-only business contact info, captured during onboarding to
   * make the tenant list human-readable — none of these are used to
   * actually send/receive messages (that's channels.sms/whatsapp's
   * fromNumber and channels.email's fromEmail, which are real provider
   * credentials, not just a phone number or address typed in here).
   */
  contactPhone?: string;
  contactEmail?: string;
  website?: string;
  /**
   * When the tenant (the business client, not a lead) accepted LeadRecovery's
   * own Terms of Service/Privacy Policy — required before any outbound
   * message actually sends (see src/terms.ts). Unset for a brand-new tenant;
   * pre-existing tenants from before this field existed are grandfathered
   * (backfilled by migration 0013) rather than retroactively blocked.
   */
  termsAcceptedAt?: string;
  /** Which CURRENT_TERMS_VERSION (src/terms.ts) was accepted — lets a future material change require re-acceptance instead of silently carrying over an old agreement. */
  termsVersion?: string;
  /**
   * When the agency operator confirmed (on the client's behalf, at
   * onboarding) that this client has a documented lawful basis to contact
   * every lead it imports — an existing inquiry, a prior customer
   * relationship, explicit opt-in, etc. (see COMPLIANCE.md "Consent
   * basis"). Required to create a tenant at all (POST /admin/tenants
   * rejects a request that doesn't set it); pre-existing tenants from
   * before this field existed are grandfathered (migration 0014) rather
   * than retroactively blocked. This is an audit record of the decision,
   * not something the system can independently verify.
   */
  consentBasisConfirmedAt?: string;
  /**
   * When the agency operator confirmed this client has completed the
   * carrier-side approval required to send SMS/WhatsApp at volume — 10DLC
   * registration (US) and/or WhatsApp Business template approval via
   * Twilio (see COMPLIANCE.md "SMS / WhatsApp (Twilio)"). Unset blocks the
   * sms/whatsapp channels specifically (selectChannel in
   * src/channels/index.ts falls back to email, or skips the lead if none
   * is usable) — email is unaffected, and devMode always bypasses this.
   * Pre-existing tenants are grandfathered (migration 0014).
   */
  carrierApprovalConfirmedAt?: string;
  /**
   * Whether the auto-reply chatbot proactively discloses (in the first
   * auto-reply of a conversation) that the customer is talking to an
   * automated assistant, ahead of being asked — some jurisdictions require
   * this (e.g. California's B.O.T. Act) rather than only disclosing when
   * asked. Defaults to true (recommended) when unset; only takes effect
   * when autoReplyEnabled + knowledgeBase are also configured. See
   * src/chatbot.ts and COMPLIANCE.md "Bot disclosure".
   */
  botDisclosureEnabled?: boolean;
  /**
   * How many days of inactivity after a lead reaches a closed-out status
   * (do_not_contact, unqualified, fraudulent, converted, opted_out) before
   * the worker automatically purges it (and its message history) — a
   * data-retention-limitation control (see COMPLIANCE.md "Data handling").
   * Unset uses DEFAULT_DATA_RETENTION_DAYS (src/dataRetention.ts). Never
   * purges a lead still active in the funnel, regardless of age.
   */
  dataRetentionDays?: number;
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
   * not-interested acknowledgment, "appointment_reminder" = the 24-hours-
   * before nudge (see src/appointmentReminder.ts). Inbound messages leave
   * this unset.
   */
  kind?: "campaign" | "auto_reply" | "closer" | "appointment_reminder";
}
