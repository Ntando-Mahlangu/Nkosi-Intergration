# CSI Workspace — Security & Privacy

## Controls implemented

- **Authentication**: scrypt password hashing (N=16384), server-side sessions; the session token is random (256-bit) and stored only as a SHA-256 hash. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `PUBLIC_URL` is https. 7-day absolute and 12-hour idle expiry. Password change revokes other sessions; deactivation revokes all sessions.
- **Google Workspace sign-in** (optional): OIDC authorization-code flow with `state` check, server-side code exchange, ID-token validated by Google (`aud`, `iss`, `email_verified`), optional hosted-domain restriction. Accounts are never self-provisioned — an administrator must create the user first.
- **Brute-force protection**: per IP+email login throttling (10 attempts / 15 minutes); failed logins are audited.
- **CSRF**: all state-changing requests must carry the `x-csi-request: 1` header (not settable cross-site without CORS, which is never enabled) in addition to SameSite cookies.
- **Authorisation is server-side**: permissions per role (editable) + record-level rules in `server/lib/access.ts`, applied as SQL predicates so restricted records are never loaded for lists, search, AI prompts, reports or exports. UI hiding is cosmetic only.
- **Input validation**: zod schemas on every write; URLs must be http(s); size limits on text fields and a 2 MB request body limit.
- **Output safety**: React escapes all content; no `dangerouslySetInnerHTML` with user content; exported HTML is escaped; CSV exports neutralise spreadsheet formulas.
- **Headers**: CSP (`script-src 'self'`), `X-Frame-Options: SAMEORIGIN`, `nosniff`, strict referrer policy, HSTS on https.
- **Errors**: generic messages to clients; details only in server logs.
- **Secrets**: only via environment variables (`.env` is git-ignored); nothing hardcoded. Demo passwords are generated at seed time unless `DEMO_PASSWORD` is set.
- **Audit log**: logins (success/failure), logout, password changes, user/role/permission changes, task assignment, project status changes, meeting approval, report approval, imports, exports, integration/settings changes, retention purges.

## Privacy by design (no surveillance)

- Personal tasks are visible only to their creator/assignee — not to management or administrators.
- Confidential meetings are visible only to participants/organiser.
- Restricted projects are visible only to their members — administrators and management have no bypass.
- Private learning records are visible only to their author. Learning contributions are never turned into performance metrics.
- Management dashboards aggregate by project, not by person; there are no individual productivity rankings.
- Gmail/Calendar integrations are opt-in and not enabled by default; nothing reads inboxes.

## Data retention

Configurable in Administration → Data (sessions, notifications, AI suggestions, audit log, meeting transcripts). Enforced daily by the `retention_purge` automation, which records counts of what it removed in the audit log.

## Operational recommendations

- Serve only over HTTPS (set `PUBLIC_URL=https://…`) behind a reverse proxy; keep `NODE_ENV=production`.
- Back up the SQLite file (and `-wal`) daily, encrypted at rest (disk/volume encryption).
- Restrict who holds `admin.roles`; review the audit log periodically.
- Rotate the Anthropic API key and Google client secret via the environment; AI can be switched off instantly in Settings.
- Before loading real data, purge demo data (Administration → Data) or start from a fresh database without `SEED_DEMO_DATA`.
