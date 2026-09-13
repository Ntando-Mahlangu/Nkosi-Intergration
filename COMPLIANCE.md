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
- **SendGrid Inbound Parse signing**: `src/webhooks/index.ts`'s email
  webhook uses a simple `?token=` shared secret as an MVP guard. Before
  handling real client traffic, switch to SendGrid's signed webhook
  verification (ECDSA signature over the request) for stronger assurance
  the request actually came from SendGrid.

## Data handling

- Tenant channel credentials (Twilio auth tokens, SendGrid API keys) are
  currently stored in cleartext in the `tenants.channels` JSONB column. For
  production use with real client credentials, put these behind a secrets
  manager (e.g. store a reference/ID in Postgres, the actual secret in AWS
  Secrets Manager / Vault / similar) rather than in the database directly.
- Lead and message data includes PII (names, phone numbers, emails,
  conversation content). Make sure the Postgres instance is encrypted at
  rest and access is restricted appropriately, and agree a data-retention
  policy with the client.

## Ongoing

- Re-verify consent/suppression state periodically — if the client's own
  team also contacts these leads through other channels, make sure opt-outs
  recorded there flow back into LeadRecovery's `do_not_contact`/`opted_out`
  status (currently a manual sync unless you wire up a two-way CRM
  integration).
