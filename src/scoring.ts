import type { Lead, Priority, ScoredLead } from "./types.js";

/** Thresholds (in days) used to translate "recent" / "several weeks" / "very old" from the spec into concrete rules. */
export const SCORING_WINDOWS = {
  recentDays: 7,
  severalWeeksDays: 45,
  veryOldDays: 180,
} as const;

const PRIORITY_RANK: Record<Priority, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function daysSince(isoDate: string, now: Date): number {
  const then = new Date(isoDate).getTime();
  return (now.getTime() - then) / (1000 * 60 * 60 * 24);
}

function hasMeaningfulHistory(lead: Lead): boolean {
  return Boolean(
    lead.requestedService ||
      lead.previousQuote ||
      lead.previousConversationSummary ||
      lead.notes ||
      lead.hadMissedCall ||
      (lead.appointmentStatus && lead.appointmentStatus !== "none")
  );
}

/**
 * Scores a single lead per SYSTEM_PROMPT.md STEP 2. Collects every matching
 * reason and reports the highest priority tier reached, so downstream
 * consumers (and humans reviewing the plan) can see why a lead ranked
 * where it did.
 */
export function scoreLead(lead: Lead, now: Date = new Date()): ScoredLead {
  const reasons: string[] = [];
  let priority: Priority = "LOW";

  const bump = (candidate: Priority, reason: string) => {
    reasons.push(reason);
    if (PRIORITY_RANK[candidate] > PRIORITY_RANK[priority]) {
      priority = candidate;
    }
  };

  const ageDays = daysSince(lead.createdAt, now);
  const lastContactDays = lead.lastContactedAt ? daysSince(lead.lastContactedAt, now) : undefined;

  // --- HIGH PRIORITY ---
  if (lead.hadMissedCall && (lastContactDays ?? ageDays) <= SCORING_WINDOWS.recentDays) {
    bump("HIGH", "Recent missed call");
  }
  if (lead.previousQuote && ageDays <= SCORING_WINDOWS.recentDays) {
    bump("HIGH", "Recent quote request");
  }
  if (lead.source === "website_form" && lead.status === "new" && ageDays <= SCORING_WINDOWS.recentDays) {
    bump("HIGH", "Recent form submission");
  }
  if (lead.appointmentStatus === "requested") {
    bump("HIGH", "Lead explicitly requested an appointment/contact");
  }
  if (lead.appointmentStatus === "abandoned" && ageDays <= SCORING_WINDOWS.recentDays) {
    bump("HIGH", "Recent abandoned booking request — strong buying intent");
  }

  // --- MEDIUM PRIORITY ---
  if (lead.status === "contacted_no_response") {
    bump("MEDIUM", "Contacted previously but never responded");
  }
  if (
    lead.requestedService &&
    ageDays > SCORING_WINDOWS.recentDays &&
    ageDays <= SCORING_WINDOWS.severalWeeksDays
  ) {
    bump("MEDIUM", "Requested information several weeks ago");
  }
  if (lead.previousQuote && ageDays > SCORING_WINDOWS.recentDays) {
    bump("MEDIUM", "Previously requested a quote — moderate interest");
  }

  // --- LOW PRIORITY ---
  if (ageDays > SCORING_WINDOWS.veryOldDays) {
    bump("LOW", "Very old lead");
  }
  if (!hasMeaningfulHistory(lead)) {
    bump("LOW", "No meaningful interaction history");
  }

  if (reasons.length === 0) {
    bump("LOW", "Weak or unclear buying intent");
  }

  return { lead, priority, priorityReasons: reasons };
}

export function scoreLeads(leads: Lead[], now: Date = new Date()): ScoredLead[] {
  return leads.map((lead) => scoreLead(lead, now));
}

/** Sorts scored leads HIGH -> MEDIUM -> LOW, most recent first within a tier. */
export function sortByPriority(scored: ScoredLead[]): ScoredLead[] {
  return [...scored].sort((a, b) => {
    const rankDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.lead.createdAt).getTime() - new Date(a.lead.createdAt).getTime();
  });
}
