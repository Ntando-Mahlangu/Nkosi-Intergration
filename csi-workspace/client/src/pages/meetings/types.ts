export interface MeetingListItem {
  id: string;
  title: string;
  meeting_type: string;
  project_id: string | null;
  project_name: string | null;
  meeting_date: string;
  start_time: string | null;
  end_time: string | null;
  status: string;
  review_status: string;
  confidential: number;
  meeting_link: string;
  location: string;
  preparation_required: number;
  organiser_name: string | null;
  participant_count: number;
  open_actions: number;
  pending_suggestions: number;
  can_manage?: boolean;
}

export interface Participant {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string | null;
  external_name: string;
  external_org: string;
  attendance: string;
}

export interface Meeting {
  id: string;
  title: string;
  meeting_type: string;
  purpose: string;
  project_id: string | null;
  project_name: string | null;
  programme_id: string | null;
  programme_name: string | null;
  meeting_date: string;
  start_time: string | null;
  end_time: string | null;
  timezone: string;
  location: string;
  meeting_link: string;
  organiser_id: string | null;
  organiser_name: string | null;
  notes: string;
  transcript: string;
  transcript_source: string;
  key_points: string;
  summary: string;
  summary_source: string;
  follow_up_date: string | null;
  preparation_required: number;
  preparation_notes: string;
  status: string;
  review_status: string;
  confidential: number;
  approved_by_name: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Suggestion {
  id: string;
  kind: string;
  status: string;
  engine: string;
  payload: Record<string, unknown> & {
    title?: string;
    detail?: string;
    text?: string;
    insight?: string;
    owner_name?: string;
    owner_id?: string | null;
    due_date?: string;
    due_date_basis?: string;
    evidence?: string;
    confidence?: "high" | "medium" | "low";
    key_topics?: string[];
    kind?: string;
  };
  resulting_type: string | null;
  resulting_id: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
}

export interface MeetingDetailResponse {
  meeting: Meeting;
  participants: Participant[];
  tasks: { id: string; ref: number; title: string; status: string; due_date: string | null; assignee_name: string | null }[];
  decisions: { id: string; title: string; description: string; status: string; decision_date: string | null; decision_maker_name: string | null }[];
  risks: { id: string; title: string; type: string; severity: string; status: string }[];
  reports: { id: string; title: string; status: string; version: number; report_type: string; created_at: string }[];
  suggestions: { pending: number; total: number; engines: string[]; summary: Suggestion | null };
  history: {
    id: string;
    title: string;
    meeting_date: string;
    status: string;
    summary: string;
    decisions: { id: string; title: string; status: string }[];
    outstanding_actions: { id: string; ref: number; title: string; status: string; due_date: string | null; assignee_name: string | null }[];
  }[];
  completed_since_last: { id: string; ref: number; title: string; completed_at: string; assignee_name: string | null }[];
  permissions: { can_manage: boolean; can_submit_notes: boolean; can_process: boolean; can_approve: boolean; can_generate_report: boolean };
}

export const participantName = (p: Participant) => p.name ?? `${p.external_name}${p.external_org ? ` (${p.external_org})` : ""}`;
export const timeRange = (m: { start_time: string | null; end_time: string | null }) => (m.start_time ? `${m.start_time}${m.end_time ? `–${m.end_time}` : ""}` : "");
