# CSI Workspace — Setup & Deployment

## Requirements

Node.js **22.13+** (uses the built-in `node:sqlite`), or Docker.

## Local development

```bash
cd csi-workspace
npm install
cp .env.example .env        # set DEMO_PASSWORD if you want a fixed demo password
npm run seed                # creates ./data/csi-workspace.db with fictional demo data, prints the demo password
npm run dev                 # API on :4000, client (Vite) on :5173 with /api proxied
```

Open http://localhost:5173 and sign in as one of the demo accounts listed on the login page.

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
