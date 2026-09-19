# Deployment

This covers running LeadRecovery for real: with Docker Compose, with a plain
Dockerfile against your own infrastructure, or without Docker at all on a
VPS via systemd. For local demo usage (no external services, in-memory
store) see the "Getting started" section of `README.md` instead — none of
this is required just to try the system out.

## What gets deployed

Three long-running things, plus a one-off migration step:

- **`app`** — the Express API server (`node dist/server.js`). Serves the
  dashboards, the REST API, and all webhooks. Safe to run multiple
  replicas of — rate limiting is backed by Postgres when `DATABASE_URL` is
  set, so limits are enforced across replicas rather than resetting per
  process (see `src/middleware/pgRateLimitStore.ts`).
- **`worker`** — the cron loop that sends initial outreach and due
  follow-ups (`node dist/worker.js`). **Run exactly one replica.** Nothing
  coordinates sends across separate worker processes — a second replica
  would pick up the same due leads on the same tick and send everything
  twice. When `DATABASE_URL` is set, this is actually enforced, not just
  documented: on startup the worker takes a Postgres session-level
  advisory lock (`src/workerLock.ts`) and exits immediately if it can't
  get it, so a second replica refuses to run rather than silently
  double-sending. (In the in-memory demo mode there's no shared database
  to coordinate through, so this doesn't apply — but nothing coordinates
  demo-mode replicas either, so don't run more than one there for the
  same reason.) The lock releases automatically the instant the holding
  process's connection closes (crash, restart, redeploy), so a replacement
  replica can always take over — there's no stale-lock cleanup step.

  Separately from the one-replica-only rule above: a tenant's own
  `POST /workflow/run` (triggered from the dashboard, or an API call) and
  this worker's cron tick both call the same `runRecoveryWorkflow`, and
  nothing about either one prevents them from overlapping *for that one
  tenant* — without coordination, both would read the same lead as
  "not yet contacted" and actually send it the same message twice, even
  though only one replica of the worker itself is running. This is handled
  separately, always (not gated on `DATABASE_URL`), by
  `src/workflowLock.ts`: an in-process queue serializes overlapping calls
  within one process, and — when `DATABASE_URL` is set — a Postgres
  advisory lock keyed per tenant serializes the `app` and `worker`
  processes against each other too.
- **`migrate`** — a one-off command (`node dist/scripts/migrate.js`) that
  applies `src/db/migrations/*.sql` in order. Run it once before the first
  deploy and again after pulling any change that adds a migration file.
  Idempotent — safe to re-run.
- **Postgres** — not part of this repo's image; provision it separately
  (a managed instance, or the `postgres` service in `docker-compose.yml`
  for self-hosting).

`app` and `worker` are built from the same image (`Dockerfile`) — only the
container command differs.

## Option 1: Docker Compose (self-hosted, all-in-one)

```bash
cp .env.example .env    # fill in the values described below
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d app worker
```

`docker-compose.yml` wires `DATABASE_URL` to the bundled `postgres` service
automatically; everything else (encryption key, admin key, provider
credentials via the API, etc.) comes from your `.env`. To pick up a new
image after a code change: `docker compose build && docker compose up -d`
(re-run `docker compose run --rm migrate` first if the change added a
migration).

**Never** `docker compose up --scale worker=2` — see "What gets deployed"
above. A second replica would refuse to run (it can't get the advisory
lock the first one holds) rather than silently double-sending, but you
still don't want a worker process stuck permanently failing to start.

## Option 2: Your own Postgres + the Dockerfile directly

Build once, run the same image as both services against your own
managed Postgres:

```bash
docker build -t leadrecovery .

# one-off, before first deploy and after any new migration:
docker run --rm --env-file .env -e DATABASE_URL=... leadrecovery node dist/scripts/migrate.js

# the API server (scale this one freely):
docker run -d --env-file .env -e DATABASE_URL=... -p 3000:3000 leadrecovery

# the worker (exactly one container, ever):
docker run -d --env-file .env -e DATABASE_URL=... leadrecovery node dist/worker.js
```

### Pulling the prebuilt image from GHCR instead of building it yourself

