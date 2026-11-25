export interface KnowledgeListItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  item_type: string;
  tags: string;
  keywords: string;
  status: string;
  access_level: string;
  version: number;
  published_date: string | null;
  updated_at: string;
  created_at: string;
  view_count: number;
  review_date: string | null;
  last_reviewed_date: string | null;
  project_id: string | null;
  author_id: string | null;
  owner_id: string | null;
  author_name: string | null;
  project_name: string | null;
}

export interface KnowledgeItem extends KnowledgeListItem {
  body: string;
  source: string;
  document_url: string;
  programme_id: string | null;
  programme_name: string | null;
  owner_name: string | null;
  what_happened: string;
  what_worked: string;
  what_did_not_work: string;
  why: string;
  do_differently: string;
  future_benefit: string;
  source_type: string | null;
  source_id: string | null;
}

export interface KnowledgeDetailResponse {
  item: KnowledgeItem;
  permissions: { can_edit: boolean; can_manage: boolean; can_submit: boolean; can_publish: boolean; can_return: boolean; can_archive: boolean; can_mark_reviewed: boolean };
  versions: { id: string; version: number; title: string; changed_at: string; changed_by_name: string | null }[];
  related: { link_id: string; type: string; id: string; label: string; relation: string }[];
  similar: { id: string; title: string; category: string; item_type: string; summary: string }[];
  grants: { id: string; name: string; job_title: string }[];
  source: { type: string; id: string } | null;
}

export interface Discover {
  recent: KnowledgeListItem[];
  popular: KnowledgeListItem[];
  my_projects: KnowledgeListItem[];
  procedures: KnowledgeListItem[];
  lessons: KnowledgeListItem[];
  review_due: KnowledgeListItem[];
  awaiting_review: KnowledgeListItem[];
  my_drafts: KnowledgeListItem[];
  categories: { category: string; n: number }[];
  today: string;
}

export const ITEM_TYPES: { value: string; label: string; hint: string }[] = [
  { value: "resource", label: "Resource", hint: "Research, report, presentation, framework, template or other reference material." },
  { value: "procedure", label: "Procedure", hint: "A step-by-step operational process with an owner and a review date." },
  { value: "lesson", label: "Lesson learned", hint: "What happened, what worked, what did not, and what to do differently." },
  { value: "insight", label: "Insight", hint: "A short observation worth keeping, e.g. from a meeting or programme." },
];
export const ITEM_TYPE_LABEL: Record<string, string> = { resource: "Resource", procedure: "Procedure", lesson: "Lesson learned", insight: "Insight", decision_record: "Decision record", report: "Report" };
export const ITEM_TYPE_ICON: Record<string, string> = { resource: "book", procedure: "tasks", lesson: "lightbulb", insight: "sparkles", decision_record: "flag", report: "report" };

export const ACCESS_LEVELS: { value: string; label: string; hint: string }[] = [
  { value: "all_staff", label: "All staff", hint: "Everyone at CSI can find and read it once published." },
  { value: "project", label: "Project members", hint: "Only people who can see the linked project." },
  { value: "management", label: "Management only", hint: "Only people with management access." },
  { value: "restricted", label: "Named people only", hint: "Only the author, owner and people you explicitly grant access to." },
];
export const ACCESS_LABEL: Record<string, string> = Object.fromEntries(ACCESS_LEVELS.map((a) => [a.value, a.label]));
