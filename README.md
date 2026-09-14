# LeadRecovery

AI-powered, multi-tenant lead recovery and reactivation system by Nkosi Integrations.

LeadRecovery finds leads a business already generated but never converted
(missed calls, unanswered form submissions, abandoned bookings, cold quote
requests, etc.), scores them by recovery priority, works out a truthful
reason to reach back out, drafts a short human outreach message, sends it
over SMS/WhatsApp/Email, follows up on silence, and listens for replies
(including honoring STOP/opt-out instantly) — while permanently respecting
any lead marked do-not-contact, unqualified, fraudulent, already
booked/converted, or opted out.

It can also act as a live chatbot for a tenant's customers: an opt-in,
knowledge-base-grounded auto-reply answers straightforward questions
(hours, pricing, policies — whatever the business writes into its
knowledge base) and hands anything else — price negotiation, complaints,
complex requests, or an explicit ask for a person — to a human instead of
guessing. See "Auto-reply chatbot" below.

The full behavioral spec lives in [`SYSTEM_PROMPT.md`](./SYSTEM_PROMPT.md).
For the process of bringing on a real client, see
[`ONBOARDING.md`](./ONBOARDING.md); for what's manual/legal rather than code,
see [`COMPLIANCE.md`](./COMPLIANCE.md).

## Architecture

```
CRM / form / missed-call / booking software
        │  (webhook, or CSV import)
        ▼
   LeadStore (per tenant)  ──────────────┐
        │                                │
        ▼                                │
  compliance filter → scoring → reason → message → channel adapter (Twilio/SendGrid)
        │                                                    │
        ▼                                                    ▼
  follow-up scheduler (day 3/7/14)                    inbound reply webhook
        ▲                                                    │
        └──────────────── quiet hours gate ◄─────────────────┘
                                                  reply classification (STOP/interested/…)
```

Everything is scoped to a **tenant** (one business/client). A tenant carries
its own channel credentials, timezone, quiet hours, and API key — so one
deployment serves many clients with fully isolated data.

- **`src/compliance.ts`** — hard-stop suppression checks (do not contact,
  unqualified, fraudulent, active conversation, already booked/converted,
  opted out). Run first, override everything else.
- **`src/scoring.ts`** — HIGH/MEDIUM/LOW recovery priority from recency +
  intent signals.
- **`src/reason.ts`** — derives a *truthful* reason for contact strictly from
  known lead fields; never invents an event.
- **`src/messaging.ts`** / **`src/followup.ts`** — composes the initial
  message and up to 3 spaced, distinctly-worded follow-up nudges (day 3, 7,
  14) for leads that never respond. Any reply or opt-out stops follow-ups
  immediately.
- **`src/quietHours.ts`** — per-tenant local-time send window; sends outside
  it are deferred to the next run, never dropped.
- **`src/channels/`** — `ChannelAdapter`s for SMS/WhatsApp (Twilio) and Email
  (SendGrid), using each tenant's own credentials. A tenant with no
  credentials for a channel and `devMode: true` gets console-logged sends
  instead — that's how the CLI/demo work with zero provider accounts.
- **`src/store/`** — `LeadStore`/`TenantStore`/`MessageStore` interfaces;
  `memory.ts` (in-memory, used for the demo/tests) and `postgres.ts`
  (production) implementations. `createStores()` picks Postgres when
  `DATABASE_URL` is set, otherwise the in-memory demo tenant.
- **`src/webhooks/`** — inbound Twilio SMS/voice-status/delivery-status,
  SendGrid inbound parse/delivery events, and a generic JSON lead-intake
  endpoint for connecting a CRM via an outgoing webhook or Zapier/Make/n8n.
  Rate limited (`src/middleware/rateLimit.ts`) against flooding/abuse.
- **`src/reply/classify.ts`** — classifies inbound replies (stop / interested
  / not_interested / question / unknown). Keyword-based and fully offline by
  default; STOP detection *always* runs offline first so an opt-out is never
  delayed by a network call. An optional Claude-based enhancement pass for
  ambiguous replies is gated behind `LEADRECOVERY_USE_LLM_CLASSIFICATION=true`.
  What happens next depends on the classification (`src/webhooks/index.ts`):
  `interested` notifies the tenant's team; `not_interested` gets a fixed,
  no-LLM close-out reply; `question`/`unknown` goes to the chatbot below.
- **`src/chatbot.ts`** — the auto-reply chatbot. Opt-in per tenant
  (`autoReplyEnabled` + `knowledgeBase` both required). Answers *only* from
  the tenant's own `knowledgeBase` text and is instructed to reply with a
  literal `ESCALATE` for anything it isn't confident is covered there
  (price negotiation, complaints, complex requests, an explicit ask for a
  human) — any API error, missing config, or non-clean response also fails
  safe to escalate rather than risk a fabricated answer reaching a customer.