`.github/workflows/publish.yml` builds this same `Dockerfile` and pushes it
to GitHub Container Registry on every push to `main`, tagged both `latest`
and with the full commit SHA (`sha-<full sha>`) — pin to a SHA tag for
anything beyond quick testing, since `latest` moves. The package is public
under the repo's GHCR namespace, so no registry login is needed to pull it:

```bash
docker pull ghcr.io/ntando-mahlangu/nkosi-intergration:latest

# then run it exactly like the locally-built image above, e.g.:
docker run -d --env-file .env -e DATABASE_URL=... -p 3000:3000 \
  ghcr.io/ntando-mahlangu/nkosi-intergration:latest
```

To use the published image with Docker Compose instead of building locally,
replace each service's `build: .` in `docker-compose.yml` with
`image: ghcr.io/ntando-mahlangu/nkosi-intergration:latest`.

## Option 3: No Docker — systemd on a plain VPS

```bash
git clone <your fork> /opt/leadrecovery && cd /opt/leadrecovery
npm ci
npm run build
node dist/scripts/migrate.js   # after setting DATABASE_URL etc. in the environment
```

Two unit files, both loading the same `/opt/leadrecovery/.env`:

```ini
# /etc/systemd/system/leadrecovery-app.service
[Unit]
Description=LeadRecovery API server
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/leadrecovery
EnvironmentFile=/opt/leadrecovery/.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
User=leadrecovery

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/leadrecovery-worker.service
[Unit]
Description=LeadRecovery worker
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/leadrecovery
EnvironmentFile=/opt/leadrecovery/.env
ExecStart=/usr/bin/node dist/worker.js
Restart=on-failure
User=leadrecovery

[Install]
WantedBy=multi-user.target
```

Enable exactly one instance of the worker unit (systemd templates/scaling
are not used here for that reason), then:

```bash
systemctl daemon-reload
systemctl enable --now leadrecovery-app leadrecovery-worker
```

Put a reverse proxy (nginx/Caddy) in front of `leadrecovery-app` for TLS —
see the next section for why this matters beyond just HTTPS.

## Required environment variables

Full descriptions in `.env.example`; the ones that matter for a production
deploy specifically:

- **`DATABASE_URL`** — without it the app silently falls back to the
  in-memory demo store, which forgets everything on restart. Always set
  this in production.
- **`LEADRECOVERY_ENCRYPTION_KEY`** — required whenever `DATABASE_URL` is
  set; the server refuses to start without it. Generate with `node -e
  "console.log(require('crypto').randomBytes(32).toString('base64'))"` and
  store it in a secrets manager — losing it makes every tenant's stored
  Twilio/SendGrid credentials unrecoverable, and rotating it requires
  re-entering those credentials for every tenant.
- **`ADMIN_API_KEY`** — a long random value; without it `/admin/tenants` is
  disabled entirely (503), so you can't onboard/suspend/delete tenants.
- **`PUBLIC_BASE_URL`** — this app's own public HTTPS URL, no trailing
  slash. See "Reverse proxy and webhook signatures" below — required
  behind any proxy/load balancer.
- **`LEADRECOVERY_WORKER_CONCURRENCY`** — how many tenants the worker
  processes in parallel per tick (default 4). This tunes concurrency
  *within* the one worker process; it has nothing to do with, and doesn't
  relax, the one-replica constraint.

## Reverse proxy and webhook signatures

Twilio's inbound-webhook signature covers the exact URL Twilio believes it
called (scheme + host + path + query). Behind a reverse proxy or load
balancer, `req.protocol`/`req.get("host")` inside the app often reflect the
proxy's internal view (`http://` on port 3000) rather than what Twilio
actually requested (`https://leadrecovery.example.com/...`), which would
make every real Twilio request fail signature verification. Setting
`PUBLIC_BASE_URL` sidesteps this: the app uses that fixed value instead of
trusting per-request headers. Set it exactly to the public HTTPS origin
your proxy terminates TLS for, and make sure your proxy config doesn't
rewrite the path before it reaches the app. This same value is also used
to build Twilio `statusCallback` URLs for delivery-status tracking, so it
should be set any time the app is reachable from the public internet, not
just to satisfy signature verification.

