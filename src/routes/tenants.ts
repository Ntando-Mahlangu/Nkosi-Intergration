import { Router } from "express";
import type { Stores } from "../store/index.js";
import { toPublicTenant, type Lead, type Message, type ReplyClassification, type Tenant } from "../types.js";
import { requireAdminAuth, requireOwnerRole, requireTenantAuth } from "../middleware/auth.js";
import { createAdminLimiter, createTenantLimiter } from "../middleware/rateLimit.js";
import { generateApiKey, generateId } from "../idgen.js";
import { parsePageParams, paginate } from "../pagination.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { isObviouslyUnsafeWebhookHostname } from "../ssrf.js";
import { recordAudit } from "../audit.js";
import { CURRENT_TERMS_VERSION } from "../terms.js";
import { resolveChannelDefaults } from "../channelDefaults.js";
import { MAX_DATA_RETENTION_DAYS, MIN_DATA_RETENTION_DAYS } from "../dataRetention.js";
import { generateFormKey } from "../idgen.js";
import { hashPassword, verifyPassword } from "../password.js";
import { buildResetLink, issuePasswordResetToken, MIN_PASSWORD_LENGTH } from "./auth.js";
import { sendAccountEmail } from "../authEmail.js";
import {
  NUMBER_HOSTING_COMPLETE_STATUS,
  refreshNumberHostingStatus,
  startNumberHosting,
  type NumberHostingAddress,
} from "../numberHosting.js";

const MAX_KNOWLEDGE_BASE_LENGTH = 20_000;

interface TenantConfigBody {
  name?: string;
  timezone?: string;
  quietHours?: Tenant["quietHours"];
  devMode?: boolean;
  channels?: Tenant["channels"];
  notifyWebhookUrl?: string;
  templates?: Tenant["templates"];
  knowledgeBase?: string;
  autoReplyEnabled?: boolean;
  status?: Tenant["status"];
  paddleSubscriptionId?: string | null;
  contactPhone?: string;
  contactEmail?: string;
  website?: string;
  /** Admin-only, required at creation — see validateTenantConfig/POST /admin/tenants. */
  consentBasisConfirmed?: boolean;
  /**
   * Admin-only — an onboarding attestation that the client already agreed
   * to LeadRecovery's Terms of Service/Privacy Policy outside the app. Does
   * NOT set Tenant.termsAcceptedAt — the client's own required in-app
   * acceptance is untouched. See Tenant.termsAttestedAt.
   */
  termsAttested?: boolean;
  /** Admin-only — see PATCH /admin/tenants/:id. */
  carrierApprovalConfirmed?: boolean;
  botDisclosureEnabled?: boolean;
  dataRetentionDays?: number;
  /** The tenant's SaaS-style login identity (src/routes/auth.ts) — distinct from contactEmail, see Tenant.email. Settable by the tenant itself or an admin; `null` clears it. */
  email?: string | null;
  /** The tenant's phone-based login identity (src/routes/auth.ts's /auth/request-code, /auth/verify-code) — distinct from contactPhone, see Tenant.loginPhone. Settable by the tenant itself or an admin; `null` clears it. */
  loginPhone?: string | null;
  /** Opt-in: periodic win-back check-ins for converted, opted-in leads — see Tenant.winBackEnabled. */
  winBackEnabled?: boolean;
  /** Days between win-back check-ins. See Tenant.winBackCooldownDays. */
  winBackCooldownDays?: number;
  /** Opt-in: hours before a stale needs-attention item fires an operator alert. See Tenant.attentionSlaHours. `null` clears it (disables SLA alerting). */
  attentionSlaHours?: number | null;
}

const MAX_CONTACT_FIELD_LENGTH = 320;

/** True if `timezone` is a real IANA zone Intl can resolve — an invalid one throws at quiet-hours-check time otherwise. */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reference-only contact info (contactPhone/contactEmail/website) is
 * deliberately not format-validated — a real business's phone/email/site
 * comes in too many shapes ("call the shop, ask for John", a WhatsApp-only
 * number, no website yet) to reject without being unhelpful. Only a
 * sane length cap, same purpose as knowledgeBase's own cap above.
 */
function isValidContactField(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "string" && value.length <= MAX_CONTACT_FIELD_LENGTH;
}

const MAX_EMAIL_LENGTH = 320;

/**
 * Unlike contactEmail/contactPhone (reference-only, deliberately unvalidated
 * — see isValidContactField), `email` is the tenant's actual login
 * identity: a malformed one is unusable, not just untidy, since the
 * password-reset/set-password link (src/routes/auth.ts) is sent to it. A
 * loose "looks like an email" check, not full RFC 5322 validation.
 */
