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
- **`src/webhooks/`** — inbound Twilio SMS/voice-status, SendGrid inbound
  parse, and a generic JSON lead-intake endpoint for connecting a CRM via an
  outgoing webhook or Zapier/Make/n8n.
- **`src/reply/classify.ts`** — classifies inbound replies (stop / interested
  / not_interested / question / unknown). Keyword-based and fully offline by
  default; STOP detection *always* runs offline first so an opt-out is never
  delayed by a network call. An optional Claude-based enhancement pass for
  ambiguous replies is gated behind `LEADRECOVERY_USE_LLM_CLASSIFICATION=true`.
- **`src/workflow.ts`** — orchestrates the whole pipeline per tenant.
- **`src/worker.ts`** — cron loop that runs the workflow for every tenant.
- **`src/middleware/auth.ts`**, **`src/routes/tenants.ts`** — tenant API-key
  auth and tenant management (admin-key protected).
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

1. **Provision Postgres** and set `DATABASE_URL`, then run migrations:
   ```bash
   npm run migrate
   ```
2. **Set `ADMIN_API_KEY`** (a long random string only you hold) so tenant
   management endpoints are enabled.
3. **Onboard a tenant**: `npm run onboard` (interactive CLI) or `POST
   /admin/tenants` — see `ONBOARDING.md`.
4. **Import existing leads**: `npm run import-leads -- --tenant <id> --file leads.csv`,
   or point the client's CRM's outgoing webhook / a Zapier automation at
   `POST /webhooks/lead` with `Authorization: Bearer <tenant api key>`.
5. **Run the API**: `npm start` (after `npm run build`) or `npm run dev`.
6. **Run the worker** (sends initial outreach + follow-ups on a schedule):
   `npm run worker`. Set `LEADRECOVERY_CRON_SCHEDULE` (cron syntax, default
   hourly) and `LEADRECOVERY_RUN_ONCE=true` for a single pass (e.g. from an
   external scheduler instead of the built-in cron loop).
7. **Configure provider webhooks** with each tenant (URLs are printed by
   `npm run onboard`):
   - Twilio SMS inbound → `/webhooks/<tenantId>/twilio/sms`
   - Twilio voice status callback → `/webhooks/<tenantId>/twilio/voice-status`
   - SendGrid inbound parse → `/webhooks/<tenantId>/sendgrid/email?token=<apiKey>`

## API reference

All routes except `/health`, `/tenants/me`'s absence of auth, and the
webhooks require `Authorization: Bearer <tenant api key>`. Admin routes
require `Authorization: Bearer <ADMIN_API_KEY>` instead.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness check |
| GET | `/tenants/me` | The authenticated tenant's public info |
| GET | `/admin/tenants` | List tenants (admin) |
| POST | `/admin/tenants` | Create a tenant (admin); returns the API key once |
| GET | `/leads` | List the tenant's leads |
| GET | `/leads/plan` | Dry run: scored + composed plans, nothing sent |
| GET | `/leads/:id/messages` | Conversation history for one lead |
| POST | `/workflow/run` | Sends initial outreach + due follow-ups |
| POST | `/webhooks/lead` | Generic lead intake (tenant-auth) |
| POST | `/webhooks/:tenantId/twilio/sms` | Twilio inbound SMS (signature-verified) |
| POST | `/webhooks/:tenantId/twilio/voice-status` | Twilio call status → missed-call detection |
| POST | `/webhooks/:tenantId/sendgrid/email` | SendGrid inbound parse (`?token=` guarded) |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string; omit for the in-memory demo |
| `ADMIN_API_KEY` | Enables `/admin/tenants`; unset disables tenant management |
| `PORT` | API server port (default 3000) |
| `LEADRECOVERY_CRON_SCHEDULE` | Worker cron expression (default hourly) |
| `LEADRECOVERY_RUN_ONCE` | `true` runs the worker once and exits, instead of scheduling |
| `LEADRECOVERY_USE_LLM_CLASSIFICATION` | `true` enables the optional Claude-based reply classification enhancement |
| `ANTHROPIC_API_KEY` | Required only if the above is enabled |

## Testing

```bash
npm test
```

Covers compliance, scoring, reason/messaging, follow-up scheduling, quiet
hours, reply classification, the end-to-end workflow, the Postgres store
implementations (run against an in-memory Postgres emulator via `pg-mem`, so
the actual SQL is exercised without a live database), and the HTTP
auth/webhook routes (via `supertest`).
