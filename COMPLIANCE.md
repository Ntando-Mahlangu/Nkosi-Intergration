# Compliance checklist

LeadRecovery enforces what it can in code (suppression rules, quiet hours,
instant opt-out handling, never fabricating a contact reason). The items
below are manual, legal, or provider-side steps the code cannot do for you —
work through this with each client before their first real send. **This is
not legal advice** — confirm requirements with the client's own counsel for
their jurisdiction and industry; rules differ meaningfully between, e.g.,
the US (TCPA), the EU/UK (GDPR + PECR), and South Africa (POPIA), and this
document is not a substitute for that review.

## Your own Terms of Service / Privacy Policy

Distinct from lead consent below: this is the agreement between your
agency and the business client using LeadRecovery, not between the client
and their own leads.

- `public/terms.html`/`public/privacy.html` are a starting-point draft
  (see the notice at the top of each) — replace every bracketed
  placeholder and have a lawyer review both before onboarding real
  clients. They cover service description, the client's own responsibility
  for lawful outbound messaging, liability limits, and data handling.
- The client accepts these themselves, on their own first login (a
  blocking gate on every dashboard) — not something you tick on their
  behalf during onboarding. `POST /workflow/run`, the worker, and every
  inbound webhook's auto-reply all refuse to send for a tenant that
  hasn't accepted, so this isn't just a UI formality.
- The admin UI's "Add new client" form separately requires checking a
  "Client has reviewed and agreed to the Terms of Service and Privacy
  Policy" box before it will create the tenant at all — a recorded
  onboarding attestation (`Tenant.termsAttestedAt`) that the agreement
  already happened outside the app (a sales call, a signed contract).
  This is a record for your own files, **not** a substitute for the
  client's own in-app acceptance above: it never sets
  `termsAcceptedAt`, so the client still sees the real blocking gate —
  and still has to click through it themselves — the first time they
  sign in.
- A pre-existing tenant (from before this consent step existed) is
  grandfathered rather than retroactively blocked — see migration 0013.
- Bump `CURRENT_TERMS_VERSION` (`src/terms.ts`) and update both pages
  whenever a change is material enough that existing acceptances
  shouldn't silently carry over — every tenant is then prompted to accept
  again before their next send.

## Consent basis

- Confirm *why* the business is allowed to contact each imported lead (an
  existing inquiry, a prior customer relationship, explicit marketing
  opt-in, etc.). "They filled out a form two years ago" may or may not be a
  valid basis depending on jurisdiction and how long ago that was — this is
  a business/legal decision, not a technical one, and nothing in the code
  can verify it for you.
- **South Africa (POPIA)**: unlike the US's opt-out-based TCPA model, POPIA
  section 69 requires **opt-in** consent before direct marketing by
  electronic communication (SMS/WhatsApp/email), with a narrow exception
  for marketing your own similar products/services to an existing
  customer who was given a clear opt-out at the time their details were
  collected. "This lead enquired about a quote" is a more defensible basis
  for transactional/recovery messaging than for ongoing marketing — confirm
  with the client which bucket their outreach actually falls into, and
  don't assume the TCPA-style "no opt-in needed unless they've opted out"
  framing applies. A South African client should also have (or appoint) an
  Information Officer registered with the Information Regulator, per
  POPIA's registration requirement.
