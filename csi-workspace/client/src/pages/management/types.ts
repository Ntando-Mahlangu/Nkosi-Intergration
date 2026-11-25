export interface AttentionItem { type: string; id: string; title: string; project: string | null; link: string; severity: "critical" | "high" | "medium"; why: string }
export interface Overview {
  today: string;
  projects: { active: number; at_risk: number; blocked: number; status: { status: string; n: number }[]; health: { health: string; n: number }[] };
  milestones: { upcoming_14d: number; overdue: number };
  deliverables: { outstanding: number; overdue: number };
  actions: { open: number; overdue: number; awaiting_review: number; note: string };
  decisions: { requiring_attention: number };
  reporting_deadlines: { id: string; name: string; submission_deadline: string; status: string; owner_name: string | null; report_status: string | null }[];
  pipeline: { stage: string; n: number; value: number | null; weighted: number | null }[];
}
export const TYPE_LABEL: Record<string, string> = { project: "Project", milestone: "Milestone", deliverable: "Deliverable", risk: "Risk / blocker", decision: "Decision", task: "Action", opportunity: "Opportunity" };
export const TYPE_ICON: Record<string, string> = { project: "folder", milestone: "milestone", deliverable: "package", risk: "alert", decision: "flag", task: "tasks", opportunity: "target" };
