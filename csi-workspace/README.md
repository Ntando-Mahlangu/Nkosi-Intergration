# CSI Workspace

**One connected workspace for knowledge, people, projects and execution** — an internal platform for Change Science Institute (CSI).

> Capture information once. Connect it intelligently. Turn it into action. Track execution. Learn from the results.

CSI Workspace brings together personal work management, meetings and action capture, project and programme delivery, the Knowledge Hub, call reports and Fakawe digests, management intelligence, the opportunity pipeline, and organisational learning. All of these share one permission model and one relational data model.

## Quick start

Requires **Node.js 22.13 or newer** (`node -v` to check; get the LTS from nodejs.org).

```bash
cd csi-workspace
npm install
npm run dev
```

Open **http://localhost:5173**. On first start, fictional demo data is created automatically. Every demo account uses the password **`CSI-demo-2026`** (development only), and the login page lists the accounts; click one to fill it in.

Prefer a single address? `npm run demo` builds the app and serves everything at **http://localhost:4000**. To start over with fresh demo data, run `npm run reset`.

All demo people, organisations and outcomes are **fictional**. They use the reserved `.example` email domain, carry an `is_demo` flag, and can be purged from Administration → Data.

**If localhost doesn't load:**
- Make sure the terminal shows `➜ Open http://localhost:…` and use that address.
- "Port already in use" means another program has the port. Close it, or set `PORT=4100` in `.env`.
- "Needs Node.js 22.13" means you should update Node.

| Demo account | Role | Good for exploring |
|---|---|---|
| lerato@ | Employee | Personal workspace, tasks due today/overdue, a suggested meeting action to confirm |
| thabo@, pieter@ | Employee | Blocked tasks and dependencies; Pieter is a member of the *restricted* project |
| sipho@, ayesha@ | Project Owner / Manager | Projects, deliverable reviews, meeting suggestion review (Ayesha: "D4C partner check-in") |
| naledi@ | Management | Management Intelligence, decision approvals, Fakawe approval |
| zanele@ | Knowledge Manager / Reporting Coordinator | Knowledge review queue, Fakawe generation |
| grace@ | System Administrator | Users, roles, settings, audit, import/export — but *not* restricted project content |

## Branding

The logo mark (`client/public/logo-mark.svg`, `client/src/components/Logo.tsx`) is a vector recreation of the supplied CSI logo. It is used as the brand mark, favicon and background artwork, and the interface colours are drawn from it. To use the original artwork file instead, replace `client/public/logo-mark.svg`.

## Documentation

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md): day-to-day use for employees, project owners and management
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md): administration, roles, integrations, data and automations
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): stack, architecture, data model, AI design, scaling path
- [docs/SECURITY.md](docs/SECURITY.md): security controls, privacy by design, retention
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): setup, Docker, production, enabling integrations, tests
- [docs/STATUS.md](docs/STATUS.md): what is fully working, what needs credentials, what is planned, test results, known limitations

## Stack

Node.js 22 · TypeScript · Express · SQLite (`node:sqlite`) · React 18 · Vite · Anthropic Claude (optional) · Vitest · Playwright.

## Project layout

```
server/            API (Express): app.ts, routes/*, lib/* (access control, events, progress), ai/, integrations/, db/ (migrations, seed)
client/src/        React app: components/ (design system), lib/ (API, auth, status), pages/<module>/
tests/             API, permission and AI-layer tests (in-memory DB)
e2e/               Playwright browser tests (desktop + mobile)
docs/              Guides
```
