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
see [`COMPLIANCE.md`](./COMPLIANCE.md); for running this in production
(Docker/Compose, systemd, required env vars, the single-worker-replica
constraint), see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

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
  Rate limited (`src/middleware/rateLimit.ts`) against flooding/abuse —
  backed by Postgres (`src/middleware/pgRateLimitStore.ts`) when
  `DATABASE_URL` is set, so limits hold across every `app` replica sharing
  that database rather than resetting per-process.
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
- **`src/notify.ts`** — POSTs to the tenant's `notifyWebhookUrl` (e.g. a
  Slack incoming webhook) when a reply is `interested` or the chatbot
  escalates — the two moments a human should act promptly. Retries once
  inline; if that still fails, persists the notification (never silently
  dropping it) so the worker can keep retrying it on every tick until it
  succeeds or `GET /admin/notifications/failed` shows it as `dead`.
- **`src/workflow.ts`** — orchestrates the whole pipeline per tenant, and
  generates each message's id up front so Twilio/SendGrid delivery-status
  callbacks can correlate back to it.
- **`src/worker.ts`** — cron loop that runs the workflow for every tenant,
  skipping suspended ones, with bounded per-tick concurrency across tenants
  (`src/concurrency.ts`, `LEADRECOVERY_WORKER_CONCURRENCY`). Run exactly one
  worker replica — see `DEPLOYMENT.md`. Actually enforced (not just
  documented) when `DATABASE_URL` is set: `src/workerLock.ts` takes a
  Postgres advisory lock on startup and exits if another worker already
  holds it.
- **`src/middleware/auth.ts`**, **`src/routes/tenants.ts`** — tenant API-key
  auth (rejecting a suspended tenant), tenant self-service (`PATCH
  /tenants/me`), and admin tenant management (admin-key protected),
  including suspending/reactivating and permanently deleting a tenant.
- **`src/security.ts`**, **`src/crypto.ts`** — constant-time secret
  comparison and AES-256-GCM encryption for tenant provider credentials at
  rest (required in Postgres mode — see Environment variables below).
- **`src/logger.ts`** — structured JSON logging for the server/worker
  (request log, worker ticks, send/notification/chatbot failures) so
  output drops straight into any log aggregator. The interactive CLI
  scripts print plain human-facing text instead, on purpose.
- Every admin tenant mutation (create, config/status change, key rotation,
  delete) is recorded to an audit log (`GET /admin/audit-log`) — config
  updates log which fields changed, never the values, so credentials are
  never duplicated into a second store.
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
- **`public/admin.html`** — cross-tenant platform ops: connects with
  `ADMIN_API_KEY` (not a tenant key) to list/create/suspend/reactivate/
  delete tenants and rotate a tenant's API key, plus visibility into the
  failed-notifications dead-letter queue and the admin audit log. Not
  linked from the tenant-facing dashboards — it's a separate credential
  for the platform operator, not something a tenant should see. The tenant
  list and audit log are paginated (20 per page, Prev/Next, backed by the
  same `?limit=&offset=`/`X-Total-Count` the API already exposed) so a
  platform with hundreds of tenants or a long-running audit trail doesn't
  render everything in one unbounded page.

### Accessibility

All three dashboards work with a keyboard and a screen reader, not just a
mouse:

- Every form field has a real `<label for>`, every action is a real
  `<button>` or `<a>`, and error/status text (`#gate-err`, `#auth-error`,
  `#create-error`, the admin `#reveal-panel` one-time API key, the
  tenant/audit-log pagination summaries) is exposed via `role="alert"` or
  `aria-live` so assistive tech announces it without polling.
- `public/index.html`'s Command Center renders its category graph as SVG,
  which isn't natively keyboard-operable — each category node is a real
  tab stop (`tabindex="0"`, `role="button"`, an `aria-label` with its live
  count) that opens the same detail panel on Enter/Space as on click. The
  detail panel is a proper focus-managed dialog: opening it moves focus to
  its close button, `Escape` (or the close button) closes it and returns
  focus to the node that opened it, and it's marked `inert` while closed
  so a keyboard user can't tab into hidden content. Purely decorative
  scene elements (the starfield, particle flow, wireframe core, connecting
  lines) are `aria-hidden`; the ambient log ticker is also `aria-hidden`
  since it's flavor text that echoes data already exposed accessibly
  through the stats rail and the detail panel, and making it a live region
  would announce a new line every few seconds.
