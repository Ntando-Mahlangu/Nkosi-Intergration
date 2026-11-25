/**
 * Idempotent defaults written on every start: roles, settings, taxonomies,
 * report templates, automation rules. Existing admin edits are never overwritten.
 */
import type { Db } from "./index.js";
import { DEFAULT_ROLES } from "../lib/permissions.js";
import { newId, nowIso } from "../lib/ids.js";

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  "org.name": "Change Science Institute",
  "org.short_name": "CSI",
  "org.timezone": "Africa/Johannesburg",
  "org.currency": "ZAR",
  "ai.enabled": true,
  "projects.default_progress_method": "milestones",
  "projects.health_rules": { overdueMilestoneDays: 0, blockedTasksForAttention: 1, staleUpdateDays: 14 },
  "tasks.statuses": ["suggested", "todo", "in_progress", "blocked", "awaiting_review", "completed", "cancelled"],
  "tasks.priority_labels": { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" },
  "notifications.reminder_days_before_due": 2,
  "notifications.email_enabled": false,
  "retention.audit_days": 2555,
  "retention.notifications_days": 180,
  "retention.ai_suggestions_days": 365,
  "retention.sessions_days": 30,
  "retention.meeting_transcripts_days": 0,
  "fakawe.default_audience": "management",
};

export const DEFAULT_TAXONOMIES: Record<string, string[]> = {
  project_category: ["Programme delivery", "Research", "Corporate learning", "Partnership", "Product development", "Events", "Operations"],
  knowledge_category: [
    "Research", "Reports", "Publications", "Presentations", "Frameworks", "Methodologies", "Programme resources", "Project lessons",
    "Procedures", "Internal guides", "Meeting insights", "Decisions", "Partnership knowledge", "Case studies", "Learning resources", "Templates", "Other",
  ],
  meeting_type: ["Internal planning", "Project meeting", "Partner meeting", "Client / corporate", "Programme meeting", "Management", "Supplier", "Workshop"],
  opportunity_type: [
    "Corporate programme", "Business development", "Research partnership", "Strategic partnership", "Programme expansion",
    "Event", "Funding", "Collaboration", "Product development", "Other",
  ],
  task_type: ["Action", "Follow-up", "Preparation", "Review", "Admin", "Research", "Writing"],
  improvement_area: ["Operations", "Reporting", "Meetings", "Programme delivery", "Knowledge", "Tools & systems", "People & culture", "Finance & admin"],
};

const CALL_SECTIONS = [
  ["overview", "Meeting overview"], ["participants", "Participants"], ["discussion", "Key discussion points"], ["decisions", "Decisions"],
  ["actions", "Action items"], ["risks", "Risks and blockers"], ["next_steps", "Next steps"], ["project_context", "Project context"], ["documents", "Related documents"],
];
const FAKAWE_SECTIONS = [
  ["executive_overview", "Executive overview"], ["developments", "Major organisational developments"], ["project_updates", "Project and programme updates"],
  ["completed", "Completed activities"], ["milestones", "Milestones and deliverables achieved"], ["outstanding", "Outstanding actions"],
  ["risks", "Risks and blockers"], ["upcoming", "Upcoming priorities"], ["decisions_required", "Decisions required"],
  ["opportunities", "Partnerships and opportunities"], ["lessons", "Lessons and insights"], ["references", "Supporting references"],
];
const toSections = (a: string[][]) => a.map(([key, title]) => ({ key, title, enabled: true }));

export const DEFAULT_TEMPLATES = [
  { report_type: "call_report", name: "Standard call report", sections: toSections(CALL_SECTIONS), is_default: 1 },
  { report_type: "call_report", name: "Partner meeting report", sections: toSections(CALL_SECTIONS.filter(([k]) => k !== "project_context")), is_default: 0 },
  { report_type: "call_report", name: "Internal planning report", sections: toSections(CALL_SECTIONS.filter(([k]) => !["participants", "documents"].includes(k))), is_default: 0 },
  { report_type: "fakawe", name: "Fakawe digest", sections: toSections(FAKAWE_SECTIONS), is_default: 1 },
  {
    report_type: "project_report",
    name: "Project status report",
    sections: toSections([["overview", "Overview"], ["progress", "Progress"], ["milestones", "Milestones"], ["deliverables", "Deliverables"], ["risks", "Risks and issues"], ["decisions", "Decisions"], ["next_steps", "Next steps"]]),
    is_default: 1,
  },
];