- **`src/notify.ts`** — best-effort POST to the tenant's `notifyWebhookUrl`
  (e.g. a Slack incoming webhook) when a reply is `interested` or the
  chatbot escalates — the two moments a human should act promptly.
- **`src/workflow.ts`** — orchestrates the whole pipeline per tenant, and
  generates each message's id up front so Twilio/SendGrid delivery-status
  callbacks can correlate back to it.
- **`src/worker.ts`** — cron loop that runs the workflow for every tenant.
- **`src/middleware/auth.ts`**, **`src/routes/tenants.ts`** — tenant API-key
  auth, tenant self-service (`PATCH /tenants/me`), and admin tenant
  management (admin-key protected).
- **`src/security.ts`**, **`src/crypto.ts`** — constant-time secret
  comparison and AES-256-GCM encryption for tenant provider credentials at
  rest (required in Postgres mode — see Environment variables below).
- **`src/messaging.ts`** / **`src/followup.ts`** also support a per-tenant
  `templates` override (`tenant.templates.initialGrounded` /
  `initialUngrounded` / `followUps[]`, with `{name}`/`{businessName}`/
  `{reason}`/`{service}` placeholders) so a client can customize wording
  without a code change — set via `PATCH /tenants/me` or the admin API.
- **`public/index.html`** — the default landing page: a "Command Center"
  view (connect with a tenant API key to see live per-category lead counts
  as an animated node graph, click a node for the real leads behind it).
- **`public/dashboard.html`** — the plain-list working view (queued plan,
  drafted messages, skipped leads, a button to trigger a run) — linked from
  the Command Center for day-to-day lead-by-lead work.

## Getting started (local demo, no external services)

```bash
npm install
npm run typecheck
npm test
npm run build
npm run cli          # runs the workflow once over data/sample-leads.json, prints results
npm run dev           # starts the API + dashboard at http://localhost:3000 (demo tenant, key "demo-key")
```

Open `http://localhost:3000` and connect with API key `demo-key` to see the
dashboard against the bundled sample data — no database or provider
credentials required.

## Running for real

