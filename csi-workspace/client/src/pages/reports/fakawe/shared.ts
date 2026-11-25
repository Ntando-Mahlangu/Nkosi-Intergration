export interface ReportRow {
  id: string;
  title: string;
  report_type: string;
  status: string;
  project_id?: string | null;
  project_name?: string | null;
  meeting_id?: string | null;
  meeting_title?: string | null;
  meeting_date?: string | null;
  author_name?: string | null;
  audience?: string;
  updated_at: string;
  created_at: string;
  approved_at?: string | null;
}

/** Builder B's /api/reports may return an array or {items}. Accept both. */
export function asRows<T>(d: unknown): T[] {
  if (Array.isArray(d)) return d as T[];
  if (d && typeof d === "object" && Array.isArray((d as { items?: unknown }).items)) return (d as { items: T[] }).items;
  return [];
}

export interface PeriodRow {
  id: string;
  name: string;
  frequency: string;
  start_date: string;
  end_date: string;
  submission_deadline: string | null;
  owner_id: string | null;
  owner_name: string | null;
  approver_id: string | null;
  approver_name: string | null;
  recipients: string[];
  template_id: string | null;
  status: string;
  report_id: string | null;
  report_status: string | null;
}

export const SOURCE_LABELS: Record<string, string> = {
  project_updates: "Project updates",
  meetings: "Approved meetings",
  call_reports: "Approved call reports",
  completed_tasks: "Completed actions",
  milestones_achieved: "Milestones achieved",
  deliverables_approved: "Deliverables approved",
  decisions_made: "Decisions recorded",
  decisions_required: "Decisions pending",
  open_high_risks: "Open high risks/blockers",
  upcoming: "Upcoming (14 days)",
  outstanding_actions: "Outstanding actions",
  opportunities: "Opportunity movements",
  lessons: "Lessons & learning",
};