function isValidEmail(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * `loginPhone` is the tenant's actual login identity (like `email` above) —
 * a malformed one is unusable, since the one-time code (src/routes/auth.ts)
 * is texted to it. Requires strict E.164 (same check as POST
 * /admin/tenants/:id/connect-number's phoneNumber — see isValidE164 below)
 * since Twilio's SMS API requires it anyway.
 */
function isValidLoginPhone(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return isValidE164(value);
}

function isValidQuietHours(quietHours: unknown): quietHours is Tenant["quietHours"] {
  if (quietHours === undefined) return true;
  if (typeof quietHours !== "object" || quietHours === null) return false;
  const { startHour, endHour } = quietHours as Record<string, unknown>;
  const inRange = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 23;
  return inRange(startHour) && inRange(endHour);
}

function isValidWebhookUrl(url: unknown): boolean {
  if (url === undefined) return true;
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    // Synchronous, config-time-only check (no DNS lookup) — catches the
    // obvious "notifyWebhookUrl set to localhost/an internal IP" case
    // immediately with a clear error. The load-bearing protection is the
    // DNS-resolution check deliverNotification does before every actual
    // send (src/ssrf.ts) — a hostname that resolves to an internal address
    // only at delivery time isn't (and can't be) caught here.
    return !isObviouslyUnsafeWebhookHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isValidKnowledgeBase(knowledgeBase: unknown): boolean {
  if (knowledgeBase === undefined) return true;
  return typeof knowledgeBase === "string" && knowledgeBase.length <= MAX_KNOWLEDGE_BASE_LENGTH;
}

function isValidStatus(status: unknown): boolean {
  return status === undefined || status === "active" || status === "suspended";
}

function isValidDataRetentionDays(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_DATA_RETENTION_DAYS &&
    value <= MAX_DATA_RETENTION_DAYS
  );
}

// A non-empty string, i.e. not "" or whitespace-only — a template that
// substitutes to a blank message would otherwise drop the mandatory
// "Reply STOP" opt-out line entirely, and messaging.ts's own
// `tenant.templates?.x ?? DEFAULT` fallback only kicks in for
// null/undefined, never for an explicitly-set "".
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTemplates(templates: unknown): templates is Tenant["templates"] {
  // null is accepted the same as undefined (not just here — every read of
  // tenant.templates elsewhere uses `?.`, which already treats the two the
  // same): explicitly clearing overrides back to the built-in defaults via
  // `{"templates": null}` worked before this function existed at all, and
  // rejecting it now would be a regression, not a new safety check.
  if (templates === undefined || templates === null) return true;
  if (typeof templates !== "object") return false;
  const { initialGrounded, initialUngrounded, followUps, notInterestedCloser, winBack } = templates as Record<
    string,
    unknown
  >;
  if (initialGrounded !== undefined && !isNonEmptyString(initialGrounded)) return false;
  if (initialUngrounded !== undefined && !isNonEmptyString(initialUngrounded)) return false;
  if (notInterestedCloser !== undefined && !isNonEmptyString(notInterestedCloser)) return false;
  if (winBack !== undefined && !isNonEmptyString(winBack)) return false;
  if (followUps !== undefined && (!Array.isArray(followUps) || !followUps.every(isNonEmptyString))) return false;
  return true;
}

const MIN_WIN_BACK_COOLDOWN_DAYS = 30;
const MAX_WIN_BACK_COOLDOWN_DAYS = 3650;

function isValidWinBackCooldownDays(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_WIN_BACK_COOLDOWN_DAYS &&
    value <= MAX_WIN_BACK_COOLDOWN_DAYS
  );
}

const MIN_ATTENTION_SLA_HOURS = 1;
const MAX_ATTENTION_SLA_HOURS = 720; // 30 days

/** Unlike winBackCooldownDays, null is also valid — the explicit way to disable SLA alerting once it was set. */
function isValidAttentionSlaHours(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_ATTENTION_SLA_HOURS &&
    value <= MAX_ATTENTION_SLA_HOURS
  );
}

/**
 * Validates a tenant config patch/create body against the current (pre-merge)
 * tenant state, if any — so e.g. enabling autoReplyEnabled without touching
 * knowledgeBase in this request still checks against the tenant's existing
 * knowledgeBase. Returns an error message, or undefined if valid.
 */