- Covered by dedicated Playwright coverage: `tests/e2e/dashboards.spec.ts`
  drives a category node with the keyboard only (focus → Enter → Escape)
  and asserts focus lands on the close button, then back on the
  originating node.

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
   /admin/tenants` — see `ONBOARDING.md`. Then run `npm run check-providers
   -- --tenant <id>` to verify every configured provider credential
   (Twilio/SendGrid/Anthropic) actually authenticates before going live —
   catches a typo'd/revoked credential now instead of it failing silently
   on a real customer's first message.
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
      `/webhooks/<tenantId>/sendgrid/events?token=<apiKey>` — or, for real
      cryptographic verification instead of the shared `?token=` secret, set
      the tenant's `channels.email.eventWebhookPublicKey` to the base64
      public key SendGrid shows under Settings → Mail Settings → Signed
      Event Webhook (enable signing there first). When that field is set,
      the app verifies SendGrid's ECDSA signature headers and the `?token=`
      check is bypassed entirely for that tenant.

## API versioning

There's no `/v1`-style path prefix — with no external consumers yet to
protect, adding one now would be complexity spent guarding against a
problem that doesn't exist. Every response carries an `X-API-Version`
header (the exact `package.json` version), so a client can at least detect
what it's talking to. The policy for when this needs to change:

- Additive changes (a new optional field, a new endpoint, a new enum
  value somewhere already documented as open-ended) ship in place, no
  version bump required of callers.
- A breaking change to a response shape or an existing endpoint's
  semantics is the point to introduce `/v2` for the affected routes
  (`/v1` implied for everything today) — old routes keep working
  unversioned until deliberately deprecated, not ripped out on the same
  release.
- Track breaking changes in this README (or a `CHANGELOG.md`, once
  there's enough history to warrant one) rather than expecting callers to
  diff `X-API-Version` values themselves.

## API reference

A machine-readable reference for everything below (request/response
schemas included) is in [`openapi.yaml`](./openapi.yaml) — paste it into
any OpenAPI viewer (Swagger UI, Redoc, Postman's import) for interactive
docs.

All routes except `/health` and the webhooks require `Authorization: Bearer
<tenant api key>`. Admin routes require `Authorization: Bearer
<ADMIN_API_KEY>` instead. All routes are rate limited
(`src/middleware/rateLimit.ts`) — tenant-authed routes and `/tenants/me` at
60/min, admin routes at 30/15min, webhooks at 120/min, all per IP.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness check (checks nothing external) |
| GET | `/ready` | Readiness check — verifies Postgres connectivity when `DATABASE_URL` is set |
| GET | `/tenants/me` | The authenticated tenant's public info |
| PATCH | `/tenants/me` | Tenant self-service: update timezone/quietHours/devMode/channels/notifyWebhookUrl/templates/knowledgeBase/autoReplyEnabled |
| GET | `/admin/tenants` | List tenants (admin) |
| POST | `/admin/tenants` | Create a tenant (admin); returns the API key once |
| PATCH | `/admin/tenants/:id` | Admin update: any self-service field, plus `status` (`"active"` \| `"suspended"`) — the only way to suspend/reactivate a tenant |
| POST | `/admin/tenants/:id/rotate-key` | Issue a new API key for a tenant (admin); the old key stops working immediately |
| DELETE | `/admin/tenants/:id` | Permanently delete a tenant (admin) — cascades to its leads/messages in Postgres; no undo |
| GET | `/admin/notifications/failed` | Notifications ("interested"/escalation) that failed to reach `notifyWebhookUrl` even after retries — `pending` ones are still being retried by the worker, `dead` ones gave up and need attention |
| GET | `/admin/audit-log` | Admin action history (tenant create/update/delete/key-rotation), newest first. Optional `?limit=&offset=` |
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
| `LEADRECOVERY_ENCRYPTION_KEY_PREVIOUS` | Set only while rotating the encryption key — see `DEPLOYMENT.md` "Rotating the encryption key" |
| `ADMIN_API_KEY` | Enables `/admin/tenants`; unset disables tenant management |
| `LEADRECOVERY_CORS_ORIGIN` | Comma-separated allowed origins for cross-origin API calls (or `*`); unset sends no CORS headers, which is fine for the bundled same-origin dashboards |
| `PUBLIC_BASE_URL` | This app's public HTTPS base URL — needed for correct Twilio signature verification behind a proxy, and for delivery-status callback URLs |
| `PORT` | API server port (default 3000) |
| `LEADRECOVERY_CRON_SCHEDULE` | Worker cron expression (default hourly) |
| `LEADRECOVERY_RUN_ONCE` | `true` runs the worker once and exits, instead of scheduling |
| `LEADRECOVERY_WORKER_CONCURRENCY` | How many tenants the worker processes in parallel per tick (default 4) — tunes concurrency *within* the one worker process only; see `DEPLOYMENT.md` for why exactly one worker replica must run |
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

## Localization

There's no separate i18n translation layer (no message catalog, no
`Accept-Language` negotiation) — and none is fabricated here, since there's
no real multi-language requirement driving one. Instead, every piece of
customer-facing wording is already a per-tenant value, not a hardcoded
string, so a client operating in a language other than English configures
that language directly, with no code change:

- **Outreach and follow-up messages** — `tenant.templates` (see
  "Per-tenant message templates" above) fully replaces the default English
  wording for the initial grounded/ungrounded outreach message, every
  follow-up in the sequence, and the not-interested closer. A template is
  plain text with `{name}`/`{businessName}`/`{reason}`/`{service}`
  placeholders — nothing in `src/messaging.ts`/`src/followup.ts` assumes
  English, so a tenant sets these to Portuguese, isiZulu, French, or
  anything else and every automated send goes out in that language.
- **The auto-reply chatbot** — answers strictly from `tenant.knowledgeBase`
  (see "Auto-reply chatbot" above), so whatever language that text is
  written in is the language Claude answers in; no separate translation
  step is needed.
- **Compliance opt-out wording** ("Reply STOP...") in the default English
  templates is exactly that: a default. A tenant overriding `templates`
  is responsible for including their own opt-out instruction in whatever
  language they use — see "Bot disclosure"/opt-out language requirements
  in `COMPLIANCE.md`.

What is **not** localized, and would need real code changes if a client
ever required it:

- **Inbound reply classification** (`src/reply/classify.ts`) — the
  deterministic keyword baseline (STOP/opt-out, "not interested",
  "interested", etc.) matches English phrases only; it's the safety net
  that must work without a network call, so it can't defer to the LLM.
  The optional LLM classification pass (`LEADRECOVERY_USE_LLM_CLASSIFICATION`)
  is inherently more multilingual (Claude understands non-English replies
  natively) but is only ever a fallback for what the keyword pass doesn't
  confidently place — an opt-out phrased in another language and not
  caught by the English keyword list could go unrecognized until the LLM
  pass (if enabled) or a human catches it.
- **The three dashboards' own UI chrome** (`public/index.html`,
  `dashboard.html`, `admin.html`) — labels, buttons, and status text are
  hardcoded English. These are operator/tenant-staff tooling, not
  end-customer-facing, so they're out of scope for a customer-language
  requirement, but a tenant's own staff working in another language would
  need these translated by hand.

## CI

`.github/workflows/ci.yml` runs five jobs on every push and pull request:
`test` (`typecheck`, `lint`, `format:check`, `test`, `build`, and
`openapi.yaml` schema validation), a separate `e2e` job that installs a
Playwright browser and runs `test:e2e`, and a `docker` job that builds the
image from `Dockerfile` — the actual, continuous check that it still builds
(a real Docker build needs full internet access to pull the base image and
isn't something every local/sandboxed dev environment can run).

A `security` job runs `npm audit --omit=dev --audit-level=high` (gating on
production dependencies only — see the comment in `ci.yml` for why the one
known devDependency-only vulnerability chain, esbuild/vite/vitest, is
tracked rather than force-upgraded) and a `gitleaks` scan over the full git
history to catch committed secrets.

A `compose` job brings up the actual `docker-compose.yml` stack (Postgres +
`app` + `worker`, all built from the real `Dockerfile`) instead of mocking
anything: it runs the `migrate` one-off, waits for `/health` and `/ready`,
onboards a tenant through the admin API, calls the API back with that
tenant's own key, and checks the worker's logs for a real tick — the only
CI job that exercises the compose file and the built image together the
way an operator actually would.

## Testing

```bash
npm run typecheck  # tsc over src/ (tsconfig.json) AND tests/ (tsconfig.test.json)
npm run lint         # eslint . (typed-linting; see eslint.config.js)
npm run format:check # prettier --check .
npm test        # fast unit/integration suite (vitest)
npm run test:e2e  # browser end-to-end tests against both dashboards (Playwright)
```

`npm run typecheck` runs two passes — `tsconfig.json` (the build config,
`src/` only) and `tsconfig.test.json` (a `noEmit` config that also
includes `tests/`) — so a type error in a test file (a wrong mock shape, a
changed constructor signature the test wasn't updated for) is caught the
same as one in `src/`, not just at test-runtime (vitest itself only
transpiles, it doesn't type-check).

`npm run lint` (`eslint.config.js`) runs typed ESLint rules over the same
two projects. Most of typescript-eslint's `recommendedTypeChecked` "unsafe"
rules are deliberately off — this codebase touches a lot of legitimately
untyped external data (webhook payloads, Postgres rows, SDK responses) —
but `no-floating-promises` and `no-misused-promises` are on: they're
exactly the rules that would have caught a real unhandled-rejection bug
found in this codebase's own review (see git history). `npm run lint:fix`
and `npm run format` apply automatic fixes.

`npm test` covers compliance, scoring, reason/messaging (incl. per-tenant
template overrides), follow-up scheduling, quiet hours, reply
classification (keyword path fully offline; the optional Claude-based
enhancement covered with `@anthropic-ai/sdk` mocked — no live API key
needed), the chatbot (reply/escalate/disabled outcomes, conversation-
history capping, the per-lead auto-reply rate limit, and that it never
calls the network when disabled), encryption/constant-time-compare
(`src/crypto.ts`/`src/security.ts`, including the encryption-key rotation
fallback and the full old-key→new-key rotation pattern), bounded-concurrency
tenant processing (`src/concurrency.ts`), the worker's advisory-lock logic
(`src/workerLock.ts`), notification retry/dead-letter behavior
(`src/notify.ts`, with fake timers so the inline retry delay costs no real
time in the suite), CORS, the `/health`/`/ready` endpoints, the end-to-end
workflow, the Postgres store implementations (run against an in-memory
Postgres emulator via `pg-mem`, so the actual SQL is exercised without a
live database, including credential encryption at rest, delivery-status
updates, tenant status, `deleteTenant`'s cascade to a tenant's
leads/messages, failed-notification bookkeeping, and the audit log), and
the HTTP auth/webhook/rate-limiting routes — including the full
question→auto-reply and question→escalate flows, tenant
suspend/reactivate/delete/key-rotation, admin audit log and failed-
notification visibility, admin listing pagination, and real SendGrid Event
Webhook ECDSA signature verification — via `supertest`.

`npm run test:e2e` drives `public/index.html` (Command Center),
`public/dashboard.html`, and `public/admin.html` in a real headless browser
via [Playwright](https://playwright.dev): connecting with a valid/invalid
API/admin key, live category counts and the lead-detail panel, session
persistence across a reload, disconnecting, and — for admin.html —
creating/suspending/reactivating/rotating/deleting a tenant and seeing it
reflected in the audit log. It starts its own server instance
(`playwright.config.ts`, with `ADMIN_API_KEY` set for the admin tests)
against the in-memory demo tenant, so it needs no external services
either. Kept separate from `npm test` (and run as its own CI job) since it
needs a real browser and is slower.