Separately, set `TRUST_PROXY_HOPS` (to `1`, for the single proxy this
section describes) to tell Express to trust that hop
(`app.set("trust proxy", ...)`), which every rate limiter in
`middleware/rateLimit.ts` needs to resolve the real client's IP instead of
the proxy's. Without it, every distinct client behind the same proxy
shares one rate-limit bucket per limiter — one noisy tenant (or attacker)
can 429-lock out every other tenant on the same limiter, the opposite of
what rate limiting is for. This is deliberately a separate setting from
`PUBLIC_BASE_URL`, not inferred from it: `PUBLIC_BASE_URL` should be set
any time the app is public, including a direct-exposure deployment or one
behind a passthrough CDN that doesn't overwrite `X-Forwarded-For` — only
set `TRUST_PROXY_HOPS` once you've actually verified your proxy overwrites/
appends that header itself and a client's own value can't survive to this
app; setting it when that's not true lets any client spoof their own IP
and bypass rate limiting entirely. Raise it above 1 if your topology has
more hops in front of that proxy (e.g. a CDN or an extra load balancer) —
set it to exactly how many proxies sit between the real client and this
app, no more.

SendGrid Event Webhook signatures (delivery/bounce/etc. tracking) aren't
affected by the proxy issue — verification there uses SendGrid's own
per-tenant public key (`eventWebhookPublicKey`, set via the tenant API) or
falls back to a shared `?token=` secret in the callback URL, neither of
which depends on how the app sees its own address. See "SendGrid Event
Webhook signing" in `README.md`/`ONBOARDING.md` for how to obtain and set
that key per tenant.

## Billing (Paddle)

`POST /webhooks/paddle` auto-suspends a tenant when its Paddle subscription
lapses (canceled, past due, paused, a failed payment) and reactivates it
when the subscription is active again — the same effect as an admin
clicking "Suspend"/"Reactivate" in `admin.html`, just automatic. Unlike
every other webhook route, this one isn't scoped to a tenant in the URL:
Paddle is the *agency's own* billing account, shared across every tenant,
authenticated by one `PADDLE_WEBHOOK_SECRET` (see `.env.example`). Leaving
it unset disables the route entirely (503) — tenant status then only ever
changes via the admin API, exactly as before this feature existed.

To wire it up:

1. In the Paddle dashboard, create a notification destination pointed at
   `https://<your-domain>/webhooks/paddle`, and copy its signing secret into
   `PADDLE_WEBHOOK_SECRET`.
2. Send at least these event types (others are harmlessly ignored):
   `subscription.canceled`, `subscription.past_due`, `subscription.paused`,
   `transaction.payment_failed` (suspend), and `subscription.activated`,
   `subscription.resumed`, `transaction.completed` (reactivate).
3. **Pass `custom_data: { "tenantId": "<this app's tenant id>" }` when
   creating each customer's subscription/transaction via the Paddle API**
   (not the checkout-overlay `passthrough` option, which Paddle does not
   copy onto subsequent webhook events) — this is how the webhook knows
   which tenant an event is about. It's the primary match; a tenant's
   `paddleSubscriptionId` (visible/settable via the admin API, and
   self-filled the first time a custom_data-carrying event for that tenant
   arrives) is only a fallback for events that happen to omit it.

A tenant getting a *new* subscription (a plan change, or cancel-and-
resubscribe) is expected to carry a different subscription id under the
same custom_data.tenantId — the webhook accepts this (logging a
`paddle_webhook_subscription_rebind` warning, not an error) rather than
rejecting it, since there's no way to tell that apart from an operator
mistake at checkout-link creation without a human's judgment. Two tenants
can never end up pointing at the *same* subscription id, though: the admin
API rejects assigning a `paddleSubscriptionId` already used by another
tenant, the webhook's own self-heal write does the same check before
binding one (logging a `paddle_webhook_subscription_conflict` warning and
skipping the binding, without skipping the status change itself, if it
would collide), and a partial unique index on the `tenants` table backs
all of that up even if a bug ever bypassed both checks.

## Load testing

```bash
npm run loadtest -- --url http://localhost:3000 --concurrency 10 --duration 10
```