1. **Copy `.env.example` to `.env`** and fill in what applies (or set these
   directly in your host's environment/secrets manager).
2. **Provision Postgres** and set `DATABASE_URL`, then run migrations:
   ```bash
   npm run migrate
   ```
3. **Generate and set `LEADRECOVERY_ENCRYPTION_KEY`** (required whenever
   `DATABASE_URL` is set — tenant Twilio/SendGrid credentials are encrypted
   at rest with it):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
4. **Set `ADMIN_API_KEY`** (a long random string only you hold) so tenant
   management endpoints are enabled.
5. **Set `PUBLIC_BASE_URL`** to this app's own public HTTPS URL — required
   for correct Twilio webhook signature verification behind a proxy/load
   balancer, and for delivery-status callback URLs.
6. **Onboard a tenant**: `npm run onboard` (interactive CLI) or `POST
   /admin/tenants` — see `ONBOARDING.md`.
7. **Import existing leads**: `npm run import-leads -- --tenant <id> --file leads.csv`,
   or point the client's CRM's outgoing webhook / a Zapier automation at
   `POST /webhooks/lead` with `Authorization: Bearer <tenant api key>`.
8. **Run the API**: `npm start` (after `npm run build`) or `npm run dev`.
9. **Run the worker** (sends initial outreach + follow-ups on a schedule):
   `npm run worker`. Set `LEADRECOVERY_CRON_SCHEDULE` (cron syntax, default
   hourly) and `LEADRECOVERY_RUN_ONCE=true` for a single pass (e.g. from an
   external scheduler instead of the built-in cron loop).
10. **Configure provider webhooks** with each tenant (URLs are printed by
    `npm run onboard`):
    - Twilio SMS inbound → `/webhooks/<tenantId>/twilio/sms`
    - Twilio voice status callback → `/webhooks/<tenantId>/twilio/voice-status`
    - Twilio delivery-status callback → set automatically per-send when
      `PUBLIC_BASE_URL` is configured (no manual Twilio console setup needed)
    - SendGrid inbound parse → `/webhooks/<tenantId>/sendgrid/email?token=<apiKey>`
    - SendGrid Event Webhook (delivery/bounce tracking) →
      `/webhooks/<tenantId>/sendgrid/events?token=<apiKey>`

## API reference

All routes except `/health` and the webhooks require `Authorization: Bearer
<tenant api key>`. Admin routes require `Authorization: Bearer
<ADMIN_API_KEY>` instead. All routes are rate limited
(`src/middleware/rateLimit.ts`) — tenant-authed routes and `/tenants/me` at
60/min, admin routes at 30/15min, webhooks at 120/min, all per IP.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness check |
| GET | `/tenants/me` | The authenticated tenant's public info |
| PATCH | `/tenants/me` | Tenant self-service: update timezone/quietHours/devMode/channels/notifyWebhookUrl/templates/knowledgeBase/autoReplyEnabled |
| GET | `/admin/tenants` | List tenants (admin) |
| POST | `/admin/tenants` | Create a tenant (admin); returns the API key once |
| GET | `/leads` | List the tenant's leads. Optional `?limit=&offset=`; always sets `X-Total-Count` |
| GET | `/leads/plan` | Dry run: scored + composed plans, nothing sent. Same optional pagination |
| GET | `/leads/:id/messages` | Conversation history for one lead (includes delivery status) |
| POST | `/workflow/run` | Sends initial outreach + due follow-ups |
| POST | `/webhooks/lead` | Generic lead intake (tenant-auth) |
| POST | `/webhooks/:tenantId/twilio/sms` | Twilio inbound SMS/WhatsApp reply (signature-verified) |
| POST | `/webhooks/:tenantId/twilio/voice-status` | Twilio call status → missed-call detection (signature-verified) |
| POST | `/webhooks/:tenantId/twilio/status` | Twilio delivery-status callback (signature-verified) |
| POST | `/webhooks/:tenantId/sendgrid/email` | SendGrid inbound parse (`?token=` guarded) |
| POST | `/webhooks/:tenantId/sendgrid/events` | SendGrid Event Webhook — delivered/bounce/etc. (`?token=` guarded) |

## Environment variables

See [`.env.example`](./.env.example) for the copyable version with full comments.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string; omit for the in-memory demo |
| `LEADRECOVERY_ENCRYPTION_KEY` | **Required** when `DATABASE_URL` is set — encrypts tenant provider credentials at rest |
| `ADMIN_API_KEY` | Enables `/admin/tenants`; unset disables tenant management |
| `PUBLIC_BASE_URL` | This app's public HTTPS base URL — needed for correct Twilio signature verification behind a proxy, and for delivery-status callback URLs |
| `PORT` | API server port (default 3000) |
| `LEADRECOVERY_CRON_SCHEDULE` | Worker cron expression (default hourly) |
| `LEADRECOVERY_RUN_ONCE` | `true` runs the worker once and exits, instead of scheduling |
| `LEADRECOVERY_USE_LLM_CLASSIFICATION` | `true` enables the optional Claude-based reply classification enhancement |
| `ANTHROPIC_API_KEY` | Required if the above is enabled, **or** if any tenant has `autoReplyEnabled: true` (the chatbot) |

## Auto-reply chatbot

Off by default — a tenant must opt in. To turn it on for a tenant:

```bash
curl -X PATCH https://<host>/tenants/me \
  -H "Authorization: Bearer <tenant api key>" -H "Content-Type: application/json" \
  -d '{"knowledgeBase": "We offer callouts from R500. Open Mon-Fri 8am-5pm. Standard jobs take 24-48 hours.", "autoReplyEnabled": true}'
```

(`npm run onboard` can also set this up at onboarding time.) With both fields
set, an inbound SMS/WhatsApp/email that classifies as a `question` (or
`unknown`) gets a reply generated by Claude, grounded strictly in that
`knowledgeBase` text — it's instructed to never invent a price, policy, or
fact the knowledge base doesn't state, and to answer honestly (never claim
to be human) if asked whether it's a bot. Anything it isn't confident is a
simple, clearly-covered question — price negotiation, a complaint, a
complex/multi-part request, or an explicit ask for a person — gets escalated
to a human via `notifyWebhookUrl` instead of an automated answer.
Conversation history for the lead (via `GET /leads/:id/messages`) is passed
along so replies stay coherent across a multi-turn exchange.

See "Bot disclosure" in `COMPLIANCE.md` before turning this on for a real
client — some jurisdictions require proactively disclosing that a customer
is messaging with an automated system.

## CI

`.github/workflows/ci.yml` runs `typecheck`, `test`, and `build` on every
push and pull request.

## Testing

```bash
npm test
```

Covers compliance, scoring, reason/messaging (incl. per-tenant template
overrides), follow-up scheduling, quiet hours, reply classification
(keyword path fully offline; the optional Claude-based enhancement covered
with `@anthropic-ai/sdk` mocked — no live API key needed), the chatbot
(reply/escalate/disabled outcomes, conversation-history formatting, and
that it never calls the network when disabled), encryption/constant-time-
compare (`src/crypto.ts`/`src/security.ts`), the end-to-end workflow, the
Postgres store implementations (run against an in-memory Postgres emulator
via `pg-mem`, so the actual SQL is exercised without a live database,
including credential encryption at rest and delivery-status updates), and
the HTTP auth/webhook/rate-limiting routes — including the full
question→auto-reply and question→escalate flows — via `supertest`.