function validateTenantConfig(body: Partial<TenantConfigBody>, existing?: Tenant): string | undefined {
  if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
    return `invalid timezone: ${body.timezone}`;
  }
  if (!isValidQuietHours(body.quietHours)) {
    return "quietHours must be { startHour: 0-23, endHour: 0-23 }";
  }
  if (!isValidWebhookUrl(body.notifyWebhookUrl)) {
    return "notifyWebhookUrl must be a valid http(s) URL";
  }
  if (!isValidKnowledgeBase(body.knowledgeBase)) {
    return `knowledgeBase must be a string up to ${MAX_KNOWLEDGE_BASE_LENGTH} characters`;
  }
  if (!isValidStatus(body.status)) {
    return 'status must be "active" or "suspended"';
  }
  if (!isValidDataRetentionDays(body.dataRetentionDays)) {
    return `dataRetentionDays must be a whole number from ${MIN_DATA_RETENTION_DAYS} to ${MAX_DATA_RETENTION_DAYS}`;
  }
  if (body.botDisclosureEnabled !== undefined && typeof body.botDisclosureEnabled !== "boolean") {
    return "botDisclosureEnabled must be a boolean";
  }
  if (body.carrierApprovalConfirmed !== undefined && typeof body.carrierApprovalConfirmed !== "boolean") {
    return "carrierApprovalConfirmed must be a boolean";
  }
  if (body.termsAttested !== undefined && typeof body.termsAttested !== "boolean") {
    return "termsAttested must be a boolean";
  }
  if (!isValidTemplates(body.templates)) {
    return "templates.initialGrounded/initialUngrounded/notInterestedCloser must be non-empty strings, and followUps (if set) an array of non-empty strings";
  }
  if (
    !isValidContactField(body.contactPhone) ||
    !isValidContactField(body.contactEmail) ||
    !isValidContactField(body.website)
  ) {
    return `contactPhone/contactEmail/website must be strings up to ${MAX_CONTACT_FIELD_LENGTH} characters`;
  }
  if (!isValidEmail(body.email)) {
    return `email must look like a real email address, up to ${MAX_EMAIL_LENGTH} characters`;
  }
  if (!isValidLoginPhone(body.loginPhone)) {
    return "loginPhone must be in E.164 format (e.g. +15551234567)";
  }
  if (body.winBackEnabled !== undefined && typeof body.winBackEnabled !== "boolean") {
    return "winBackEnabled must be a boolean";
  }
  if (!isValidWinBackCooldownDays(body.winBackCooldownDays)) {
    return `winBackCooldownDays must be a whole number from ${MIN_WIN_BACK_COOLDOWN_DAYS} to ${MAX_WIN_BACK_COOLDOWN_DAYS}`;
  }
  if (!isValidAttentionSlaHours(body.attentionSlaHours)) {
    return `attentionSlaHours must be a whole number from ${MIN_ATTENTION_SLA_HOURS} to ${MAX_ATTENTION_SLA_HOURS}, or null to disable it`;
  }
  // null is allowed through (same precedent as templates above) so the
  // admin API has a way to explicitly clear a tenant's subscription link.
  if (
    body.paddleSubscriptionId !== undefined &&
    body.paddleSubscriptionId !== null &&
    !isNonEmptyString(body.paddleSubscriptionId)
  ) {
    return "paddleSubscriptionId must be a non-empty string, or null to clear it";
  }
  const mergedKnowledgeBase = body.knowledgeBase !== undefined ? body.knowledgeBase : existing?.knowledgeBase;
  const mergedAutoReplyEnabled =
    body.autoReplyEnabled !== undefined ? body.autoReplyEnabled : existing?.autoReplyEnabled;
  if (mergedAutoReplyEnabled && !mergedKnowledgeBase?.trim()) {
    return "autoReplyEnabled requires a non-empty knowledgeBase";
  }
  return undefined;
}

function buildTenantPatch(
  body: Partial<TenantConfigBody>,
  { includeStatus }: { includeStatus: boolean }
): Partial<Tenant> {
  const patch: Partial<Tenant> = {};
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.quietHours !== undefined) patch.quietHours = body.quietHours;
  if (body.devMode !== undefined) patch.devMode = body.devMode;
  if (body.channels !== undefined) patch.channels = body.channels;
  if (body.notifyWebhookUrl !== undefined) patch.notifyWebhookUrl = body.notifyWebhookUrl;
  if (body.templates !== undefined) patch.templates = body.templates;
  if (body.knowledgeBase !== undefined) patch.knowledgeBase = body.knowledgeBase;
  if (body.autoReplyEnabled !== undefined) patch.autoReplyEnabled = body.autoReplyEnabled;
  if (body.contactPhone !== undefined) patch.contactPhone = body.contactPhone;
  if (body.contactEmail !== undefined) patch.contactEmail = body.contactEmail;
  if (body.website !== undefined) patch.website = body.website;
  if (body.botDisclosureEnabled !== undefined) patch.botDisclosureEnabled = body.botDisclosureEnabled;
  if (body.dataRetentionDays !== undefined) patch.dataRetentionDays = body.dataRetentionDays;
  // Trimmed for the same lookup-integrity reason as paddleSubscriptionId
  // below; null/empty clears it (same "explicitly clear" precedent as
  // templates/paddleSubscriptionId elsewhere in this function).
  if (body.email !== undefined) patch.email = body.email ? body.email.trim() : undefined;
  if (body.loginPhone !== undefined) patch.loginPhone = body.loginPhone ? body.loginPhone.trim() : undefined;
  if (body.winBackEnabled !== undefined) patch.winBackEnabled = body.winBackEnabled;
  if (body.winBackCooldownDays !== undefined) patch.winBackCooldownDays = body.winBackCooldownDays;
  if (body.attentionSlaHours !== undefined) patch.attentionSlaHours = body.attentionSlaHours ?? undefined;
  // Admin-only (gated the same as status/paddleSubscriptionId below) — the
  // agency operator sets this after independently verifying 10DLC/WhatsApp
  // approval with the client, not something a tenant self-attests via
  // PATCH /tenants/me. true records a fresh confirmation timestamp; false
  // clears it (e.g. approval lapsed/was revoked).
  if (includeStatus && body.carrierApprovalConfirmed !== undefined) {
    patch.carrierApprovalConfirmedAt = body.carrierApprovalConfirmed ? new Date().toISOString() : undefined;
  }
  // Gated the same as status: both are billing/access-control state that
  // only an admin sets, never the tenant itself via PATCH /tenants/me — a
  // tenant setting its own paddleSubscriptionId could let it get matched
  // (and have its status flipped) by a *different* tenant's Paddle events
  // whenever those happen to omit custom_data.tenantId (see
  // /webhooks/paddle's fallback lookup in webhooks/index.ts).
  if (includeStatus && body.status !== undefined) {
    patch.status = body.status;
    // So the admin UI can tell a deliberate hold apart from an automatic
    // /webhooks/paddle billing suspension — see Tenant.statusReason's own
    // doc comment. An admin PATCH always means "manual", even if it happens
    // to set the tenant back to the same status Paddle last set it to.
    patch.statusReason = "manual";
  }
  // Trimmed so incidental whitespace can't break an exact-match lookup
  // (getTenantByPaddleSubscriptionId, or the conflict check above); null
  // collapses to undefined, which is how a patch clears the field (same
  // precedent as templates elsewhere in this file).
  if (includeStatus && body.paddleSubscriptionId !== undefined) {
    patch.paddleSubscriptionId =
      typeof body.paddleSubscriptionId === "string" ? body.paddleSubscriptionId.trim() : undefined;
  }
  return patch;
}

