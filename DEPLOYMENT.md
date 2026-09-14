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
  twice. This is enforced by convention, not by code, so it's on you to
  never scale this service beyond 1.
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
above.

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

SendGrid Event Webhook signatures (delivery/bounce/etc. tracking) aren't
affected by the proxy issue — verification there uses SendGrid's own
per-tenant public key (`eventWebhookPublicKey`, set via the tenant API) or
falls back to a shared `?token=` secret in the callback URL, neither of
which depends on how the app sees its own address. See "SendGrid Event
Webhook signing" in `README.md`/`ONBOARDING.md` for how to obtain and set
that key per tenant.

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
one JSON object per line. There's no metrics/APM or error-tracking (e.g.
Sentry) integration built in; add one at the platform level if you need
alerting beyond "grep the logs."

A notification (an `interested` reply, or a chatbot escalation) that fails
to reach a tenant's `notifyWebhookUrl` is retried, then persisted rather
than dropped, and retried again by the worker on every subsequent tick —
see `GET /admin/notifications/failed` in the README's API reference. Check
this endpoint (or alert on it) periodically; a growing `dead` count usually
means a tenant's Slack webhook/URL broke.

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