export const DEFAULT_AUTOMATIONS = [
  { key: "task_due_reminders", name: "Task due reminders", trigger: "daily schedule", action: "notify assignee", description: "Notify assignees of tasks due today or within the configured reminder window." },
  { key: "task_overdue", name: "Overdue task alerts", trigger: "daily schedule", action: "notify assignee", description: "Notify assignees once per day for each overdue task (deduplicated)." },
  { key: "review_reminders", name: "Pending review reminders", trigger: "daily schedule", action: "notify reviewer", description: "Remind reviewers of tasks awaiting review for more than 2 days." },
  { key: "milestone_approaching", name: "Milestone approaching", trigger: "daily schedule", action: "notify milestone owner and project owner", description: "Milestones due within 7 days." },
  { key: "deliverable_due", name: "Deliverable due", trigger: "daily schedule", action: "notify deliverable owner", description: "Deliverables due within 3 days that are not yet submitted." },
  { key: "meeting_upcoming", name: "Meeting preparation", trigger: "daily schedule", action: "notify participants", description: "Remind participants of meetings tomorrow, flagging preparation if required." },
  { key: "opportunity_follow_up", name: "Opportunity follow-up", trigger: "daily schedule", action: "notify opportunity owner", description: "Follow-up date reached." },
  { key: "fakawe_missing_updates", name: "Reporting deadline reminders", trigger: "daily schedule", action: "notify project owners", description: "Remind owners of active projects without an update in the open reporting period, 2 days before the deadline." },
  { key: "knowledge_review_due", name: "Knowledge review due", trigger: "daily schedule", action: "notify knowledge owner", description: "Procedures and knowledge items past their review date." },
  { key: "meeting_actions_review", name: "Meeting actions ready", trigger: "meeting notes processed", action: "notify meeting owner", description: "Tell the meeting owner when suggested actions are ready for review." },
  { key: "retention_purge", name: "Retention policy enforcement", trigger: "daily schedule", action: "delete expired records", description: "Apply configured retention periods (sessions, notifications, AI suggestions, audit log, transcripts)." },
];

export function bootstrap(db: Db) {
  const now = nowIso();
  db.tx(() => {
    for (const r of DEFAULT_ROLES) {
      db.run(
        "INSERT OR IGNORE INTO roles (key, name, description, permissions, is_system, sort_order) VALUES (?, ?, ?, ?, 1, ?)",
        r.key, r.name, r.description, JSON.stringify(r.permissions), r.sort,
      );
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      db.run("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)", k, JSON.stringify(v), now);
    }
    for (const [tax, labels] of Object.entries(DEFAULT_TAXONOMIES)) {
      const has = db.get("SELECT 1 FROM taxonomy_terms WHERE taxonomy = ? LIMIT 1", tax);
      if (has) continue;
      labels.forEach((label, i) => db.insert("taxonomy_terms", { id: newId("tax"), taxonomy: tax, label, sort_order: i, active: 1 }));
    }
    if (!db.get("SELECT 1 FROM report_templates LIMIT 1")) {
      for (const t of DEFAULT_TEMPLATES) {
        db.insert("report_templates", { id: newId("tpl"), report_type: t.report_type, name: t.name, sections: JSON.stringify(t.sections), is_default: t.is_default, active: 1, created_at: now, updated_at: now });
      }
    }
    for (const a of DEFAULT_AUTOMATIONS) {
      db.run("INSERT OR IGNORE INTO automation_rules (key, name, description, trigger, action, enabled) VALUES (?, ?, ?, ?, ?, 1)", a.key, a.name, a.description, a.trigger, a.action);
    }
  });
}
