-- CSI Workspace core schema.
-- Conventions:
--   * Every primary key is a TEXT id with an entity prefix (usr_, prj_, tsk_ ...), generated in server/lib/ids.ts.
--   * Timestamps are ISO-8601 UTC strings; calendar dates (due dates etc.) are 'YYYY-MM-DD'.
--   * Relationships always use ids + foreign keys, never names.
--   * is_demo = 1 marks fictional demonstration records so they can be identified and purged.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity & access
CREATE TABLE roles (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',   -- JSON array of permission strings
  is_system INTEGER NOT NULL DEFAULT 0,      -- system roles cannot be deleted
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  lead_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role_key TEXT NOT NULL REFERENCES roles(key),
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  job_title TEXT NOT NULL DEFAULT '',
  password_hash TEXT,                        -- null for Google-only accounts
  auth_provider TEXT NOT NULL DEFAULT 'local', -- local | google
  active INTEGER NOT NULL DEFAULT 1,
  preferences TEXT NOT NULL DEFAULT '{}',    -- JSON: notification prefs, timezone, etc.
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_users_team ON users(team_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                       -- sha256 of the opaque token (token itself never stored)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                       -- JSON value
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Configurable taxonomies: project categories, knowledge categories, meeting types, opportunity types, task types, tags...
CREATE TABLE taxonomy_terms (
  id TEXT PRIMARY KEY,
  taxonomy TEXT NOT NULL,                    -- project_category | knowledge_category | meeting_type | opportunity_type | task_type | improvement_area
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (taxonomy, label)
);

-- ---------------------------------------------------------------- programmes & projects
CREATE TABLE programmes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',     -- active | paused | closed
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  code TEXT,                                 -- optional short code e.g. UNM
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  objectives TEXT NOT NULL DEFAULT '',       -- newline-separated list
  intended_outcomes TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  stakeholders TEXT NOT NULL DEFAULT '',
  reporting_requirements TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  programme_id TEXT REFERENCES programmes(id) ON DELETE SET NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'planning',   -- proposed | planning | active | on_hold | at_risk | completed | cancelled
  health TEXT NOT NULL DEFAULT 'on_track',   -- on_track | needs_attention | at_risk | blocked | completed
  health_note TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  start_date TEXT,
  target_date TEXT,
  completed_date TEXT,
  budget_amount REAL,
  budget_currency TEXT NOT NULL DEFAULT 'ZAR',
  budget_notes TEXT NOT NULL DEFAULT '',
  progress_method TEXT NOT NULL DEFAULT 'milestones', -- milestones | deliverables | tasks | manual | weighted
  manual_progress INTEGER,                   -- 0..100 when progress_method = manual
  visibility TEXT NOT NULL DEFAULT 'organisation', -- organisation | team | restricted
  drive_folder_url TEXT NOT NULL DEFAULT '',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_owner ON projects(owner_id);
CREATE INDEX idx_projects_programme ON projects(programme_id);
CREATE INDEX idx_projects_status ON projects(status);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',       -- owner | manager | member | viewer
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_project_members_user ON project_members(user_id);

CREATE TABLE status_history (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,                 -- project | task | deliverable | milestone | opportunity | report ...
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,                       -- status | health | stage | review_status
  from_value TEXT,
  to_value TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX idx_status_history_entity ON status_history(entity_type, entity_id);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'not_started', -- not_started | in_progress | achieved | missed | cancelled
  completed_date TEXT,
  weight INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  evidence_url TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_milestones_project ON milestones(project_id);

CREATE TABLE deliverables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'not_started', -- not_started | in_progress | submitted | under_review | changes_requested | approved | completed | cancelled
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  submission_url TEXT NOT NULL DEFAULT '',
  submission_note TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_deliverables_project ON deliverables(project_id);

CREATE TABLE deliverable_versions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  submission_url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL
);

CREATE TABLE risks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'risk',         -- risk | issue | blocker
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'medium',   -- low | medium | high | critical
  likelihood TEXT,                           -- low | medium | high (risks only)
  impact TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  identified_date TEXT NOT NULL,
  mitigation TEXT NOT NULL DEFAULT '',
  action_plan TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',       -- open | mitigating | monitoring | resolved | closed
  review_date TEXT,
  source_meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_risks_project ON risks(project_id);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  consequences TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  decision_maker_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_date TEXT,
  status TEXT NOT NULL DEFAULT 'made',       -- proposed | pending_approval | made | approved | rejected | superseded | revisited
  requires_management INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_project ON decisions(project_id);

CREATE TABLE project_updates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  achievements TEXT NOT NULL DEFAULT '',
  next_steps TEXT NOT NULL DEFAULT '',
  blockers TEXT NOT NULL DEFAULT '',
  health TEXT,
  progress INTEGER,
  period_start TEXT,
  period_end TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_project_updates_project ON project_updates(project_id, created_at);

-- Generic dependency edges between projects / milestones / deliverables / tasks.
CREATE TABLE dependencies (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,                   -- the dependent item ("X depends on Y": X is from)
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (from_type, from_id, to_type, to_id)
);
CREATE INDEX idx_dependencies_to ON dependencies(to_type, to_id);

-- ---------------------------------------------------------------- meetings
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  meeting_type TEXT NOT NULL DEFAULT 'internal',
  purpose TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  programme_id TEXT REFERENCES programmes(id) ON DELETE SET NULL,
  meeting_date TEXT NOT NULL,                -- YYYY-MM-DD
  start_time TEXT,                           -- HH:MM
  end_time TEXT,
  timezone TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
  location TEXT NOT NULL DEFAULT '',
  meeting_link TEXT NOT NULL DEFAULT '',
  organiser_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '',            -- human-entered notes (the record)
  transcript TEXT NOT NULL DEFAULT '',       -- imported transcript, if authorised
  transcript_source TEXT NOT NULL DEFAULT '',-- e.g. 'pasted', 'uploaded:file.txt'
  key_points TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',          -- human-approved summary
  summary_source TEXT NOT NULL DEFAULT '',   -- '' | human | ai_approved
  follow_up_date TEXT,
  preparation_required INTEGER NOT NULL DEFAULT 0,
  preparation_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | notes_submitted | in_review | approved | cancelled
  review_status TEXT NOT NULL DEFAULT 'not_started', -- not_started | pending | approved
  confidential INTEGER NOT NULL DEFAULT 0,   -- participants-only visibility
  calendar_event_id TEXT NOT NULL DEFAULT '',
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_meetings_project ON meetings(project_id);
CREATE INDEX idx_meetings_date ON meetings(meeting_date);

CREATE TABLE meeting_participants (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  external_name TEXT NOT NULL DEFAULT '',     -- for non-CSI participants
  external_org TEXT NOT NULL DEFAULT '',
  attendance TEXT NOT NULL DEFAULT 'invited', -- invited | attended | apologies
  id TEXT PRIMARY KEY
);
CREATE INDEX idx_meeting_participants_meeting ON meeting_participants(meeting_id);
CREATE INDEX idx_meeting_participants_user ON meeting_participants(user_id);

-- AI (or rule-based) proposals awaiting human review. Nothing here is authoritative until accepted.
CREATE TABLE ai_suggestions (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,                 -- meeting | report | knowledge | opportunity
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- summary | action | decision | risk | blocker | project_update | knowledge | follow_up_question | opportunity | milestone_update
  payload TEXT NOT NULL,                     -- JSON: title, description, owner_hint, owner_id, due_date, evidence, confidence ...
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | accepted | rejected | edited_accepted
  engine TEXT NOT NULL,                      -- 'anthropic:<model>' | 'rules'
  resulting_type TEXT,
  resulting_id TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_suggestions_source ON ai_suggestions(source_type, source_id);

-- ---------------------------------------------------------------- tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  ref INTEGER NOT NULL UNIQUE,               -- human friendly number: T-1042
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  programme_id TEXT REFERENCES programmes(id) ON DELETE SET NULL,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  deliverable_id TEXT REFERENCES deliverables(id) ON DELETE SET NULL,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'personal',   -- personal | meeting | project | deliverable | management | email | knowledge | opportunity | automation | import
  source_ref TEXT NOT NULL DEFAULT '',       -- free-text or id of originating record
  task_type TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  status TEXT NOT NULL DEFAULT 'todo',       -- suggested | todo | in_progress | blocked | awaiting_review | completed | cancelled
  due_date TEXT,
  start_date TEXT,
  completed_at TEXT,
  review_required INTEGER NOT NULL DEFAULT 0,
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_status TEXT NOT NULL DEFAULT 'none',-- none | pending | approved | changes_requested
  is_personal INTEGER NOT NULL DEFAULT 0,    -- private to assignee/creator
  tags TEXT NOT NULL DEFAULT '',             -- comma separated
  blocked_reason TEXT NOT NULL DEFAULT '',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_meeting ON tasks(meeting_id);
CREATE INDEX idx_tasks_reviewer ON tasks(reviewer_id, status);
CREATE INDEX idx_tasks_due ON tasks(due_date);

CREATE TABLE task_collaborators (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,                 -- task | deliverable | report | opportunity | improvement | knowledge ...
  entity_id TEXT NOT NULL,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'comment',      -- comment | review_feedback | note | engagement
  created_at TEXT NOT NULL
);
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id);

-- ---------------------------------------------------------------- documents & links
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,                         -- secure document link (Drive/Docs/SharePoint/https)
  kind TEXT NOT NULL DEFAULT 'link',         -- link | google_doc | google_sheet | google_drive_folder | pdf | other
  description TEXT NOT NULL DEFAULT '',
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments_entity ON attachments(entity_type, entity_id);

-- ---------------------------------------------------------------- knowledge
CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',             -- markdown-ish body / description / procedure steps
  category TEXT NOT NULL DEFAULT 'Other',
  item_type TEXT NOT NULL DEFAULT 'resource',-- resource | procedure | lesson | insight | decision_record | report
  keywords TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT '',
  document_url TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  programme_id TEXT REFERENCES programmes(id) ON DELETE SET NULL,
  access_level TEXT NOT NULL DEFAULT 'all_staff', -- all_staff | project | management | restricted
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | in_review | published | archived
  version INTEGER NOT NULL DEFAULT 1,
  published_date TEXT,
  last_reviewed_date TEXT,
  review_date TEXT,
  -- lesson-learned structure (item_type = lesson)
  what_happened TEXT NOT NULL DEFAULT '',
  what_worked TEXT NOT NULL DEFAULT '',
  what_did_not_work TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '',
  do_differently TEXT NOT NULL DEFAULT '',
  future_benefit TEXT NOT NULL DEFAULT '',
  view_count INTEGER NOT NULL DEFAULT 0,
  source_type TEXT,                          -- meeting | report | learning ... when derived from another record
  source_id TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_knowledge_category ON knowledge_items(category);
CREATE INDEX idx_knowledge_project ON knowledge_items(project_id);

CREATE TABLE knowledge_access (               -- explicit grants for access_level = restricted
  knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (knowledge_id, user_id)
);

CREATE TABLE knowledge_versions (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  changed_at TEXT NOT NULL
);

-- Generic relationship edges ("related to") between any two records.
CREATE TABLE entity_links (
  id TEXT PRIMARY KEY,
  a_type TEXT NOT NULL,
  a_id TEXT NOT NULL,
  b_type TEXT NOT NULL,
  b_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'related',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (a_type, a_id, b_type, b_id, relation)
);
CREATE INDEX idx_entity_links_a ON entity_links(a_type, a_id);
CREATE INDEX idx_entity_links_b ON entity_links(b_type, b_id);

-- ---------------------------------------------------------------- reports (call reports, Fakawe, project reports)
CREATE TABLE report_templates (
  id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,                 -- call_report | fakawe | project_report
  name TEXT NOT NULL,
  sections TEXT NOT NULL,                    -- JSON array of {key,title,enabled}
  header_text TEXT NOT NULL DEFAULT 'Change Science Institute',
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reporting_periods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'weekly',  -- weekly | biweekly | monthly | custom
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  submission_deadline TEXT,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approver_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  recipients TEXT NOT NULL DEFAULT '[]',     -- JSON array of user ids
  template_id TEXT REFERENCES report_templates(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- open | drafting | in_review | approved | archived
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,                 -- call_report | fakawe | project_report
  title TEXT NOT NULL,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  period_id TEXT REFERENCES reporting_periods(id) ON DELETE SET NULL,
  template_id TEXT REFERENCES report_templates(id) ON DELETE SET NULL,
  content TEXT NOT NULL,                     -- JSON: { sections: [{key,title,body,items?,sources?}] }
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | in_review | changes_requested | approved | final | published | archived
  audience TEXT NOT NULL DEFAULT 'participants', -- participants | project | management | all_staff
  version INTEGER NOT NULL DEFAULT 1,
  generated_by TEXT NOT NULL DEFAULT 'system', -- system | rules | anthropic:<model>
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  source_records TEXT NOT NULL DEFAULT '[]', -- JSON array of {type,id,label}
  quality_flags TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings (missing info, conflicts)
  external_doc_url TEXT NOT NULL DEFAULT '',
  minutes_saved_estimate INTEGER,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reports_type ON reports(report_type, status);
CREATE INDEX idx_reports_meeting ON reports(meeting_id);

CREATE TABLE report_versions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  change_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- opportunities
CREATE TABLE opportunities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  opportunity_type TEXT NOT NULL DEFAULT 'Business development',
  description TEXT NOT NULL DEFAULT '',
  organisation TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  date_identified TEXT NOT NULL,
  strategic_relevance TEXT NOT NULL DEFAULT 'medium', -- low | medium | high
  potential_value TEXT NOT NULL DEFAULT '',
  estimated_value REAL,
  probability INTEGER,                       -- 0..100
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  next_action TEXT NOT NULL DEFAULT '',
  follow_up_date TEXT,
  stage TEXT NOT NULL DEFAULT 'identified',  -- identified | exploring | developing | engagement | proposal | negotiation | secured | lost | on_hold
  notes TEXT NOT NULL DEFAULT '',
  confidential INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_opportunities_stage ON opportunities(stage);

-- ---------------------------------------------------------------- learning & improvement
CREATE TABLE learning_themes (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL UNIQUE,                -- YYYY-MM
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reading_material TEXT NOT NULL DEFAULT '',
  discussion_prompts TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  participation TEXT NOT NULL DEFAULT 'optional', -- optional | encouraged
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE learning_records (
  id TEXT PRIMARY KEY,
  contributor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  record_type TEXT NOT NULL DEFAULT 'lesson',-- lesson | insight | experiment | process_change | behaviour_change | approach_change | unexpected_outcome | theme_contribution
  title TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  theme_id TEXT REFERENCES learning_themes(id) ON DELETE SET NULL,
  what_learned TEXT NOT NULL DEFAULT '',
  what_changed TEXT NOT NULL DEFAULT '',     -- optional: nobody is forced to claim a change
  what_tried TEXT NOT NULL DEFAULT '',
  what_worked TEXT NOT NULL DEFAULT '',
  what_did_not_work TEXT NOT NULL DEFAULT '',
  do_differently TEXT NOT NULL DEFAULT '',
  suggested_improvement TEXT NOT NULL DEFAULT '',
  others_could_learn TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  document_url TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'shared', -- shared | private
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE improvements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  suggested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  problem TEXT NOT NULL DEFAULT '',
  proposed_solution TEXT NOT NULL DEFAULT '',
  potential_benefit TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'submitted',  -- submitted | under_review | accepted | in_progress | implemented | rejected | deferred
  review_date TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL DEFAULT '',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- notifications, activity, audit, automation
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  entity_type TEXT,
  entity_id TEXT,
  link TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT,                           -- prevents duplicate automation notifications
  read_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);
CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Activity feed: human-readable events on records, filtered by record visibility when shown.
CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  verb TEXT NOT NULL,                        -- task.created, task.completed, meeting.approved ...
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_label TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_project ON activity(project_id, created_at);
CREATE INDEX idx_activity_entity ON activity(entity_type, entity_id);
CREATE INDEX idx_activity_created ON activity(created_at);

-- Security audit log (append-only from the application's perspective).
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,                      -- auth.login, user.create, permission.change, task.assign, export.csv ...
  entity_type TEXT,
  entity_id TEXT,
  changes TEXT NOT NULL DEFAULT '{}',        -- JSON diff/context
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_audit_action ON audit_log(action);

CREATE TABLE automation_rules (
  key TEXT PRIMARY KEY,                      -- built-in rule key
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  last_result TEXT NOT NULL DEFAULT ''
);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  rule_key TEXT NOT NULL REFERENCES automation_rules(key) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL DEFAULT '',          -- ok | error
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE ai_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  feature TEXT NOT NULL,
  reference_id TEXT,
  rating TEXT NOT NULL,                      -- helpful | not_helpful
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  feature TEXT NOT NULL,
  engine TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE task_ref_seq (id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL);
INSERT INTO task_ref_seq (id, next) VALUES (1, 1001);