/**
 * Returns an error message if `paddleSubscriptionId` already belongs to a
 * *different* tenant — migration 0009's partial unique index backs this up
 * at the DB layer too (so this can never be bypassed even by a bug here),
 * but that would surface as an opaque constraint-violation error; this
 * gives a clear 400 instead. Two tenants sharing one subscription id would
 * make /webhooks/paddle's fallback lookup (getTenantByPaddleSubscriptionId)
 * match an arbitrary one of them.
 */
async function checkPaddleSubscriptionIdConflict(
  tenantStore: Stores["tenantStore"],
  paddleSubscriptionId: string | null | undefined,
  excludeTenantId?: string
): Promise<string | undefined> {
  // Trimmed for the same reason buildTenantPatch trims it: an untrimmed
  // lookup value would never match the trimmed value actually stored.
  const trimmed = typeof paddleSubscriptionId === "string" ? paddleSubscriptionId.trim() : undefined;
  if (!trimmed) return undefined;
  const existing = await tenantStore.getTenantByPaddleSubscriptionId(trimmed);
  if (existing && existing.id !== excludeTenantId) {
    return `paddleSubscriptionId "${trimmed}" is already assigned to tenant ${existing.id}`;
  }
  return undefined;
}

interface ConnectNumberBody {
  /** The client's own existing number, in E.164 format — this is what gets hosted, never a newly purchased one. */
  phoneNumber?: string;
  contactEmail?: string;
  address?: Partial<NumberHostingAddress>;
}

function isValidE164(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value);
}

/** Validates POST /admin/tenants/:id/connect-number's body. Returns an error message, or undefined if valid. */
function validateConnectNumberBody(body: ConnectNumberBody): string | undefined {
  if (!isValidE164(body.phoneNumber)) {
    return "phoneNumber must be in E.164 format (e.g. +15551234567) — the client's own existing number, not a new one";
  }
  if (!isValidEmail(body.contactEmail) || !body.contactEmail) {
    return "contactEmail is required — Twilio uses it for order updates and, if required, a Letter of Authorization to sign";
  }
  const a = body.address;
  if (
    !a ||
    !isNonEmptyString(a.customerName) ||
    !isNonEmptyString(a.street) ||
    !isNonEmptyString(a.city) ||
    !isNonEmptyString(a.region) ||
    !isNonEmptyString(a.postalCode) ||
    !isNonEmptyString(a.isoCountry)
  ) {
    return "address.customerName/street/city/region/postalCode/isoCountry are all required (the business's registered address, for Twilio's regulatory record)";
  }
  return undefined;
}

/** Same idea as checkPaddleSubscriptionIdConflict, for `email` — migration 0015's partial unique index backs this up at the DB layer too. */
/**
 * Checked against both the tenant-owner login table AND the team-member
 * table (see "Team accounts") — without the second check, a tenant could
 * set its own login email to one a `TenantUser` already owns in a
 * *different* tenant. `/auth/login`/`/auth/forgot-password` both resolve
 * the tenant-owner table first, so that collision wouldn't just break the
 * team member's own login — a forgot-password request from their own inbox
 * would hand them a reset link for the *other* tenant's real apiKey
 * instead, a genuine cross-tenant access violation, not merely a lockout.
 */
async function checkEmailConflict(
  tenantStore: Stores["tenantStore"],
  tenantUserStore: Stores["tenantUserStore"],
  email: string | null | undefined,
  excludeTenantId?: string
): Promise<string | undefined> {
  const trimmed = typeof email === "string" ? email.trim() : undefined;
  if (!trimmed) return undefined;
  const existingTenant = await tenantStore.getTenantByEmail(trimmed);
  if (existingTenant && existingTenant.id !== excludeTenantId) {
    return `email "${trimmed}" is already in use by another tenant`;
  }
  const existingTenantUser = await tenantUserStore.getTenantUserByEmail(trimmed);
  if (existingTenantUser) {
    return `email "${trimmed}" is already in use by a team account`;
  }
  return undefined;
}

/** Same idea as checkEmailConflict, for `loginPhone` — migration 0017's unique index backs this up at the DB layer too. */
async function checkLoginPhoneConflict(
  tenantStore: Stores["tenantStore"],
  loginPhone: string | null | undefined,
  excludeTenantId?: string
): Promise<string | undefined> {
  const trimmed = typeof loginPhone === "string" ? loginPhone.trim() : undefined;
  if (!trimmed) return undefined;
  const existing = await tenantStore.getTenantByLoginPhone(trimmed);
  if (existing && existing.id !== excludeTenantId) {
    return `loginPhone "${trimmed}" is already in use by another tenant`;
  }
  return undefined;
}

