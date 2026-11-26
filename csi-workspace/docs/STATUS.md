# CSI Workspace — Implementation Status

_Last verified: 2026-11-26 (local and GitHub Actions)._

## Test results

| Suite | Result |
|---|---|
| `npm run typecheck` (server + client) | passing |
| `npm test`: 16 files / 119 API, permission and AI-layer tests (in-memory DB) | 119 passed |
| `npm run test:e2e`: Playwright, real built app (desktop + mobile) | 7 passed |
| `npm run build` | passing (initial JS ~209 kB, modules lazy-loaded) |

The tests cover:
- sign-in, CSRF protection and throttling
- role and record-level access (restricted projects, confidential meetings, personal tasks, private learning, project-member knowledge, management-only content)
- counts on the personal workspace
- the task review and confirmation workflows and dependency cycles
- meeting extraction, the suggestion review, and the rule that nothing is created automatically
- call-report generation only after approval
- report workflow permissions and safe export
- project progress methods and health factors
- deliverable versions and decision approvals
- knowledge versioning and search exclusions
- Fakawe generation scope and quality flags
- management access
- opportunity confidentiality and signals
- the improvement workflow
- admin safeguards, import validation, permission-aware exports, automation dedupe and retention
- the Claude request shape and fallback, tested against a local mock of the Messages API.

The browser tests also walk the full meeting flow: notes → extraction → accept → approve → call report.

## Fully functional (no external services needed)

- Authentication: password sign-in, sessions, forced password change, throttling, audit.
- Configurable roles and permissions; record-level privacy enforced server-side.
- My CSI Workspace: live counts, outstanding actions, active projects, upcoming meetings, activity feed and quick actions.
- Tasks: create, assign, prioritise, add dependencies and collaborators, the review workflow, confirmation of suggested tasks, comments, document links and CSV export.
- Meetings: structured or pasted/uploaded notes, participants (including external people), rule-based extraction, the review screen, approval, decisions, history and timeline.
- Call reports, project reports and Fakawe digests: generation, editing, versioning, the review/approve/publish workflow and PDF (via print)/HTML/Markdown export.
- Projects and programmes:
  - portfolio, project creation and members
  - milestones, deliverables (submissions with versions and review), and the risk/issue register
  - decision log with management approvals, project updates and dependencies with affected work
  - transparent progress and suggested health.
- Knowledge Hub: categories, tags, procedures, lessons learned, review workflow, versions, restricted access, discovery, related and similar items.
- Global search across 15 record types, filtered by permissions.
- Fakawe reporting periods, dashboard, draft generation with sources and quality flags.
- Management Intelligence: overview, attention required (with reasons), portfolio, decisions, and trends (shown only when there is enough data).
- Opportunity pipeline: kanban and list views, engagements, follow-up tasks, related records, rule-based signals.
- Learning records (shared or private), monthly themes and the improvement register.
- Notifications centre with per-type muting; automation engine with 11 deduplicated rules.
- Administration:
  - users, teams, roles, settings and taxonomies
  - report templates, integration status and automations
  - audit log, CSV import (with preview) and export
  - retention and demo-data purge.
- Responsive layout (mobile bottom navigation), keyboard and screen-reader support, focus states, and status shown with icon and text rather than colour alone.

## Requires credentials or configuration (implemented, but off by default)

| Feature | Needs | Notes |
|---|---|---|
| AI meeting analysis, Fakawe executive overview, knowledge assistant answers, theme summary drafts | `ANTHROPIC_API_KEY` (paid Anthropic API usage) | Verified against a mock of the API, **not** against the live API from this environment. Without a key, the rule-based engine and templates are used and labelled. |
| Google Workspace sign-in | Google Cloud OAuth client + Workspace admin approval | Implemented (OIDC); not tested against Google from this environment. |

## Planned, not yet implemented

- Google Drive file picker/metadata sync, Google Docs generation, Calendar sync, Meet transcript import, Gmail email-to-task. Today these work through pasted document links, PDF/HTML/Markdown export, meeting links and manual task creation.
- Email notifications (needs an SMTP or transactional email provider). Notifications are in-app only.
- Excel (.xlsx) import/export (CSV is supported and opens in Excel and Sheets).
- File uploads stored in the app (documents are referenced by secure link instead).
- Weighted task-level progress and configurable task statuses beyond the defaults (the setting exists; the UI uses the default set).

## Known limitations

- SQLite suits a pilot (tens of users). Use PostgreSQL for organisation-wide scale (migration path in ARCHITECTURE.md).
- Search uses indexed `LIKE` matching, not full-text ranking.
- The automation scheduler runs in-process, so run a single instance.
- Rule-based extraction only finds explicitly marked items. It deliberately does not guess.
- Seeded demo records have no status history, so history panels fill in as people use the app.
- A Fakawe digest only contains what the *generating* user may see. A coordinator who is not a member of a team-visibility project will not see that project in their draft. Grant `project.view_all` to coordinators if CSI wants full coverage.
- Decisions can be approved from either the project's Decisions tab or Management → Decisions. Both use the same permission and audit rules.

## Recommended next steps

1. Pilot with a small group on real work. Configure roles and taxonomies, and purge demo data first.
2. Add `ANTHROPIC_API_KEY` and validate the meeting extraction quality on real CSI notes.
3. Enable Google Workspace sign-in.
4. Build Google Drive and Calendar integration (read-only scopes first).
5. Add email notifications, starting with a daily digest.
6. Plan the move to PostgreSQL and full-text search before an organisation-wide rollout.