A baseline tool, not a full performance-testing suite: fires concurrent GET
requests at `/health`, `/leads`, and `/leads/plan` for a fixed duration and
reports throughput and p50/p95/p99 latency. Deliberately read-only — it
never touches `POST /workflow/run`, since a load test that actually sends
real messages to a real tenant's leads is not a load test, it's an
incident. Point `--url`/`--key` at a real deployment only with a tenant
you're deliberately spending traffic budget against; the default (`--key
demo-key` against a local `npm run dev`) is always safe.

At any reasonable concurrency you will see `429`s well before you learn
anything about the server's actual capacity — that's the tenant rate
limiter (60 req/min per key by default) doing its job, not a fault. The
script says so; use a low concurrency/duration to stay under it, or read
this as confirmation the limiter works rather than a performance number.

## Verifying provider credentials

Before a tenant's first real send, run:

```bash
npm run check-providers -- --tenant <id>
```

This makes one real, lightweight, authenticated call per configured
provider (a Twilio account fetch, a SendGrid API-key scope check, an
Anthropic models list if the chatbot or LLM classification is enabled) and
reports pass/fail per provider, exiting non-zero if any fail. It's the
closest thing this repo has to an integration test against real
infrastructure — CI and the unit suite only ever run against emulators
(`pg-mem`) and mocked SDKs, so this is worth running again after rotating
any tenant's credentials, not just at onboarding time.

## Migrations

`src/db/migrations/*.sql` are applied in filename order by
`node dist/scripts/migrate.js`; each is idempotent (`IF NOT EXISTS`, etc.),
so re-running the full set is always safe. Run it once before the first
deploy of a given database, and again any time you pull a commit that adds
a new migration file — there's no separate "pending migrations" tracking,
so just re-run it.

## Rotating the encryption key

`LEADRECOVERY_ENCRYPTION_KEY` can be rotated without downtime:

1. Set `LEADRECOVERY_ENCRYPTION_KEY=<new key>` and
   `LEADRECOVERY_ENCRYPTION_KEY_PREVIOUS=<old key>`, then redeploy the app
   and worker. Nothing breaks: reads try the new key first and fall back
   to the previous one for tenants not yet re-encrypted; every new write
   already uses the new key.
2. Run the batch job that re-encrypts every existing tenant's stored
   credentials under the new key:
   ```bash
   npm run rotate-encryption-key -- --old-key <old key> --new-key <new key>
   ```
   Safe to re-run — it just re-encrypts whatever it finds under the old
   key each time, and reports how many tenants it rotated vs. failed.
3. Once it reports every tenant rotated, remove
   `LEADRECOVERY_ENCRYPTION_KEY_PREVIOUS` and redeploy again. Only now is
   the old key no longer needed anywhere.

Skipping straight to step 1 and never running step 2 works too (nothing
requires completing the rotation promptly), but leaves old-key-encrypted
rows in the database indefinitely — finish the rotation so the old key
can actually be discarded.

## Backups

Everything precious lives in Postgres (tenants, leads, messages) and in
`LEADRECOVERY_ENCRYPTION_KEY` (without it, backed-up tenant channel
credentials are permanently unreadable — see below). Everything else
(the built image, `dist/`, this repo) is regenerable from source and
doesn't need backing up.

- **Docker Compose**: the `postgres` service's data lives in the `pgdata`
  named volume. Back up with a logical dump rather than the volume's raw
  files, so restores aren't tied to matching Postgres versions:
  ```bash
  docker compose exec postgres pg_dump -U leadrecovery leadrecovery > backup.sql
  ```
  Restore into a fresh instance with:
  ```bash
  docker compose up -d postgres
  cat backup.sql | docker compose exec -T postgres psql -U leadrecovery leadrecovery
  ```
- **Your own managed Postgres** (Option 2/3): use whatever
  `pg_dump`/point-in-time-recovery your provider offers; there's nothing
  LeadRecovery-specific here beyond backing up the whole `leadrecovery`
  database (all tables, not just `tenants`).
- **`LEADRECOVERY_ENCRYPTION_KEY` must be backed up separately from the
  database**, in a secrets manager or equivalent — not alongside the SQL
  dump, and not only on the host running the app. A database restore
  without the matching key restores tenants with permanently undecryptable
  Twilio/SendGrid credentials; there's no way to recover them after the
  fact, only to re-enter them per tenant.
- Agree a retention/schedule with whoever hosts the database (daily dumps
  kept for N days is a reasonable starting point for a small deployment);
  this repo doesn't automate backups itself.
- Test a restore before you need one — an untested backup is not a backup.

## Logs and observability

The server and worker log structured JSON lines (one object per line —
`src/logger.ts`) instead of free-form text: request logs, per-tenant worker
tick results, and send/notification/chatbot failures. Pipe stdout/stderr
into whatever log aggregator you use (CloudWatch Logs, Loki, Datadog,
Google Cloud Logging, ...) — no special configuration needed, it's already
one JSON object per line.

Both processes also install a last-resort handler
(`src/fatalErrorHandlers.ts`) for anything that slips past every specific
try/catch already in place — an uncaught exception or unhandled promise
rejection. It logs the error the same way (an `uncaught_exception` /
`unhandled_rejection` line), fires a best-effort operator alert (see below)
bounded by a short timeout, and then exits deliberately (Node's own
guidance: don't keep running with possibly-corrupted state), so your
process manager (systemd, Docker's restart policy, an orchestrator) should
restart it — make sure whatever runs this expects that and restarts on
exit.

### Alerting

Set `OPERATOR_ALERT_WEBHOOK_URL` to a Slack incoming webhook URL (or any
endpoint that accepts a JSON POST with a `text` field — `src/operatorAlert.ts`)
and this app pings it on:

- A fatal error about to crash the server or worker process (the handler
  above).
- A worker tick failing outright (not a single tenant's send failing —
  that's already isolated per-tenant and just logged — but the run itself
  throwing, e.g. the tenant list failing to load).
- A notification (an `interested` reply, or a chatbot escalation)
  permanently failing after exhausting every retry — the same `dead`
  transition `GET /admin/notifications/failed` shows, surfaced proactively
  instead of only on request.

This is entirely optional — unset (the default), none of it fires and
you'd only notice via logs. It's a lightweight, dependency-free floor, not
a substitute for a real APM/error-tracking service if you want deeper
diagnostics (stack traces, breadcrumbs, alerting rules) — see below for
wiring one of those in as well.

Every async Express route handler and the tenant-auth middleware are
wrapped in `src/middleware/asyncHandler.ts` specifically so a single
request-level failure (e.g. Twilio rejecting one lead's malformed phone
number, a transient Postgres error during auth) reaches the server's own
error-handling middleware — a 500 to that one caller — instead of becoming
an unhandled rejection that trips the fatal handler above and takes down
the whole multi-tenant server over one bad request. The fatal handler is
still the right backstop for anything genuinely unexpected; asyncHandler
exists so ordinary request failures never have to be.

There's no metrics/APM or error-tracking (e.g. Sentry) integration built
in. If you want one, the two hook points are exactly the log call sites in
`src/fatalErrorHandlers.ts` (for anything fatal) and `src/logger.ts`'s
`error()` function (for everything logged as an error short of fatal,
which is most of what you'd want alerted on) — add the SDK's capture call
alongside the existing `logger.error(...)` calls, or have your aggregator
alert directly on `"level":"error"` lines instead of adding a second
vendor SDK.

A notification (an `interested` reply, or a chatbot escalation) that fails
to reach a tenant's `notifyWebhookUrl` is retried, then persisted rather
than dropped, and retried again by the worker on every subsequent tick —
see `GET /admin/notifications/failed` in the README's API reference. Check
this endpoint periodically (or rely on the `OPERATOR_ALERT_WEBHOOK_URL`
alert above, which fires the moment one gives up); a growing `dead` count
usually means a tenant's Slack webhook/URL broke.

## Health checks

Two separate endpoints, no auth required:

- **`GET /health`** — pure liveness: 200 as long as the process is up.
  Checks nothing external on purpose — an orchestrator killing/restarting
  the container because the database is briefly unreachable only makes
  things worse. Point a "restart if this fails" check here.
- **`GET /ready`** — readiness: also checks Postgres connectivity
  (`SELECT 1`) when `DATABASE_URL` is set, returning 503 if it can't reach
  the database. Point a "hold traffic back from this instance" check
  (e.g. a Kubernetes readiness probe or load balancer health check) here
  instead — an instance that can't reach the database shouldn't receive
  requests, but doesn't need to be killed either.
