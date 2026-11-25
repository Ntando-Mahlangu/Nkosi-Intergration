/**
 * Single source of truth for status/priority labels, tones and icons across modules.
 * Tones map to .tone-* CSS classes; icons always accompany colour (accessibility).
 */
export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "ai";
export interface StatusMeta { label: string; tone: Tone; icon: string }

const m = (label: string, tone: Tone, icon: string): StatusMeta => ({ label, tone, icon });

export const STATUS: Record<string, Record<string, StatusMeta>> = {
  task: {
    suggested: m("Suggested", "ai", "sparkles"),
    todo: m("To do", "neutral", "circle"),
    in_progress: m("In progress", "accent", "clock"),
    blocked: m("Blocked", "danger", "ban"),
    awaiting_review: m("Awaiting review", "warn", "eye"),
    completed: m("Completed", "ok", "checkCircle"),
    cancelled: m("Cancelled", "neutral", "x"),
  },
  review: {
    none: m("No review", "neutral", "dot"),
    pending: m("Review pending", "warn", "eye"),
    approved: m("Approved", "ok", "checkCircle"),
    changes_requested: m("Changes requested", "danger", "edit"),
  },
  priority: {
    low: m("Low", "neutral", "dot"),
    normal: m("Normal", "neutral", "dot"),
    high: m("High", "warn", "flag"),
    urgent: m("Urgent", "danger", "alert"),
  },
  project: {
    proposed: m("Proposed", "neutral", "lightbulb"),
    planning: m("Planning", "accent", "edit"),
    active: m("Active", "ok", "activity"),
    on_hold: m("On hold", "neutral", "pause"),
    at_risk: m("At risk", "warn", "alert"),
    completed: m("Completed", "ok", "checkCircle"),
    cancelled: m("Cancelled", "neutral", "x"),
  },
  health: {
    on_track: m("On track", "ok", "checkCircle"),
    needs_attention: m("Needs attention", "warn", "alertCircle"),
    at_risk: m("At risk", "danger", "alert"),
    blocked: m("Blocked", "danger", "ban"),
    completed: m("Completed", "ok", "check"),
  },
  milestone: {
    not_started: m("Not started", "neutral", "circle"),
    in_progress: m("In progress", "accent", "clock"),
    achieved: m("Achieved", "ok", "checkCircle"),
    missed: m("Missed", "danger", "alert"),
    cancelled: m("Cancelled", "neutral", "x"),
  },
  deliverable: {
    not_started: m("Not started", "neutral", "circle"),
    in_progress: m("In progress", "accent", "clock"),
    submitted: m("Submitted", "warn", "send"),
    under_review: m("Under review", "warn", "eye"),
    changes_requested: m("Changes requested", "danger", "edit"),
    approved: m("Approved", "ok", "checkCircle"),
    completed: m("Completed", "ok", "check"),
    cancelled: m("Cancelled", "neutral", "x"),
  },
  risk: {
    open: m("Open", "danger", "alertCircle"),
    mitigating: m("Mitigating", "warn", "shield"),
    monitoring: m("Monitoring", "accent", "eye"),
    resolved: m("Resolved", "ok", "checkCircle"),
    closed: m("Closed", "neutral", "x"),
  },
  severity: {
    low: m("Low", "neutral", "dot"),
    medium: m("Medium", "warn", "alertCircle"),
    high: m("High", "danger", "alert"),
    critical: m("Critical", "danger", "alert"),
  },
  decision: {
    proposed: m("Proposed", "neutral", "lightbulb"),
    pending_approval: m("Pending approval", "warn", "clock"),
    made: m("Made", "ok", "check"),
    approved: m("Approved", "ok", "checkCircle"),
    rejected: m("Rejected", "danger", "x"),
    superseded: m("Superseded", "neutral", "refresh"),
    revisited: m("Revisited", "accent", "refresh"),
  },
  meeting: {
    scheduled: m("Scheduled", "accent", "calendar"),
    notes_submitted: m("Notes submitted", "warn", "file"),
    in_review: m("In review", "warn", "eye"),
    approved: m("Approved", "ok", "checkCircle"),
    cancelled: m("Cancelled", "neutral", "x"),
  },
  report: {
    draft: m("Draft", "neutral", "edit"),
    in_review: m("In review", "warn", "eye"),
    changes_requested: m("Changes requested", "danger", "edit"),
    approved: m("Approved", "ok", "checkCircle"),
    final: m("Final", "ok", "check"),
    published: m("Published", "ok", "send"),
    archived: m("Archived", "neutral", "archive"),
  },
  knowledge: {
    draft: m("Draft", "neutral", "edit"),
    in_review: m("In review", "warn", "eye"),
    published: m("Published", "ok", "checkCircle"),
    archived: m("Archived", "neutral", "archive"),
  },
  opportunity: {
    identified: m("Identified", "neutral", "lightbulb"),
    exploring: m("Exploring", "accent", "search"),
    developing: m("Developing", "accent", "edit"),
    engagement: m("Engagement", "accent", "users"),
    proposal: m("Proposal", "warn", "file"),
    negotiation: m("Negotiation", "warn", "message"),
    secured: m("Secured", "ok", "checkCircle"),
    lost: m("Lost", "danger", "x"),
    on_hold: m("On hold", "neutral", "pause"),
  },
  improvement: {
    submitted: m("Submitted", "neutral", "send"),
    under_review: m("Under review", "warn", "eye"),
    accepted: m("Accepted", "accent", "check"),
    in_progress: m("In progress", "accent", "clock"),
    implemented: m("Implemented", "ok", "checkCircle"),
    rejected: m("Rejected", "danger", "x"),
    deferred: m("Deferred", "neutral", "pause"),
  },
  period: {
    open: m("Open", "accent", "clock"),
    drafting: m("Drafting", "warn", "edit"),
    in_review: m("In review", "warn", "eye"),
    approved: m("Approved", "ok", "checkCircle"),
    archived: m("Archived", "neutral", "archive"),
  },
  suggestion: {
    pending: m("Pending review", "ai", "sparkles"),
    accepted: m("Accepted", "ok", "check"),
    edited_accepted: m("Accepted (edited)", "ok", "check"),
    rejected: m("Rejected", "neutral", "x"),
  },
};

export function statusMeta(kind: string, value?: string | null): StatusMeta {
  if (!value) return m("—", "neutral", "dot");
  return STATUS[kind]?.[value] ?? m(value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), "neutral", "dot");
}

export function options(kind: string): { value: string; label: string }[] {
  return Object.entries(STATUS[kind] ?? {}).map(([value, meta]) => ({ value, label: meta.label }));
}
