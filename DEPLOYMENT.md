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
  replicas of.
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

## Migrations

`src/db/migrations/*.sql` are applied in filename order by
`node dist/scripts/migrate.js`; each is idempotent (`IF NOT EXISTS`, etc.),
so re-running the full set is always safe. Run it once before the first
deploy of a given database, and again any time you pull a commit that adds
a new migration file — there's no separate "pending migrations" tracking,
so just re-run it.

## Health checks

`GET /health` returns 200 with no auth required — point your platform's or
proxy's health check at it. It does not check database connectivity; a
persistently red app after a green `/health` check usually means the
worker or a webhook is failing against Postgres, not that the app is down.