/**
 * Tenant self-service (`/tenants/me`, `PATCH /tenants/me`) and admin tenant
 * management (`/admin/tenants`, gated by ADMIN_API_KEY). The admin routes
 * are how a new client gets onboarded programmatically; `npm run onboard`
 * wraps this same flow in an interactive CLI.
 */
export function createTenantRoutes({
  tenantStore,
  tenantUserStore,
  leadStore,
  messageStore,
  notificationStore,
  auditLogStore,
}: Stores): Router {
  const router = Router();
  const tenantAuth = requireTenantAuth(tenantStore, tenantUserStore);
  const ownerOnly = requireOwnerRole();
  const adminAuth = requireAdminAuth();

  router.get(
    "/tenants/me",
    createTenantLimiter(),
    tenantAuth,
    asyncHandler(async (req, res) => {
      let tenant = req.tenant!;
      // Lazily backfills a pre-existing tenant (created before publicFormKey
      // existed) instead of a data migration generating one for every row —
      // see migration 0015's own comment on why. Harmless to do on every
      // read that happens to hit an unbackfilled row; only ever runs once
      // per tenant.
      if (!tenant.publicFormKey) {
        tenant = (await tenantStore.updateTenant(tenant.id, { publicFormKey: generateFormKey() })) ?? tenant;
      }
      res.json(toPublicTenant(tenant));
    })
  );

  // Records the tenant's (the business client's, not a lead's) acceptance of
  // LeadRecovery's own Terms of Service/Privacy Policy — required before any
  // outbound message actually sends (see worker.ts, webhooks/index.ts, and
  // POST /workflow/run). Only accepts the exact current version so a client
  // can't "accept" a version this deployment doesn't currently offer, and
  // so a future material change can require re-acceptance instead of
  // silently carrying an old agreement forward.
  router.post(
    "/tenants/me/accept-terms",
    createTenantLimiter(),
    tenantAuth,
    asyncHandler(async (req, res) => {
      const tenant = req.tenant!;
      const version = req.body?.version;
      if (version !== CURRENT_TERMS_VERSION) {
        res.status(400).json({
          error: `version must be the current terms version ("${CURRENT_TERMS_VERSION}")`,
        });
        return;
      }
      const updated = await tenantStore.updateTenant(tenant.id, {
        termsAcceptedAt: new Date().toISOString(),
        termsVersion: version,
      });
      res.json(toPublicTenant(updated!));
    })
  );

  // Self-service password change while already authenticated via API key —
  // the alternative to the emailed set-password/forgot-password link
  // (src/routes/auth.ts) for a tenant that's already signed in and just
  // wants to set/change its password directly. Requires the current
  // password *if* one is already set (proves the caller, who could be
  // anyone holding the API key, actually knows it too) — first-time setup
  // for a tenant that's never had a password needs none, since simply
  // holding the API key already proves the same level of access a brand
  // new password would grant.
  router.post(
    "/tenants/me/change-password",
    createTenantLimiter(),
    tenantAuth,
    ownerOnly,
    asyncHandler(async (req, res) => {
      const tenant = req.tenant!;
      const { currentPassword, newPassword } = (req.body ?? {}) as {
        currentPassword?: unknown;
        newPassword?: unknown;
      };
      if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` });
        return;
      }
      if (tenant.passwordHash) {
        if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, tenant.passwordHash))) {
          res.status(401).json({ error: "currentPassword is incorrect" });
          return;
        }
      }
      const passwordHash = await hashPassword(newPassword);
      await tenantStore.updateTenant(tenant.id, { passwordHash });
      res.json({ ok: true });
    })
  );

  // A summary the tenant (or whoever runs this on their behalf) can use for
  // "what did this cost/deliver this period" reporting — e.g. a monthly
  // retainer's activity report — without hand-computing it from GET /leads
  // and message history. `leads` is always a current pipeline-health
  // snapshot (not date-filtered); `messages` is activity within the
  // optional [since, until] window, which is what a billing-period report
  // actually wants ("what happened this month"), not "what leads happen to
  // have been created this month."
  router.get(
    "/tenants/me/report",
    createTenantLimiter(),
    tenantAuth,
    asyncHandler(async (req, res) => {
      const tenant = req.tenant!;
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const until = typeof req.query.until === "string" ? req.query.until : undefined;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        res.status(400).json({ error: "since must be a valid ISO date" });
        return;
      }
      if (until !== undefined && Number.isNaN(Date.parse(until))) {
        res.status(400).json({ error: "until must be a valid ISO date" });
        return;
      }

      // Independent queries — fetch concurrently rather than paying for two
      // sequential round trips to the store.
      const [leads, messages] = await Promise.all([
        leadStore.getAllLeads(tenant.id),
        messageStore.listForTenant(tenant.id, { since, until }),
      ]);

      const leadsByStatus: Partial<Record<Lead["status"], number>> = {};
      for (const lead of leads) {
        leadsByStatus[lead.status] = (leadsByStatus[lead.status] ?? 0) + 1;
      }

      let outboundSent = 0;
      const outboundByKind: Partial<Record<NonNullable<Message["kind"]>, number>> = {};
      let inboundReceived = 0;
      const inboundByClassification: Partial<Record<ReplyClassification | "unclassified", number>> = {};
      for (const message of messages) {
        if (message.direction === "outbound") {
          outboundSent++;
          const kind = message.kind ?? "campaign";
          outboundByKind[kind] = (outboundByKind[kind] ?? 0) + 1;
        } else {
          inboundReceived++;
          const classification = message.classification ?? "unclassified";
          inboundByClassification[classification] = (inboundByClassification[classification] ?? 0) + 1;
        }
      }

      res.json({
        range: { since: since ?? null, until: until ?? null },
        leads: { total: leads.length, byStatus: leadsByStatus },
        messages: { outboundSent, outboundByKind, inboundReceived, inboundByClassification },
      });
    })
  );

  // Self-service settings: a tenant can update its own operational config
  // (timezone/quiet hours/devMode/channel credentials/notification hook/
  // message templates/chatbot) using its own API key. id/apiKey/createdAt/
  // status are immutable here — a tenant can't un-suspend itself, and API
  // key rotation goes through the admin API.
  router.patch(
    "/tenants/me",
    createTenantLimiter(),
    tenantAuth,
    ownerOnly,
    asyncHandler(async (req, res) => {
      const tenant = req.tenant!;
      const body = req.body as Partial<TenantConfigBody>;

      if (body.status !== undefined) {
        res.status(400).json({ error: "status can only be changed via the admin API" });
        return;
      }
      if (body.paddleSubscriptionId !== undefined) {
        res.status(400).json({ error: "paddleSubscriptionId can only be changed via the admin API" });
        return;
      }
      const error = validateTenantConfig(body, tenant);
      if (error) {
        res.status(400).json({ error });
        return;
      }
      const emailConflict = await checkEmailConflict(tenantStore, tenantUserStore, body.email, tenant.id);
      if (emailConflict) {
        res.status(400).json({ error: emailConflict });
        return;
      }
      const loginPhoneConflict = await checkLoginPhoneConflict(tenantStore, body.loginPhone, tenant.id);
      if (loginPhoneConflict) {
        res.status(400).json({ error: loginPhoneConflict });
        return;
      }
      // Same validation/shared-default-filling POST /admin/tenants already
      // applies to `channels` — without this, a PATCH could store a channel
      // POST would have rejected (e.g. fromNumber with no accountSid/
      // authToken and no shared default configured), which then fails at
      // send time instead of at config time, and silently consumes the
      // lead's preferred-channel slot instead of a workflow falling back to
      // another channel it *can* actually send on.
      if (body.channels !== undefined) {
        const { channels, error: channelsError } = resolveChannelDefaults(body.channels);
        if (channelsError) {
          res.status(400).json({ error: channelsError });
          return;
        }
        body.channels = channels;
      }

      const updated = await tenantStore.updateTenant(tenant.id, buildTenantPatch(body, { includeStatus: false }));
      res.json(toPublicTenant(updated!));
    })
  );

  // Optional ?limit=&offset= pagination; omitted (the default) returns everything, unchanged from before.
  router.get(
    "/admin/tenants",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const tenants = await tenantStore.listTenants();
      res.set("X-Total-Count", String(tenants.length));
      res.json(paginate(tenants, parsePageParams(req)).map(toPublicTenant));
    })
  );

  router.post(
    "/admin/tenants",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const body = req.body as Partial<TenantConfigBody>;
      if (!body.name || !body.timezone) {
        res.status(400).json({ error: "name and timezone are required" });
        return;
      }
      const error = validateTenantConfig(body);
      if (error) {
        res.status(400).json({ error });
        return;
      }
      const conflict = await checkPaddleSubscriptionIdConflict(tenantStore, body.paddleSubscriptionId);
      if (conflict) {
        res.status(400).json({ error: conflict });
        return;
      }
      const emailConflict = await checkEmailConflict(tenantStore, tenantUserStore, body.email);
      if (emailConflict) {
        res.status(400).json({ error: emailConflict });
        return;
      }
      const loginPhoneConflict = await checkLoginPhoneConflict(tenantStore, body.loginPhone);
      if (loginPhoneConflict) {
        res.status(400).json({ error: loginPhoneConflict });
        return;
      }

      const { channels, error: channelsError } = resolveChannelDefaults(body.channels);
      if (channelsError) {
        res.status(400).json({ error: channelsError });
        return;
      }

      const tenant: Tenant = {
        id: generateId("tenant"),
        name: body.name,
        apiKey: generateApiKey(),
        timezone: body.timezone,
        quietHours: body.quietHours,
        devMode: body.devMode ?? false,
        channels,
        notifyWebhookUrl: body.notifyWebhookUrl,
        templates: body.templates,
        knowledgeBase: body.knowledgeBase,
        autoReplyEnabled: body.autoReplyEnabled ?? false,
        status: "active",
        paddleSubscriptionId:
          typeof body.paddleSubscriptionId === "string" ? body.paddleSubscriptionId.trim() : undefined,
        contactPhone: body.contactPhone,
        contactEmail: body.contactEmail,
        website: body.website,
        // Not enforced as an API-level requirement (that would hard-block
        // the CLI onboarding tool, CI, and any direct integration that
        // predates this field) — but the admin UI's "Add new client" form
        // requires checking this box before it will submit at all. Calling
        // the API directly without it leaves the tenant visibly unconfirmed
        // (GET /admin/tenants shows consentBasisConfirmedAt: null) rather
        // than silently assuming it was checked. See COMPLIANCE.md "Consent basis".
        consentBasisConfirmedAt: body.consentBasisConfirmed ? new Date().toISOString() : undefined,
        // Same "UI-level gate, not an API-level hard-block" treatment as
        // consentBasisConfirmed above — and this specifically does NOT set
        // termsAcceptedAt, which stays gated behind the client's own
        // required in-app acceptance. See Tenant.termsAttestedAt.
        termsAttestedAt: body.termsAttested ? new Date().toISOString() : undefined,
        carrierApprovalConfirmedAt: body.carrierApprovalConfirmed ? new Date().toISOString() : undefined,
        botDisclosureEnabled: body.botDisclosureEnabled,
        dataRetentionDays: body.dataRetentionDays,
        email: typeof body.email === "string" ? body.email.trim() : undefined,
        loginPhone: typeof body.loginPhone === "string" ? body.loginPhone.trim() : undefined,
        winBackEnabled: body.winBackEnabled ?? false,
        winBackCooldownDays: body.winBackCooldownDays,
        attentionSlaHours: body.attentionSlaHours ?? undefined,
        // Every tenant gets one at creation — see Tenant.publicFormKey.
        publicFormKey: generateFormKey(),
        createdAt: new Date().toISOString(),
      };

      const created = await tenantStore.createTenant(tenant);
      await recordAudit(auditLogStore, {
        tenantId: created.id,
        action: "tenant.create",
        actor: req.adminActor ?? "admin",
        details: { name: created.name, timezone: created.timezone },
      });

      // A SaaS-style sign-in needs a password before it's usable — rather
      // than the agency operator ever typing/knowing a client's password,
      // the client sets their own via the same emailed link
      // POST /auth/forgot-password later re-sends, just triggered
      // automatically here instead of tenant-initiated.
      let passwordSetupLink: string | undefined;
      if (created.email) {
        const token = await issuePasswordResetToken(tenantStore, created.id);
        passwordSetupLink = buildResetLink(token);
        await sendAccountEmail(
          created.email,
          `Set your LeadRecovery password for ${created.name}`,
          `Set your password (expires in 24 hours) to sign in at ${created.name}'s LeadRecovery dashboard:\n\n${passwordSetupLink}`
        );
      }

      // Only place the raw API key (and, if set, the password-setup link)
      // is ever returned — the client must save it now.
      res.status(201).json({ ...toPublicTenant(created), apiKey: created.apiKey, passwordSetupLink });
    })
  );

  // Admin update — the only way to change a tenant's status (e.g. suspend for
  // non-payment or while an issue is investigated) or edit config on a
  // client's behalf without needing their API key.
  router.patch(
    "/admin/tenants/:id",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const existing = await tenantStore.getTenant(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such tenant" });
        return;
      }
      const body = req.body as Partial<TenantConfigBody>;
      const error = validateTenantConfig(body, existing);
      if (error) {
        res.status(400).json({ error });
        return;
      }
      const conflict = await checkPaddleSubscriptionIdConflict(tenantStore, body.paddleSubscriptionId, existing.id);
      if (conflict) {
        res.status(400).json({ error: conflict });
        return;
      }
      const emailConflict = await checkEmailConflict(tenantStore, tenantUserStore, body.email, existing.id);
      if (emailConflict) {
        res.status(400).json({ error: emailConflict });
        return;
      }
      const loginPhoneConflict = await checkLoginPhoneConflict(tenantStore, body.loginPhone, existing.id);
      if (loginPhoneConflict) {
        res.status(400).json({ error: loginPhoneConflict });
        return;
      }
      // Same validation/shared-default-filling as POST /admin/tenants and
      // PATCH /tenants/me — see that route's own comment for why this can't
      // be skipped here.
      if (body.channels !== undefined) {
        const { channels, error: channelsError } = resolveChannelDefaults(body.channels);
        if (channelsError) {
          res.status(400).json({ error: channelsError });
          return;
        }
        body.channels = channels;
      }

      const updated = await tenantStore.updateTenant(req.params.id, buildTenantPatch(body, { includeStatus: true }));
      await recordAudit(auditLogStore, {
        tenantId: req.params.id,
        action: "tenant.admin_update",
        actor: req.adminActor ?? "admin",
        // Field names only — never the values, so this never duplicates a
        // credential/secret into a second store.
        details: { fieldsChanged: Object.keys(body) },
      });
      res.json(toPublicTenant(updated!));
    })
  );

  // Rotates a tenant's API key without touching anything else — the old key
  // stops working immediately. Use this instead of delete+recreate when a
  // key has leaked; the tenant keeps its id, leads, and message history.
  router.post(
    "/admin/tenants/:id/rotate-key",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const existing = await tenantStore.getTenant(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such tenant" });
        return;
      }
      const updated = await tenantStore.updateTenant(req.params.id, { apiKey: generateApiKey() });
      await recordAudit(auditLogStore, {
        tenantId: req.params.id,
        action: "tenant.key_rotate",
        actor: req.adminActor ?? "admin",
      });
      // Only place the new raw API key is ever returned — the client must save it now.
      res.json({ ...toPublicTenant(updated!), apiKey: updated!.apiKey });
    })
  );

  // "Connect this client's existing number" — the missedcall.io-style
  // alternative to assigning a brand new number from the agency's Twilio
  // pool: hosts SMS on the number the client already gives out to
  // customers, on the shared Twilio account. Ownership/consent is proven by
  // Twilio's own verification call to that number, not a code typed into
  // this app — see src/numberHosting.ts's own comment for the full flow and
  // why the remaining steps (LOA e-sign if required, carrier processing)
  // can take real time.
  router.post(
    "/admin/tenants/:id/connect-number",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const existing = await tenantStore.getTenant(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such tenant" });
        return;
      }
      const body = (req.body ?? {}) as ConnectNumberBody;
      const error = validateConnectNumberBody(body);
      if (error) {
        res.status(400).json({ error });
        return;
      }

      let result;
      try {
        result = await startNumberHosting({
          phoneNumber: body.phoneNumber!,
          contactEmail: body.contactEmail!,
          address: body.address as NumberHostingAddress,
        });
      } catch (err) {
        res
          .status(502)
          .json({ error: err instanceof Error ? err.message : "failed to start number hosting with Twilio" });
        return;
      }

      const now = new Date().toISOString();
      const updated = await tenantStore.updateTenant(existing.id, {
        numberHostingOrder: {
          orderSid: result.orderSid,
          phoneNumber: result.phoneNumber,
          status: result.status,
          nextStep: result.nextStep,
          failureReason: result.failureReason,
          createdAt: now,
          updatedAt: now,
        },
      });
      await recordAudit(auditLogStore, {
        tenantId: existing.id,
        action: "tenant.connect_number",
        actor: req.adminActor ?? "admin",
        details: { phoneNumber: result.phoneNumber, orderSid: result.orderSid },
      });
      res.status(201).json(toPublicTenant(updated!));
    })
  );

  // Re-checks an in-progress order's status with Twilio. Once it reaches
  // "completed", the client's own number is live for SMS — this immediately
  // starts using it (same shared-account resolution POST /admin/tenants
  // already applies to a manually-assigned number) instead of requiring a
  // second manual step to actually turn the channel on.
  router.post(
    "/admin/tenants/:id/connect-number/refresh",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const existing = await tenantStore.getTenant(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such tenant" });
        return;
      }
      if (!existing.numberHostingOrder) {
        res.status(400).json({ error: "this tenant has no number-hosting order in progress" });
        return;
      }

      let result;
      try {
        result = await refreshNumberHostingStatus(existing.numberHostingOrder.orderSid);
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : "failed to check status with Twilio" });
        return;
      }

      const patch: Partial<Tenant> = {
        numberHostingOrder: {
          ...existing.numberHostingOrder,
          status: result.status,
          nextStep: result.nextStep,
          failureReason: result.failureReason,
          updatedAt: new Date().toISOString(),
        },
      };
      if (result.status === NUMBER_HOSTING_COMPLETE_STATUS && !existing.channels.sms) {
        // resolveChannelDefaults's own runtime logic (resolveTwilioChannel)
        // accepts a bare fromNumber and fills in the shared account's
        // accountSid/authToken — its declared parameter type just doesn't
        // reflect that partial-input tolerance, hence the cast.
        const { channels, error: channelsError } = resolveChannelDefaults({
          ...existing.channels,
          sms: { fromNumber: result.phoneNumber } as Tenant["channels"]["sms"],
        });
        if (!channelsError) patch.channels = channels;
      }

      const updated = await tenantStore.updateTenant(existing.id, patch);
      res.json(toPublicTenant(updated!));
    })
  );

  // Permanently removes a tenant. In Postgres this cascades to the tenant's
  // leads and messages (ON DELETE CASCADE) — there is no undo.
  router.delete(
    "/admin/tenants/:id",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const deleted = await tenantStore.deleteTenant(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "no such tenant" });
        return;
      }
      await recordAudit(auditLogStore, {
        tenantId: req.params.id,
        action: "tenant.delete",
        actor: req.adminActor ?? "admin",
      });
      res.status(204).send();
    })
  );

  // Visibility into notify.ts's dead-letter queue: notifications ("interested"
  // replies / chatbot escalations) that failed to reach a tenant's
  // notifyWebhookUrl even after retries. "pending" ones are still being
  // retried by the worker each tick; "dead" ones gave up after
  // NOTIFICATION_MAX_ATTEMPTS and need a human to notice (usually a broken
  // notifyWebhookUrl) and fix the target, at which point new notifications
  // succeed again — this endpoint is how you'd notice in the first place.
  router.get(
    "/admin/notifications/failed",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (_req, res) => {
      res.json(await notificationStore.listAll());
    })
  );

  // Optional ?limit=&offset= pagination; omitted returns everything.
  router.get(
    "/admin/audit-log",
    createAdminLimiter(),
    adminAuth,
    asyncHandler(async (req, res) => {
      const total = await auditLogStore.count();
      res.set("X-Total-Count", String(total));
      res.json(await auditLogStore.list(parsePageParams(req)));
    })
  );

  return router;
}