- The admin UI's "Add new client" form requires checking a "Client has a
  documented lawful basis to contact its leads" box before it will create
  the tenant — a recorded attestation (`Tenant.consentBasisConfirmedAt`),
  not a formality. Calling `POST /admin/tenants` directly without
  `consentBasisConfirmed: true` still works (so the onboarding CLI, CI, and
  existing integrations aren't hard-blocked) but leaves the tenant visibly
  unconfirmed in `GET /admin/tenants` — treat that as a follow-up item, not
  a pass.
- Load any existing do-not-contact/opt-out list **before** the first import
  (see `ONBOARDING.md` step 2).

## Win-back messaging for past customers

Distinct from everything above: re-contacting a lead *after* it's already
converted into a paying customer. `checkSuppression`/the ordinary
recovery and follow-up logic never does this — a converted lead is treated
as closed out, the same as unqualified/fraudulent — so this is a separate,
deliberately-opt-in feature (`Tenant.winBackEnabled` +
`Lead.marketingOptIn`, see `src/winback.ts`), off by default.

- **This is direct marketing to an existing customer, not the original
  transactional outreach** — most jurisdictions' rules for it differ from
  the rules for the initial "you asked about X" message. Under POPIA in
  particular, section 69's opt-in requirement applies squarely here even
  where the client's original consent basis for the one-off recovery
  message was lighter-touch (e.g. "they enquired, so a single factual
  follow-up is fine"). Don't let `consentBasisConfirmedAt` (a tenant-level,
  onboarding-time attestation about the *original* outreach) stand in for
  this.
- **Enforced per-lead, not just per-tenant.** Turning on
  `Tenant.winBackEnabled` in Settings messages no one by itself — a lead is
  only ever included once someone has separately recorded, on that specific
  lead, that they personally agreed to it (`Lead.marketingOptIn`, settable
  from the lead's detail view in the dashboard, or via
  `POST /leads/:id/convert` / `PATCH /leads/:id`). There's no bulk "opt
  everyone in" action by design — this is meant to force a real,
  lead-by-lead decision, not a global toggle a client can flip without
  thinking about each customer.
- **Low-frequency by construction**: `winBackCooldownDays` (default 180,
  minimum 30) gates how often one lead can be re-contacted this way, and a
  win-back check-in is always deferred rather than sent during quiet hours
  (unlike an appointment reminder, nothing about it is time-sensitive).
- Same STOP/opt-out handling as everywhere else: a reply classified `stop`
  flips the lead's status away from `converted` immediately, which removes
  it from win-back eligibility (it checks `status === "converted"`
  directly) permanently, same as it does for the ordinary follow-up queue.
- Marking a lead "converted" (`POST /leads/:id/convert`) is otherwise a
  simple business-outcome record — it doesn't by itself imply or grant
  marketing consent, which is exactly why `marketingOptIn` is a separate,
  independent field on the same request/lead rather than being bundled in.

## SMS / WhatsApp (Twilio)

- **10DLC registration** (US): required before sending SMS at any volume
  from a US long-code number, or messages get filtered/blocked by carriers.
  Register the client's brand and campaign in the Twilio console — this has
  a review lead time (days), start it early.
- **South Africa**: there's no 10DLC-equivalent brand/campaign registration
  — SMS/WhatsApp sending is governed by ICASA's telecoms rules and Twilio's
  own South African long-code/sender-ID requirements instead. Confirm with
  Twilio support what number type (local long code vs. a registered
  alphanumeric sender ID) and documentation the client's use case needs
  before their first real send — the requirements and lead time differ
  from the US 10DLC process above, but a lead time still applies.
- **WhatsApp Business API approval**: the client's WhatsApp sender number
  must go through Meta's business verification and template-message
  approval process via Twilio before `src/channels/whatsapp.ts` can send
  anything beyond a 24-hour customer-service window. Outbound *re-engagement*
  messages (which is most of what LeadRecovery sends) require an
  approved message template — plan for this in the pilot timeline. WhatsApp
  is especially widely used for business messaging in South Africa, so this
  approval step is worth starting early for SA clients; LeadRecovery only
  integrates with WhatsApp through Twilio (no direct Meta Cloud API path),
  which is sufficient for SA numbers but worth knowing if a client already
  has a WhatsApp Business API setup elsewhere.
- **Sending windows**: many jurisdictions restrict SMS marketing hours
  (e.g. commonly 8am-9pm local). The default quiet-hours window
  (`src/quietHours.ts`, 8pm-8am) is a reasonable starting point but confirm
  the client's specific jurisdiction's rules and adjust per tenant
  (`quietHours` on the admin/self-service tenant config). For South African
  clients, the Consumer Protection Act similarly restricts direct-marketing
  contact hours/days — confirm current guidance with the client's counsel
  rather than assuming the default window already satisfies it.
  **One deliberate exception**: an appointment reminder within
  `APPOINTMENT_REMINDER_LAST_CHANCE_HOURS` (2h, `src/appointmentReminder.ts`)
  of the appointment sends even during quiet hours rather than being
  deferred into never sending at all — a confirmed appointment the lead
  already agreed to is treated as transactional, not marketing. If a
  client's jurisdiction restricts *all* outbound SMS hours with no
  transactional exception, that's a real conflict to review with them
  rather than something a wider `quietHours` window alone can fix.
- **Carrier approval is a recorded, enforced gate, not just a checklist
  item**: `Tenant.carrierApprovalConfirmedAt` (set via the admin UI/API
  after you've verified 10DLC/WhatsApp approval with the client) actually
  blocks the sms/whatsapp channels — `selectChannel`
  (`src/channels/index.ts`) treats them as unusable until it's set, falling
  back to email or skipping the lead entirely, rather than silently trying
  to send SMS/WhatsApp before the client is cleared to. `devMode` bypasses
  this for local/demo use only. Set it via `PATCH /admin/tenants/:id` with
  `{"carrierApprovalConfirmed": true}` once you've confirmed approval;
  `false` clears it (e.g. approval lapsed). Pre-existing tenants are
  grandfathered (migration 0014) the same way terms-acceptance is.

## Email (SendGrid)

- **Domain authentication**: set up SPF, DKIM, and ideally DMARC for the
  client's sending domain in SendGrid, or messages will land in spam and
  damage the domain's reputation.
- **CAN-SPAM / equivalent**: every email must have a working, honored
  unsubscribe path. LeadRecovery's messages include a STOP instruction and
  the inbound webhook flips matching leads to `opted_out` immediately, but
  confirm this satisfies the client's jurisdiction's specific requirements
  (e.g. a physical mailing address in the footer for CAN-SPAM).
- **SendGrid Inbound Parse / Event Webhook signing**: `src/webhooks/index.ts`'s
  inbound-parse webhook uses a constant-time-compared `?token=` shared
  secret (see `src/security.ts`). The Event Webhook (delivery/bounce
  tracking) supports real cryptographic verification instead: enable
  "Signed Event Webhook" in SendGrid's console and set the tenant's
  `channels.email.eventWebhookPublicKey` to the public key it shows — see
  README "Provider webhooks" — for stronger assurance the request actually
  came from SendGrid than the shared-secret fallback gives. Do this before
  handling real client traffic.

## Bot disclosure (auto-reply chatbot)

If a tenant enables the auto-reply chatbot (`autoReplyEnabled` + `knowledgeBase`
— see README "Auto-reply chatbot"):

- Several jurisdictions require **proactively** disclosing that a customer
  is interacting with an automated system in a commercial messaging
  context — for example California's B.O.T. Act (Bus. & Prof. Code
  §17941) for online commercial communications, and similar rules are
  emerging elsewhere. LeadRecovery's chatbot is instructed to answer
  *honestly* if asked whether it's a bot/AI regardless, and additionally
  **proactively discloses this by default**: the first auto-reply of every
  conversation is prefixed with a short disclosure note (see
  `src/chatbot.ts`'s `BOT_DISCLOSURE_NOTE`), controlled by
  `Tenant.botDisclosureEnabled` (default true when unset). Only set it to
  `false` for a specific tenant if you've confirmed their jurisdiction
  doesn't require it and the client prefers not to show it — don't disable
  it globally without that check.
- The knowledge base itself is the compliance boundary: the model is
  instructed to answer only from what the business wrote there and to
  escalate anything else, but it's still an LLM — review real
  conversation transcripts (`GET /leads/:id/messages`) periodically,
  especially early on, to confirm it's staying on script and escalating
  appropriately rather than trusting the instruction blindly.
- Auto-replies still go out through the same SMS/WhatsApp/Email channels
  as everything else in this system, so every item above (10DLC,
  WhatsApp template approval, CAN-SPAM, STOP handling) applies to them too.
- **The website chat widget** (`public/chat-widget.js`, see README
  "Website chat widget") is a fourth channel the same bot disclosure logic
  covers — a visitor chatting through it gets the exact same proactive
  disclosure, knowledge-base-only answers, and escalation behavior as an
  SMS/WhatsApp/email reply. It has no 10DLC/WhatsApp-template/CAN-SPAM
  requirements of its own (there's no carrier or email provider in the
  loop — it's a direct HTTP request/response on the client's own website),
  but STOP/opt-out handling and the compliance boundary above both still
  apply identically.

## Data handling

- Tenant channel credentials (Twilio auth tokens, SendGrid API keys) are
  encrypted at rest (AES-256-GCM, `src/crypto.ts`) in the `tenants.channels`
  JSONB column, keyed by `LEADRECOVERY_ENCRYPTION_KEY`. The key can be
  rotated without downtime — see "Rotating the encryption key" in
  `DEPLOYMENT.md`. This still isn't a substitute for a real secrets
  manager for defense-in-depth (audit logging, access control finer than
  "has the app's encryption key") — consider AWS Secrets Manager/Vault/
  similar for higher-stakes deployments. **Losing the encryption key (and
  any previous key still needed during a rotation) makes existing
  tenants' credentials unrecoverable** — back it up somewhere durable,
  separate from the database.
- Lead and message data includes PII (names, phone numbers, emails,
  conversation content). Make sure the Postgres instance is encrypted at
  rest and access is restricted appropriately, and agree a data-retention
  policy with the client.
- **Data-retention purging is automatic, not just a policy on paper.**
  Once a lead reaches a closed-out status (`unqualified`, `fraudulent`,
  `converted`) and stays inactive past the tenant's retention window, the
  worker permanently deletes it (and its message history, cascaded) on its
  next tick — see `src/dataRetention.ts`. A lead still active in the
  funnel is never auto-purged regardless of age. Defaults to
  `DEFAULT_DATA_RETENTION_DAYS` (365 days) unless overridden per tenant via
  `dataRetentionDays` (30-3650 days, settable by the tenant itself via
  `PATCH /tenants/me` or by an admin) — set it to match whatever retention
  period you actually agreed with the client.
  **`do_not_contact` and `opted_out` leads are deliberately exempt, no
  matter how old** — they're the system's only record of a phone/email
  that must never be re-contacted (`checkSuppression` in
  `compliance.ts`). Leads aren't deduplicated against existing records on
  import (`leadImport.ts` always creates a new row) or matched by contact
  info except on an inbound reply, so purging a suppressed lead would let
  a later re-import of the same contact (e.g. a refreshed CRM export) come
  back in as a brand-new, un-suppressed lead and get messaged again — a
  real re-contact risk (TCPA/CAN-SPAM, or POPIA for a South African
  client), not just a data-hygiene tradeoff.
  If you need to actually remove a specific person's data on request (a
  right-to-erasure request), use `DELETE /leads/:id` — distinct from the
  automatic purge above, this is an explicit, immediate removal of one
  lead (and its message history, cascaded) regardless of status, since
  it's the person themselves (or the business acting on their behalf)
  asking, not an automatic age-based sweep.
- Admin key and webhook shared-secret comparisons use constant-time
  comparison (`src/security.ts`) to avoid leaking timing information; all
  admin/webhook/tenant-authed routes are also rate limited
  (`src/middleware/rateLimit.ts`) against brute-force/flooding. The webhook
  limiter specifically fails *open* (`passOnStoreError: true`) on a
  transient error from its distributed Postgres-backed counter, rather than
  the library's own default of rejecting the request — a brief DB blip must
  never turn into every inbound webhook 500ing at once, including a lead's
  own STOP reply or a Paddle billing event. The admin/tenant limiters keep
  the library's default (fail closed) since those guard authenticated,
  credentialed routes instead.
- Twilio's `/webhooks/:tenantId/twilio/sms` route dedupes by MessageSid
  (`Message.providerMessageId` on the inbound log entry) — the auto-reply
  path calls out to an LLM before responding to Twilio's webhook, so a slow
  enough response can trigger a provider-level retry of the exact same
  message; without this, a retry would classify and reply/notify a second
  time.
- A client's right-of-access request — "send me a copy of everything you
  have on my leads" — is `GET /leads/export` (`?format=csv`, the default,
  or `?format=json`), every lead field as a one-shot download.
- A client's right-to-erasure request, or a decision to fully offboard
  them, is handled by `DELETE /admin/tenants/<id>` (see `ONBOARDING.md`
  step 10) — in Postgres this cascades to every lead and message that
  tenant ever had and cannot be undone. For a temporary hold instead of
  deletion, suspend the tenant (`PATCH /admin/tenants/<id>` with
  `{"status": "suspended"}`), which blocks all access without touching
  stored data.
- Every admin action (tenant creation, config/status change, key rotation,
  deletion) is recorded in an audit log (`GET /admin/audit-log`) — useful
  evidence for "who suspended/deleted this tenant, and when" if a client
  ever disputes it. Config-change entries record only which fields
  changed, never the new values, so credentials are never duplicated
  outside their encrypted storage. If more than one person runs the admin
  side of the agency, set `ADMIN_API_KEYS` (see `ONBOARDING.md` step 3) so
  this log records *who*, not just an indistinguishable "admin."

## Ongoing

- Re-verify consent/suppression state periodically — if the client's own
  team also contacts these leads through other channels, make sure opt-outs
  recorded there flow back into LeadRecovery's `do_not_contact`/`opted_out`
  status (currently a manual sync unless you wire up a two-way CRM
  integration).
