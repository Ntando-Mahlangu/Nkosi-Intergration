export interface Progress { value: number | null; method: string; explanation: string; done: number; total: number }
export interface HealthFactor { level: "info" | "attention" | "risk" | "blocked"; text: string }

export interface ProjectSummary {
  id: string;
  code: string | null;
  name: string;
  description: string;
  purpose: string;
  objectives: string;
  intended_outcomes: string;
  scope: string;
  stakeholders: string;
  reporting_requirements: string;
  category: string;
  programme_id: string | null;
  programme_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  team_id: string | null;
  team_name: string | null;
  status: string;
  health: string;
  health_note: string;
  priority: string;
  start_date: string | null;
  target_date: string | null;
  completed_date: string | null;
  budget_amount?: number | null;
  budget_currency?: string;
  budget_notes?: string;
  budget_visible: boolean;
  progress_method: string;
  manual_progress: number | null;
  visibility: string;
  drive_folder_url: string;
  updated_at: string;
  progress: Progress;
  next_milestone: { id: string; title: string; target_date: string | null; status: string } | null;
  outstanding_deliverables: number;
  overdue_deliverables: number;
  open_actions: number;
  overdue_actions: number;
  overdue_milestones: number;
  open_risks: number;
  risk_level: string | null;
  my_role: string | null;
  can_manage: boolean;
}

export interface Member { user_id: string; role: string; name: string; email: string; job_title: string; added_at: string }
export interface Milestone {
  id: string; project_id: string; title: string; description: string; owner_id: string | null; owner_name?: string | null; target_date: string | null; status: string;
  completed_date: string | null; weight: number; notes: string; evidence_url: string; overdue?: boolean; deliverable_count?: number; deliverables_done?: number;
}
export interface ProjectDetail extends ProjectSummary {
  members: Member[];
  milestones: Milestone[];
  counts: { milestones: number; deliverables: number; risks: number; decisions: number; tasks: number; updates: number };
  health_suggestion: { suggested: string; factors: HealthFactor[] };
  last_update: ProjectUpdate | null;
  related: {
    opportunities: { id: string; name: string; stage: string; organisation: string; follow_up_date: string | null }[];
    knowledge: { id: string; title: string; item_type: string; category: string; summary: string; status: string }[];
    learning: { id: string; title: string; record_type: string; what_learned: string; created_at: string; contributor_name: string | null }[];
    other: { link_id: string; type: string; id: string; label: string; relation: string }[];
  };
  permissions: { can_manage: boolean; can_contribute: boolean; can_view_budget: boolean; my_role: string | null };
}
export interface ProjectUpdate {
  id: string; project_id: string; author_id: string | null; author_name: string | null; summary: string; achievements: string; next_steps: string; blockers: string;
  health: string | null; progress: number | null; period_start: string | null; period_end: string | null; created_at: string;
}
export interface Deliverable {
  id: string; project_id: string; milestone_id: string | null; milestone_title: string | null; name: string; description: string; owner_id: string | null; owner_name: string | null;
  reviewer_id: string | null; reviewer_name: string | null; due_date: string | null; status: string; acceptance_criteria: string; submission_url: string; submission_note: string;
  review_note: string; version: number; weight: number; overdue: boolean; task_count: number; tasks_done: number;
}
export interface DeliverableVersion { id: string; version: number; submission_url: string; note: string; submitted_by_name: string | null; submitted_at: string }
export interface Risk {
  id: string; project_id: string; type: string; title: string; description: string; severity: string; likelihood: string | null; impact: string; owner_id: string | null;
  owner_name: string | null; identified_date: string; mitigation: string; action_plan: string; status: string; review_date: string | null; created_by: string | null; created_by_name: string | null;
}
export interface Decision {
  id: string; title: string; description: string; context: string; consequences: string; project_id: string | null; project_name: string | null; meeting_id: string | null;
  meeting_title: string | null; decision_maker_id: string | null; decision_maker_name: string | null; decision_date: string | null; status: string; requires_management: number;
  created_by: string | null; created_by_name: string | null; created_at: string; can_edit?: boolean;
}
export interface DepItem { type: string; id: string; label: string; status: string; due: string | null; done: boolean; project_id: string | null }
export interface DepEdge { id: string; from: DepItem; to: DepItem; note: string; blocking: boolean; delayed: boolean; created_by: string | null }
export interface HistoryRow { id: string; field: string; from_value: string | null; to_value: string; note: string; changed_by_name: string | null; changed_at: string }

export const STATUS_OPTIONS = [
  ["proposed", "Proposed"], ["planning", "Planning"], ["active", "Active"], ["on_hold", "On hold"], ["at_risk", "At risk"], ["completed", "Completed"], ["cancelled", "Cancelled"],
].map(([value, label]) => ({ value, label }));
export const HEALTH_OPTIONS = [["on_track", "On track"], ["needs_attention", "Needs attention"], ["at_risk", "At risk"], ["blocked", "Blocked"], ["completed", "Completed"]].map(([value, label]) => ({ value, label }));
export const PRIORITY_OPTIONS = [["low", "Low"], ["normal", "Normal"], ["high", "High"], ["urgent", "Urgent"]].map(([value, label]) => ({ value, label }));

export const PROGRESS_METHODS: { value: string; label: string; explain: string }[] = [
  { value: "milestones", label: "Milestone completion", explain: "Achieved milestones ÷ all milestones (cancelled excluded)." },
  { value: "deliverables", label: "Deliverable completion", explain: "Approved or completed deliverables ÷ all deliverables." },
  { value: "tasks", label: "Task completion", explain: "Completed tasks ÷ all tasks. Every task counts equally, so use only when tasks are similar in size." },
  { value: "weighted", label: "Weighted milestones & deliverables", explain: "Uses the weight you give each milestone and deliverable." },
  { value: "manual", label: "Owner-reported", explain: "The project owner reports a percentage in project updates." },
];
export const VISIBILITY_OPTIONS: { value: string; label: string; explain: string }[] = [
  { value: "organisation", label: "Organisation", explain: "All CSI staff can view. Only members can contribute." },
  { value: "team", label: "Team", explain: "Members, the assigned team and management can view." },
  { value: "restricted", label: "Restricted", explain: "Only project members can view — no role (including management or administrators) bypasses this." },
];
export const ROLE_LABEL: Record<string, string> = { owner: "Owner", manager: "Manager", member: "Member", viewer: "Viewer" };
