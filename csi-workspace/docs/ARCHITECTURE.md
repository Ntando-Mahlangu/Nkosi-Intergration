# CSI Workspace — Architecture

## Why this stack

| Concern | Choice | Reasoning |
|---|---|---|
| Runtime | Node.js 22 + TypeScript | One language across client and server; strong typing for a long-lived internal product. |
| API | Express 4, zod validation | Small, well understood, easy for a future CSI developer or agency to maintain. |
| Database | SQLite via the built-in `node:sqlite` (WAL mode) | Zero-ops for a pilot of tens of users; a single file to back up. All SQL goes through `server/db/index.ts` with bound parameters and lives in route modules, so moving to PostgreSQL later is a contained change (see *Scaling path*). |
| Client | React 18 + React Router + Vite | Component model suits a dense multi-module app; no UI framework lock-in — the design system is ~1 CSS file + `components/ui.tsx`. |
| AI | Anthropic Claude via the official SDK, behind `server/ai/service.ts` | Configurable/disable-able; a deterministic, clearly labelled rule-based engine is used when no key is configured. |
| Auth | Server-side sessions (HttpOnly cookie) + scrypt passwords; optional Google Workspace OIDC | Works with no external dependency; Google sign-in turns on with three env vars. |

Google Sites / Sheets / AppSheet were deliberately **not** used as the core: they can't enforce record-level permissions, audit, or relational integrity the brief requires. CSI Workspace can still be linked from a Google Sites intranet and exchanges data with Sheets via CSV import/export.

## Runtime layout

```
browser ──► Express (server/app.ts)
             ├─ security headers, JSON body limit, session middleware
             ├─ /auth/*            login, logout, password change, Google OIDC
             ├─ /api/* (CSRF header + auth required)
             │    core.ts          me, lookups, comments, document links, entity links, AI feedback
             │    workspace.ts     personal workspace aggregates
             │    tasks.ts         tasks, review workflow, dependencies, CSV export
             │    meetings.ts      meetings, AI/rule extraction, suggestion review, call-report generation
             │    reports.ts       generic report workflow (call, project, Fakawe), versions, export
             │    projects.ts      programmes, projects, members, milestones, deliverables, risks, decisions, updates, dependencies
             │    knowledge.ts     Knowledge Hub, procedures, lessons, versions, access grants
             │    search.ts        permission-aware global search + knowledge assistant
             │    fakawe.ts        reporting periods, draft generation, reporting dashboard
             │    management.ts    executive overview, attention, portfolio, trends
             │    opportunities.ts pipeline, engagements, follow-ups, rule-based signals
             │    learning.ts      learning records, monthly themes, improvement register
             │    admin.ts         users, teams, roles, settings, taxonomies, templates, integrations, automations, audit, import/export, retention
             │    notifications.ts notification centre + preferences
             └─ static client (dist-client) with SPA fallback
automation.ts — hourly scheduler running configurable, deduplicated rules (reminders, retention)
```

## Shared server libraries (`server/lib`)

- `access.ts` — **all record-level authorisation**. Each rule exists as a SQL fragment (for lists, search, reports, exports — restricted rows are never loaded) and as a single-record check.
- `permissions.ts` — permission catalogue and default roles (roles are editable in Administration).
- `events.ts` — audit log, activity feed, notifications (with mute preferences + dedupe keys), status history, settings.
- `progress.ts` — transparent progress (milestones / deliverables / tasks / manual / weighted) and rule-based health *suggestions* with explained factors.
- `http.ts` — error handling (no internals leaked), zod parsing with field-level messages.
- `auth.ts` — scrypt hashing, sessions (token hashed at rest, 7-day absolute / 12-hour idle expiry), CSRF guard, login throttling.

## Data model

Relational, id-based (prefixed random ids, e.g. `tsk_…`), foreign keys enforced. Main tables (see `server/db/migrations/001_core.sql` for every column):

- Identity: `users`, `roles`, `teams`, `sessions`, `settings`, `taxonomy_terms`
- Delivery: `programmes`, `projects`, `project_members`, `milestones`, `deliverables`, `deliverable_versions`, `risks`, `decisions`, `project_updates`, `dependencies`, `status_history`
- Work: `tasks` (+ `task_collaborators`), `comments`, `attachments` (document links)
- Meetings: `meetings`, `meeting_participants`, `ai_suggestions` (proposals awaiting review — never authoritative)
- Knowledge: `knowledge_items`, `knowledge_versions`, `knowledge_access`, `entity_links` (generic "related records" graph)
- Reporting: `report_templates`, `reporting_periods`, `reports`, `report_versions`
- Growth: `opportunities`, `learning_themes`, `learning_records`, `improvements`
- Platform: `notifications`, `activity`, `audit_log`, `automation_rules`, `automation_runs`, `ai_usage`, `ai_feedback`

Key relationships: a project has many tasks/meetings/milestones/deliverables/risks/decisions/updates; a meeting has many participants (internal users or external names) and many tasks (`tasks.meeting_id`); a task may link to a project, meeting, deliverable and milestone and have many dependencies; reports reference meetings/projects/periods and keep `source_records`; `entity_links` relate any two records (knowledge ↔ projects, opportunities ↔ meetings, …).

Migrations are plain SQL files applied in order and recorded in `schema_migrations`.

## AI design

`server/ai/service.ts` is the only place that talks to a model.

- **Engine selection**: Claude (`AI_MODEL`, default `claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set *and* the admin setting `ai.enabled` is on; otherwise the rule engine. The engine used is stored on every suggestion/report (`engine` / `generated_by`) and shown in the UI (`AIBadge`).
- **Meeting analysis** uses structured outputs (JSON schema, validated again with zod). The system prompt forbids inventing owners, deadlines and decisions and requires verbatim evidence for each item. Results are stored as `ai_suggestions` and only become tasks/decisions/risks when a person accepts them; accepted actions become *suggested* tasks the assignee must confirm.
- **Drafting** (Fakawe executive overview, theme summaries) receives only facts already filtered by the requesting user's permissions; without AI the caller uses a deterministic template — nothing pretends to be AI.
- **Knowledge assistant** retrieves permitted sources first (same SQL access rules), sends only those, and drops any citation id the model returns that wasn't supplied.
- Failures (network, refusal, invalid JSON, truncation) fall back to the labelled rule engine and are logged in `ai_usage`.

## Scaling path

- SQLite comfortably serves a pilot (tens of concurrent users). For organisation-wide use move to PostgreSQL: replace `Db` in `server/db/index.ts` with a `pg` pool exposing the same `all/get/run/insert/update/tx` surface (async), port the migration SQL (types are already portable: TEXT/INTEGER/REAL; replace `julianday` date maths and `INSERT OR IGNORE`).
- Search uses indexed `LIKE` matching; switch to SQLite FTS5 or Postgres full-text when the corpus grows.
- The automation scheduler runs in-process; run a single instance (or move rules to a job queue) to avoid duplicate runs — dedupe keys already make reruns idempotent for notifications.
