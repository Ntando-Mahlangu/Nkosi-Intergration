# Compliance checklist

LeadRecovery enforces what it can in code (suppression rules, quiet hours,
instant opt-out handling, never fabricating a contact reason). The items
below are manual, legal, or provider-side steps the code cannot do for you —
work through this with each client before their first real send. **This is
not legal advice** — confirm requirements with the client's own counsel for
their jurisdiction and industry; rules differ meaningfully between, e.g.,
the US (TCPA), the EU/UK (GDPR + PECR), and South Africa (POPIA), and this
document is not a substitute for that review.

## Consent basis

- Confirm *why* the business is allowed to contact each imported lead (an
  existing inquiry, a prior customer relationship, explicit marketing
  opt-in, etc.). "They filled out a form two years ago" may or may not be a
  valid basis depending on jurisdiction and how long ago that was — this is
  a business/legal decision, not a technical one.
- Load any existing do-not-contact/opt-out list **before** the first import
  (see `ONBOARDING.md` step 2).

## SMS / WhatsApp (Twilio)

- **10DLC registration** (US): required before sending SMS at any volume
  from a US long-code number, or messages get filtered/blocked by carriers.
  Register the client's brand and campaign in the Twilio console — this has
  a review lead time (days), start it early.
- **WhatsApp Business API approval**: the client's WhatsApp sender number
  must go through Meta's business verification and template-message
  approval process via Twilio before `src/channels/whatsapp.ts` can send
  anything beyond a 24-hour customer-service window. Outbound *re-engagement*
  messages (which is most of what LeadRecovery sends) require an
  approved message template — plan for this in the pilot timeline.
- **Sending windows**: many jurisdictions restrict SMS marketing hours
  (e.g. commonly 8am-9pm local). The default quiet-hours window
  (`src/quietHours.ts`, 8pm-8am) is a reasonable starting point but confirm
  the client's specific jurisdiction's rules and adjust per tenant.

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
  *honestly* if asked whether it's a bot/AI, but it does **not**
  proactively announce this in every message by default — that's a
  product/legal decision for the business, not something the code decides
  for them. Confirm with the client's counsel whether their jurisdiction
  requires proactive disclosure and, if so, add it — e.g. via a
  `knowledgeBase` instruction, or by having the first auto-reply in a
  conversation include a brief disclosure through a custom
  `tenant.templates` prefix.
- The knowledge base itself is the compliance boundary: the model is
  instructed to answer only from what the business wrote there and to
  escalate anything else, but it's still an LLM — review real
  conversation transcripts (`GET /leads/:id/messages`) periodically,
  especially early on, to confirm it's staying on script and escalating
  appropriately rather than trusting the instruction blindly.
- Auto-replies still go out through the same SMS/WhatsApp/Email channels
  as everything else in this system, so every item above (10DLC,
  WhatsApp template approval, CAN-SPAM, STOP handling) applies to them too.

## Data handling

- Tenant channel credentials (Twilio auth tokens, SendGrid API keys) are
  encrypted at rest (AES-256-GCM, `src/crypto.ts`) in the `tenants.channels`
  JSONB column, keyed by `LEADRECOVERY_ENCRYPTION_KEY`. This still isn't a
  substitute for a real secrets manager for defense-in-depth (rotation,
  audit logging, access control finer than "has the app's encryption key")
  — consider AWS Secrets Manager/Vault/similar for higher-stakes deployments.
  **Losing the encryption key makes existing tenants' credentials
  unrecoverable** — back it up somewhere durable, separate from the database.
- Lead and message data includes PII (names, phone numbers, emails,
  conversation content). Make sure the Postgres instance is encrypted at
  rest and access is restricted appropriately, and agree a data-retention
  policy with the client.
- Admin key and webhook shared-secret comparisons use constant-time
  comparison (`src/security.ts`) to avoid leaking timing information; all
  admin/webhook/tenant-authed routes are also rate limited
  (`src/middleware/rateLimit.ts`) against brute-force/flooding.
- A client's right-to-erasure request, or a decision to fully offboard
  them, is handled by `DELETE /admin/tenants/<id>` (see `ONBOARDING.md`
  step 10) — in Postgres this cascades to every lead and message that
  tenant ever had and cannot be undone. For a temporary hold instead of
  deletion, suspend the tenant (`PATCH /admin/tenants/<id>` with
  `{"status": "suspended"}`), which blocks all access without touching
  stored data.

## Ongoing

- Re-verify consent/suppression state periodically — if the client's own
  team also contacts these leads through other channels, make sure opt-outs
  recorded there flow back into LeadRecovery's `do_not_contact`/`opted_out`
  status (currently a manual sync unless you wire up a two-way CRM
  integration).
