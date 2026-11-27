# CSI Workspace — Setup & Deployment

## Requirements

Node.js **22.13+** (uses the built-in `node:sqlite`), or Docker.

## Local development

```bash
cd csi-workspace
npm install
npm run dev          # API on :4000 (redirects browsers to the app), web app on :5173
```

Open http://localhost:5173. Demo data is created automatically on first start in development, and every demo account uses the password `CSI-demo-2026`. Other commands:
- `npm run demo` builds the app and serves everything at http://localhost:4000.
- `npm run reset` deletes the local database.
- `.env` is loaded automatically if present.

## Production on Railway (recommended for the pilot)

Follow **[DEPLOY_RAILWAY.md](DEPLOY_RAILWAY.md)**: GitHub → Railway, with a persistent volume, automatic HTTPS and auto-deploy on push.

## Production (Docker)

```bash
cd csi-workspace
cp .env.example .env   # NODE_ENV=production, PUBLIC_URL=https://workspace.your-domain, BOOTSTRAP_ADMIN_EMAIL/PASSWORD
docker compose up -d --build
```

- On first start with an empty database, `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` create the first administrator (forced to change the password at first sign-in). Remove the password from `.env` afterwards.
- `SEED_DEMO_DATA` is ignored in production unless `ALLOW_DEMO_IN_PRODUCTION=true` (for a demo deployment only).
- Put the container behind an HTTPS reverse proxy (Caddy, nginx, a cloud load balancer). The app trusts one proxy hop in production for client IPs.
- Data lives in the `csi-data` volume (`/data/csi-workspace.db`). Back it up daily, e.g. `sqlite3 /data/csi-workspace.db ".backup '/backups/csi-$(date +%F).db'"`.
- Run a single instance (the automation scheduler is in-process).

## Production (without Docker)

```bash
npm ci && npm run build
NODE_ENV=production PORT=4000 DATABASE_PATH=/var/lib/csi/csi-workspace.db npm start
```

## Enabling integrations

| Feature | Environment | Notes |
|---|---|---|
| Claude AI | `ANTHROPIC_API_KEY`, optional `AI_MODEL` | Switch off anytime in Administration → Settings. Usage is logged in `ai_usage`. |
| Google Workspace sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN`, `PUBLIC_URL` | Create an OAuth client (Web) in Google Cloud Console with redirect URI `${PUBLIC_URL}/auth/google/callback` and scopes `openid email profile`. |
| Drive / Docs / Calendar / Meet / Gmail | — | Not yet implemented (see Administration → Integrations for status and fallbacks). |

## Tests

```bash
npm run typecheck
npm test              # API + permission + AI-layer tests (vitest, in-memory DB)
npm run test:e2e      # Playwright browser smoke tests (builds and starts the app)
```
