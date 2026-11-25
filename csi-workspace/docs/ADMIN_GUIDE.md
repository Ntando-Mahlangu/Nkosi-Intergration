# CSI Workspace — Administrator Guide

Administration appears in the sidebar for anyone who holds an `admin.*` permission. Each tab needs its own permission, and the server enforces it.

## First run

1. Deploy (see DEPLOYMENT.md) with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`. Sign in, then choose a new password.
2. **Settings:** set the organisation name, timezone and currency, the AI on/off switch, the default progress method, the health rules and the reminder window.
3. **Roles & permissions:** adjust the five default roles, or add your own. CSI does not have to use every role.
4. **Teams**, then **Users.** Each new user gets a one-time temporary password, shown once, and must change it at first sign-in. For Google sign-in, create the user with *Google only*.
5. **Taxonomies:** project categories, knowledge categories, meeting types, opportunity types, task types and improvement areas.
6. **Report templates:** call report variants, the Fakawe digest and the project report. You can rename, reorder and enable or disable sections.
7. If you seeded demo data, use **Data → Purge demo data** before loading real information.

## Roles (defaults)

| Role | Key permissions |
|---|---|
| Employee | create meetings, contribute knowledge, use AI |
| Project Owner / Manager | + create projects, review call reports, manage opportunities |
| Management | + view team projects, programmes, assign tasks to anyone, management intelligence, approve decisions & Fakawe, learning themes |
| Knowledge Manager / Reporting Coordinator | + publish/curate knowledge, manage Fakawe periods & drafts, review reports |
| System Administrator | users, roles, settings, audit, data (no automatic access to restricted project content) |

**Safeguards:**
- You cannot deactivate yourself.
- No change can leave the system without an active user who can manage roles.
- Users are deactivated, never deleted, so history is preserved.

## Record-level privacy (not configurable by role)

- Restricted projects are visible to members only.
- Confidential meetings are visible to participants only.
- Personal tasks are visible to their owner only.
- Private learning records are visible to their author only.

These rules also apply to search, AI prompts, reports and exports, including for administrators.

## Integrations

**Integrations** shows each integration as *configured*, *not configured* or *planned*, together with the fallback in use. Today:

| Integration | Status | How to enable / fallback |
|---|---|---|
| Google Workspace sign-in | Built, off until configured | Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN`. |
| Claude AI | Built, off until configured | Set `ANTHROPIC_API_KEY` and turn AI on in Settings. Without it, the labelled rule-based engine is used. |
| Drive, Docs, Calendar, Meet, Gmail, email notifications | Planned, not built | Fallbacks: paste document links; export reports to PDF, HTML or Markdown; meeting links on records; in-app notifications. |

## Automations

Each rule can be switched on or off, run immediately with **Run now**, and has a run history. All rules are deduplicated, so running them again never repeats a notification. The rules cover:

- task due, overdue and review reminders
- milestones and deliverables coming due
- meeting preparation reminders
- opportunity follow-ups
- reporting-deadline reminders
- knowledge review dates
- retention enforcement.

## Audit log

The audit log records:
- sign-ins, including failures
- user and permission changes
- task assignment and project status changes
- meeting and report approvals
- imports and exports
- settings and integration changes
- retention purges.

You can filter it and export it to CSV.

## Data

- **Import (CSV):** tasks or projects. Paste or upload the file, map the columns, then preview. The preview flags invalid dates, unknown people or projects, invalid statuses and likely duplicates. Commit imports the valid rows and reports what was skipped.
- **Export (CSV):** tasks, projects, meetings, knowledge, opportunities, decisions and risks. Exports contain only what *you* are allowed to see, and every export is audited.
- **Retention:** set the number of days to keep sessions, notifications, AI suggestions, the audit log (minimum one year) and meeting transcripts. Use 0 to keep forever. The daily retention automation enforces these settings.
- **Backups:** back up the database file daily (see DEPLOYMENT.md).
