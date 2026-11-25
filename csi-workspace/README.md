# CSI Workspace

**One connected workspace for knowledge, people, projects and execution** — an internal platform for Change Science Institute (CSI).

> Capture information once. Connect it intelligently. Turn it into action. Track execution. Learn from the results.

CSI Workspace brings together personal work management, meetings and action capture, project and programme delivery, the Knowledge Hub, call reports and Fakawe digests, management intelligence, the opportunity pipeline, and organisational learning. All of these share one permission model and one relational data model.

## Quick start

```bash
cd csi-workspace
npm install
DEMO_PASSWORD='Choose-a-demo-pass-1' npm run seed   # fictional demo data
npm run dev                                         # http://localhost:5173
```

Sign in with a demo account from the login page, such as `lerato@demo.csi.example` (Employee) or `naledi@demo.csi.example` (Management). All demo people, organisations and outcomes are **fictional**, live on the reserved `.example` domain, carry an `is_demo` flag, and can be purged from Administration → Data.

| Demo account | Role | Good for exploring |
|---|---|---|
| lerato@ | Employee | Personal workspace, tasks due today/overdue, a suggested meeting action to confirm |
| thabo@, pieter@ | Employee | Blocked tasks and dependencies; Pieter is a member of the *restricted* project |
| sipho@, ayesha@ | Project Owner / Manager | Projects, deliverable reviews, meeting suggestion review (Ayesha: "D4C partner check-in") |
| naledi@ | Management | Management Intelligence, decision approvals, Fakawe approval |
| zanele@ | Knowledge Manager / Reporting Coordinator | Knowledge review queue, Fakawe generation |
| grace@ | System Administrator | Users, roles, settings, audit, import/export — but *not* restricted project content |

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
