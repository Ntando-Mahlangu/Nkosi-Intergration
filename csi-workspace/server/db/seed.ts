/**
 * Demonstration data. EVERYTHING here is fictional and flagged is_demo = 1.
 * People, organisations, numbers and outcomes are illustrative only and do not describe
 * real CSI staff, partners or achievements. Project names (Unmasking, Change OS, D4C …) are
 * used only as illustrative demo projects, as the product brief allows.
 *
 * Dates are relative to "today" so the demo always shows due-today, overdue and upcoming work.
 */
import crypto from "node:crypto";
import type { Db } from "./index.js";
import { hashPassword } from "../lib/auth.js";
import { addDays, newId, nowIso, todayIn } from "../lib/ids.js";
import { ruleBasedMeeting } from "../ai/service.js";

const DOMAIN = "demo.csi.example"; // reserved .example TLD — can never be a real mailbox

export function ensureBootstrapAdmin(db: Db, email?: string, password?: string) {
  if (!email || !password) return;
  if (db.get("SELECT 1 FROM users LIMIT 1")) return;
  const now = nowIso();
  db.insert("users", {
    id: newId("usr"), name: "Administrator", email, role_key: "admin", password_hash: hashPassword(password),
    must_change_password: 1, created_at: now, updated_at: now,
  });
  console.log(`[bootstrap] Created initial administrator ${email} (must change password at first sign-in).`);
}

export function seedDemo(db: Db, demoPassword = ""): string {
  const password = demoPassword || `Demo-${crypto.randomBytes(4).toString("hex")}-2026`;
  const pwHash = hashPassword(password);
  const today = todayIn("Africa/Johannesburg");
  const d = (n: number) => addDays(today, n);
  const ts = (n: number, hour = 9) => new Date(Date.parse(d(n) + "T00:00:00Z") + (hour - 2) * 3600000).toISOString();
  const now = nowIso();
  const demo = { is_demo: 1 };

  db.tx(() => {
    // ------------------------------------------------------------ teams & users
    const teams = {
      leadership: newId("team"), programmes: newId("team"), research: newId("team"), operations: newId("team"),
    };
    db.insert("teams", { id: teams.leadership, name: "Leadership", description: "Directors and management (demo)", created_at: now });
    db.insert("teams", { id: teams.programmes, name: "Programmes", description: "Programme design and delivery (demo)", created_at: now });
    db.insert("teams", { id: teams.research, name: "Research & Knowledge", description: "Research, publications and knowledge management (demo)", created_at: now });
    db.insert("teams", { id: teams.operations, name: "Operations", description: "Finance, suppliers, events and systems (demo)", created_at: now });

    const mk = (name: string, local: string, role: string, team: string, title: string) => {
      const id = newId("usr");
      db.insert("users", { id, name, email: `${local}@${DOMAIN}`, role_key: role, team_id: team, job_title: title, password_hash: pwHash, ...demo, created_at: now, updated_at: now });
      return id;
    };
    const U = {
      naledi: mk("Naledi Mokoena", "naledi", "management", teams.leadership, "Executive Director (demo)"),
      sipho: mk("Sipho Dlamini", "sipho", "project_manager", teams.programmes, "Programme Lead (demo)"),
      ayesha: mk("Ayesha Patel", "ayesha", "project_manager", teams.programmes, "Corporate Programmes Manager (demo)"),
      thabo: mk("Thabo Nkosi", "thabo", "employee", teams.research, "Research Associate (demo)"),
      lerato: mk("Lerato Khumalo", "lerato", "employee", teams.programmes, "Programme Coordinator (demo)"),
      pieter: mk("Pieter van Wyk", "pieter", "employee", teams.operations, "Operations Officer (demo)"),
      zanele: mk("Zanele Mthembu", "zanele", "knowledge_manager", teams.research, "Knowledge & Reporting Coordinator (demo)"),
      grace: mk("Grace Okafor", "grace", "admin", teams.operations, "Systems Administrator (demo)"),
    };
    db.run("UPDATE teams SET lead_id = ? WHERE id = ?", U.naledi, teams.leadership);
    db.run("UPDATE teams SET lead_id = ? WHERE id = ?", U.sipho, teams.programmes);
    db.run("UPDATE teams SET lead_id = ? WHERE id = ?", U.zanele, teams.research);
    db.run("UPDATE teams SET lead_id = ? WHERE id = ?", U.pieter, teams.operations);

    // ------------------------------------------------------------ programmes
    const prog = { personal: newId("prg"), org: newId("prg"), research: newId("prg") };
    db.insert("programmes", { id: prog.personal, name: "Personal Change", description: "Illustrative programme grouping personal-change initiatives.", owner_id: U.sipho, ...demo, created_at: now, updated_at: now });
    db.insert("programmes", { id: prog.org, name: "Organisational Change", description: "Illustrative programme grouping corporate and organisational work.", owner_id: U.ayesha, ...demo, created_at: now, updated_at: now });
    db.insert("programmes", { id: prog.research, name: "Research & Knowledge", description: "Illustrative programme grouping research activities.", owner_id: U.zanele, ...demo, created_at: now, updated_at: now });

    // ------------------------------------------------------------ projects
    const P: Record<string, string> = {};
    const proj = (key: string, o: Record<string, unknown>, members: [string, string][]) => {
      const id = newId("prj");
      P[key] = id;
      db.insert("projects", { id, ...o, ...demo, created_by: o.owner_id, created_at: ts(-60), updated_at: now });
      db.insert("project_members", { project_id: id, user_id: o.owner_id as string, role: "owner", added_at: now });
      for (const [uid, role] of members) db.insert("project_members", { project_id: id, user_id: uid, role, added_at: now });
    };
    proj("unmasking", {
      code: "UNM", name: "Unmasking", programme_id: prog.personal, owner_id: U.sipho, team_id: teams.programmes, category: "Programme delivery",
      description: "Illustrative demo project: a facilitated programme helping participants examine the assumptions behind how they show up at work.",
      purpose: "Pilot a structured reflective programme with a small cohort.",
      objectives: "Design a 6-session facilitation guide\nRun a pilot cohort\nCapture participant feedback for redesign",
      intended_outcomes: "A tested programme design and an evidence-informed redesign recommendation.",
      status: "active", health: "on_track", priority: "high", start_date: d(-50), target_date: d(70), progress_method: "milestones", visibility: "organisation",
      budget_amount: 180000, stakeholders: "Pilot participants; facilitators; partner HR leads (all fictional)",
    }, [[U.lerato, "member"], [U.thabo, "member"], [U.zanele, "viewer"]]);
    proj("changeos", {
      code: "COS", name: "Change OS", programme_id: prog.org, owner_id: U.sipho, team_id: teams.programmes, category: "Product development",
      description: "Illustrative demo project: an internal toolkit of change practices packaged for repeat use.",
      purpose: "Consolidate CSI change practices into a reusable operating toolkit.",
      objectives: "Inventory existing practices\nDraft toolkit v0.1\nTest with two internal teams",
      status: "at_risk", health: "needs_attention", health_note: "Toolkit drafting is behind the target date because the practice inventory was incomplete.",
      priority: "normal", start_date: d(-80), target_date: d(30), progress_method: "deliverables", visibility: "organisation",
    }, [[U.thabo, "member"], [U.pieter, "member"]]);
    proj("d4c", {
      code: "D4C", name: "D4C", programme_id: prog.org, owner_id: U.ayesha, team_id: teams.programmes, category: "Partnership",
      description: "Illustrative demo project: a collaborative design initiative with fictional partner organisations.",
      purpose: "Co-design a change initiative with partners.",
      objectives: "Agree partnership scope\nRun co-design workshops\nPublish a joint summary",
      status: "active", health: "blocked", health_note: "Awaiting partner sign-off on data-sharing terms.", priority: "high",
      start_date: d(-40), target_date: d(90), progress_method: "tasks", visibility: "team",
    }, [[U.lerato, "member"], [U.naledi, "viewer"]]);
    proj("corporate", {
      code: "CPD", name: "Corporate Programme Development", programme_id: prog.org, owner_id: U.ayesha, team_id: teams.programmes, category: "Corporate learning",
      description: "Illustrative demo project: developing a modular corporate learning offer.",
      objectives: "Define modules\nPrice the offer\nPrepare pitch materials",
      status: "planning", health: "on_track", priority: "normal", start_date: d(-10), target_date: d(120), progress_method: "manual", manual_progress: 15, visibility: "organisation",
    }, [[U.pieter, "member"], [U.thabo, "viewer"]]);
    proj("research", {
      code: "RKI", name: "Research & Knowledge Initiative", programme_id: prog.research, owner_id: U.zanele, team_id: teams.research, category: "Research",
      description: "Illustrative demo project: organising CSI research outputs into a searchable knowledge base.",
      objectives: "Catalogue research outputs\nWrite research summaries\nLaunch Knowledge Hub",
      status: "active", health: "on_track", priority: "normal", start_date: d(-90), target_date: d(45), progress_method: "milestones", visibility: "organisation",
    }, [[U.thabo, "manager"], [U.lerato, "member"]]);
    proj("retreat", {
      code: "LDR", name: "Leadership Retreat Planning", owner_id: U.naledi, team_id: teams.leadership, category: "Operations",
      description: "Illustrative RESTRICTED demo project — visible only to its members, to demonstrate access control.",
      status: "planning", health: "on_track", priority: "low", start_date: d(-5), target_date: d(60), progress_method: "tasks", visibility: "restricted",
    }, [[U.pieter, "member"]]);

    // ------------------------------------------------------------ milestones & deliverables
    const M: Record<string, string> = {};
    const ms = (key: string, project: string, title: string, owner: string, target: string, status: string, extra: Record<string, unknown> = {}) => {
      const id = newId("mil");
      M[key] = id;
      db.insert("milestones", { id, project_id: P[project], title, owner_id: owner, target_date: target, status, completed_date: status === "achieved" ? target : null, ...extra, ...demo, created_at: now, updated_at: now });
    };
    ms("unm1", "unmasking", "Facilitation guide drafted", U.sipho, d(-20), "achieved", { sort_order: 1 });
    ms("unm2", "unmasking", "Pilot cohort recruited", U.lerato, d(5), "in_progress", { sort_order: 2 });
    ms("unm3", "unmasking", "Pilot sessions complete", U.sipho, d(50), "not_started", { sort_order: 3 });
    ms("cos1", "changeos", "Practice inventory complete", U.thabo, d(-12), "in_progress", { sort_order: 1, notes: "Two practice areas still undocumented." });
    ms("cos2", "changeos", "Toolkit v0.1 ready for testing", U.sipho, d(20), "not_started", { sort_order: 2 });
    ms("d4c1", "d4c", "Partnership scope agreed", U.ayesha, d(-3), "in_progress", { sort_order: 1 });
    ms("d4c2", "d4c", "Co-design workshop 1", U.lerato, d(25), "not_started", { sort_order: 2 });
    ms("rki1", "research", "Research catalogue complete", U.thabo, d(-30), "achieved", { sort_order: 1 });
    ms("rki2", "research", "Knowledge Hub pilot launch", U.zanele, d(6), "in_progress", { sort_order: 2 });
    ms("cpd1", "corporate", "Module outline agreed", U.ayesha, d(14), "not_started", { sort_order: 1 });

    const D: Record<string, string> = {};
    const dl = (key: string, project: string, name: string, owner: string, reviewer: string | null, due: string, status: string, extra: Record<string, unknown> = {}) => {
      const id = newId("dlv");
      D[key] = id;
      db.insert("deliverables", { id, project_id: P[project], name, owner_id: owner, reviewer_id: reviewer, due_date: due, status, ...extra, ...demo, created_at: now, updated_at: now });
    };
    dl("guide", "unmasking", "Facilitation guide v1", U.sipho, U.naledi, d(-22), "approved", { milestone_id: M.unm1, acceptance_criteria: "Covers all six sessions; reviewed by a second facilitator." });
    dl("invite", "unmasking", "Participant invitation pack", U.lerato, U.sipho, d(2), "in_progress", { milestone_id: M.unm2 });
    dl("inventory", "changeos", "Practice inventory spreadsheet", U.thabo, U.sipho, d(-12), "changes_requested", { milestone_id: M.cos1, review_note: "Please add the two missing practice areas before approval." });
    dl("toolkit", "changeos", "Toolkit v0.1 document", U.sipho, U.naledi, d(20), "not_started", { milestone_id: M.cos2 });
    dl("dsa", "d4c", "Data-sharing agreement draft", U.ayesha, U.naledi, d(-5), "under_review", { milestone_id: M.d4c1, submission_url: "https://docs.google.com/document/d/demo-d4c-dsa" });
    dl("summaries", "research", "Research summaries (batch 1)", U.thabo, U.zanele, d(3), "submitted", { milestone_id: M.rki2 });
    dl("hubguide", "research", "Knowledge Hub user guide", U.zanele, U.naledi, d(10), "in_progress", { milestone_id: M.rki2 });

    // ------------------------------------------------------------ risks
    const risk = (project: string, type: string, title: string, severity: string, owner: string, extra: Record<string, unknown> = {}) =>
      db.insert("risks", { id: newId("rsk"), project_id: P[project], type, title, severity, owner_id: owner, identified_date: d(-7), status: "open", ...extra, ...demo, created_by: owner, created_at: ts(-7), updated_at: now });
    risk("d4c", "blocker", "Partner data-sharing sign-off outstanding", "high", U.ayesha, { description: "Workshops cannot be scheduled until the data-sharing terms are signed (fictional scenario).", mitigation: "Escalate to partner leadership; prepare a reduced-data option.", review_date: d(2) });
    risk("changeos", "risk", "Inventory gaps delay toolkit", "medium", U.sipho, { likelihood: "high", impact: "Toolkit v0.1 date may slip by 2–3 weeks.", mitigation: "Time-box the inventory; document gaps as known limitations.", status: "mitigating", review_date: d(4) });
    risk("unmasking", "risk", "Low pilot sign-ups", "medium", U.lerato, { likelihood: "medium", impact: "Cohort too small for meaningful feedback.", mitigation: "Extend invitation window; ask partner HR leads to nominate.", review_date: d(7) });
    risk("research", "issue", "Some older reports lack source files", "low", U.thabo, { mitigation: "Record what is known and flag missing files in the catalogue.", status: "monitoring" });

    // ------------------------------------------------------------ meetings
    const MT: Record<string, string> = {};
    const meeting = (key: string, o: Record<string, unknown>, participants: string[], externals: [string, string][] = []) => {
      const id = newId("mtg");
      MT[key] = id;
      db.insert("meetings", { id, timezone: "Africa/Johannesburg", ...o, ...demo, created_by: o.organiser_id, created_at: ts(-1), updated_at: now });
      for (const p of participants) db.insert("meeting_participants", { id: newId("mpt"), meeting_id: id, user_id: p, attendance: (o.meeting_date as string) < today ? "attended" : "invited" });
      for (const [n, org] of externals) db.insert("meeting_participants", { id: newId("mpt"), meeting_id: id, user_id: null, external_name: n, external_org: org, attendance: "attended" });
    };
    meeting("unmPlanning", {
      title: "Unmasking pilot planning", meeting_type: "Project meeting", project_id: P.unmasking, meeting_date: d(-14), start_time: "10:00", end_time: "11:00",
      organiser_id: U.sipho, purpose: "Agree pilot timeline and recruitment approach.", meeting_link: "https://meet.google.com/demo-unm-plan",
      notes: "Discussion:\n- Pilot timeline and cohort size\n- Recruitment channels\n\nDecisions:\n- Pilot cohort capped at 12 participants\n\nActions:\n- Lerato to draft the participant invitation pack by " + d(-7) + "\n- Sipho to confirm facilitator availability",
      summary: "The team agreed the pilot timeline and capped the cohort at 12. Recruitment will run through partner HR contacts.", summary_source: "human",
      status: "approved", review_status: "approved", approved_by: U.sipho, approved_at: ts(-13),
    }, [U.sipho, U.lerato, U.thabo]);
    meeting("d4cPartner", {
      title: "D4C partner check-in", meeting_type: "Partner meeting", project_id: P.d4c, meeting_date: d(-2), start_time: "14:00", end_time: "15:00",
      organiser_id: U.ayesha, purpose: "Progress on partnership scope and data-sharing terms.",
      notes: [
        "Key points:",
        "- Partner legal team still reviewing the data-sharing agreement",
        "- Workshop venue options discussed (fictional)",
        "",
        "Decision: Workshop 1 will be held online if no venue is confirmed by " + d(10),
        "Risk: Further delay to sign-off would push workshop 1 into the holiday period",
        "Action: Ayesha to send revised data-sharing clause to partner by Friday",
        "Lerato will shortlist two online facilitation platforms",
        "- Someone should look at translation needs?",
        "Insight: Partners respond faster to one-page summaries than full drafts",
      ].join("\n"),
      status: "notes_submitted", review_status: "pending",
    }, [U.ayesha, U.lerato], [["Jordan Smith (fictional)", "Partner Org A (fictional)"]]);
    meeting("cosStandup", {
      title: "Change OS weekly", meeting_type: "Project meeting", project_id: P.changeos, meeting_date: d(-7), start_time: "09:00", end_time: "09:30",
      organiser_id: U.sipho, notes: "Inventory review. Two practice areas undocumented.\nDecision: Time-box the inventory to two more weeks.\nAction: Thabo to document the facilitation and feedback practice areas",
      summary: "Inventory is incomplete; team time-boxed the remaining work to two weeks.", summary_source: "human",
      status: "approved", review_status: "approved", approved_by: U.sipho, approved_at: ts(-7),
    }, [U.sipho, U.thabo, U.pieter]);
    meeting("rkiSync", {
      title: "Knowledge Hub launch sync", meeting_type: "Project meeting", project_id: P.research, meeting_date: d(1), start_time: "11:00", end_time: "11:45",
      organiser_id: U.zanele, meeting_link: "https://meet.google.com/demo-rki-sync", preparation_required: 1, preparation_notes: "Review the draft user guide before the meeting.",
      status: "scheduled",
    }, [U.zanele, U.thabo, U.lerato]);
    meeting("cpdKickoff", {
      title: "Corporate offer kick-off", meeting_type: "Internal planning", project_id: P.corporate, meeting_date: d(3), start_time: "13:00", end_time: "14:00",
      organiser_id: U.ayesha, purpose: "Agree module outline approach.", status: "scheduled",
    }, [U.ayesha, U.pieter, U.naledi]);
    meeting("mgmt", {
      title: "Management meeting", meeting_type: "Management", meeting_date: d(0), start_time: "15:00", end_time: "16:00",
      organiser_id: U.naledi, confidential: 1, purpose: "Monthly management meeting (confidential demo record).", status: "scheduled",
    }, [U.naledi, U.ayesha, U.sipho]);

    // Pre-compute rule-based suggestions for the D4C partner meeting so the review screen has content.
    const d4cParticipants = [{ id: U.ayesha, name: "Ayesha Patel" }, { id: U.lerato, name: "Lerato Khumalo" }];
    const an = ruleBasedMeeting({ title: "D4C partner check-in", date: d(-2), projectName: "D4C", participants: d4cParticipants, notes: String(db.get<{ notes: string }>("SELECT notes FROM meetings WHERE id = ?", MT.d4cPartner)!.notes) });
    const sug = (kind: string, payload: Record<string, unknown>) =>
      db.insert("ai_suggestions", { id: newId("sug"), source_type: "meeting", source_id: MT.d4cPartner, kind, payload: JSON.stringify(payload), status: "pending", engine: "rules", created_at: now });
    sug("summary", { text: an.summary, key_topics: an.key_topics });
    for (const a of an.actions) sug("action", { ...a, owner_id: d4cParticipants.find((p) => p.name === a.owner_name)?.id ?? null, project_id: P.d4c });
    for (const x of an.decisions) sug("decision", x);
    for (const r of an.risks) sug(r.kind === "blocker" ? "blocker" : "risk", r);
    for (const q of an.follow_up_questions) sug("follow_up_question", { text: q });
    for (const k of an.knowledge_items) sug("knowledge", k);
    if (an.project_update) sug("project_update", { text: an.project_update, project_id: P.d4c });

    // ------------------------------------------------------------ decisions
    const dec = (title: string, o: Record<string, unknown>) =>
      db.insert("decisions", { id: newId("dec"), title, decision_date: o.decision_date ?? d(-7), ...o, ...demo, created_at: now, updated_at: now });
    dec("Pilot cohort capped at 12 participants", { project_id: P.unmasking, meeting_id: MT.unmPlanning, decision_maker_id: U.sipho, decision_date: d(-14), status: "made", context: "Facilitator capacity for the pilot.", created_by: U.sipho });
    dec("Time-box practice inventory to two weeks", { project_id: P.changeos, meeting_id: MT.cosStandup, decision_maker_id: U.sipho, status: "made", created_by: U.sipho });
    dec("Approve reduced-data option for D4C if sign-off slips", { project_id: P.d4c, decision_maker_id: U.naledi, status: "pending_approval", requires_management: 1, decision_date: null, context: "Needed to unblock workshop scheduling (fictional).", created_by: U.ayesha });
    dec("Adopt CSI Workspace as the pilot system for task tracking", { decision_maker_id: U.naledi, status: "proposed", requires_management: 1, decision_date: null, context: "Illustrative management decision for the demo.", created_by: U.grace });

    // ------------------------------------------------------------ project updates
    const upd = (project: string, author: string, daysAgo: number, summary: string, extra: Record<string, unknown> = {}) =>
      db.insert("project_updates", { id: newId("pup"), project_id: P[project], author_id: author, summary, period_start: d(-daysAgo - 6), period_end: d(-daysAgo), ...extra, ...demo, created_at: ts(-daysAgo, 16) });
    upd("unmasking", U.sipho, 2, "Facilitation guide approved. Recruitment underway with partner HR contacts.", { achievements: "Guide v1 approved.", next_steps: "Finalise invitation pack.", health: "on_track" });
    upd("research", U.zanele, 4, "Research catalogue complete; batch 1 summaries submitted for review.", { next_steps: "Pilot launch of the Knowledge Hub.", health: "on_track" });
    upd("changeos", U.sipho, 16, "Inventory still incomplete.", { blockers: "Two practice areas undocumented.", health: "needs_attention" });

    // ------------------------------------------------------------ tasks
    let ref = 1001;
    const T: Record<string, string> = {};
    const task = (key: string, o: Record<string, unknown>) => {
      const id = newId("tsk");
      T[key] = id;
      const status = (o.status as string) ?? "todo";
      db.insert("tasks", {
        id, ref: ref++, priority: "normal", source: o.project_id ? "project" : "personal", status,
        completed_at: status === "completed" ? ts(-1, 15) : null, ...o, ...demo, created_at: o.created_at ?? ts(-10), updated_at: now,
      });
    };
    // Lerato (employee) — rich personal workspace
    task("l1", { title: "Finalise participant invitation pack", assignee_id: U.lerato, creator_id: U.sipho, project_id: P.unmasking, deliverable_id: D.invite, meeting_id: MT.unmPlanning, source: "meeting", priority: "high", due_date: d(0), status: "in_progress", review_required: 1, reviewer_id: U.sipho, description: "Agreed in the Unmasking pilot planning meeting." });
    task("l2", { title: "Send pilot reminder emails to nominated participants", assignee_id: U.lerato, creator_id: U.sipho, project_id: P.unmasking, due_date: d(0), status: "todo" });
    task("l3", { title: "Book online workshop platform trial", assignee_id: U.lerato, creator_id: U.ayesha, project_id: P.d4c, due_date: d(-3), status: "todo", priority: "high" });
    task("l4", { title: "Draft Knowledge Hub FAQ section", assignee_id: U.lerato, creator_id: U.zanele, project_id: P.research, due_date: d(4), status: "awaiting_review", review_required: 1, reviewer_id: U.zanele, review_status: "pending" });
    task("l5", { title: "Collect partner HR nominations", assignee_id: U.lerato, creator_id: U.sipho, project_id: P.unmasking, due_date: d(6), status: "todo" });
    task("l6", { title: "Prepare notes template for D4C workshops", assignee_id: U.lerato, creator_id: U.lerato, project_id: P.d4c, due_date: d(12), status: "todo", priority: "low" });
    task("l7", { title: "Update my CV for the programme bios page", assignee_id: U.lerato, creator_id: U.lerato, is_personal: 1, source: "personal", due_date: d(9), status: "todo", priority: "low" });
    task("l8", { title: "Confirm pilot venue accessibility requirements", assignee_id: U.lerato, creator_id: U.sipho, project_id: P.unmasking, due_date: d(-8), status: "completed", completed_at: ts(-8, 15) });
    // Thabo
    task("t1", { title: "Document facilitation and feedback practice areas", assignee_id: U.thabo, creator_id: U.sipho, project_id: P.changeos, meeting_id: MT.cosStandup, source: "meeting", deliverable_id: D.inventory, due_date: d(-1), status: "in_progress", priority: "high" });
    task("t2", { title: "Write summaries for batch 2 research outputs", assignee_id: U.thabo, creator_id: U.zanele, project_id: P.research, due_date: d(8), status: "todo" });
    task("t3", { title: "Review literature on organisational change readiness", assignee_id: U.thabo, creator_id: U.thabo, project_id: P.research, due_date: d(0), status: "todo", task_type: "Research" });
    task("t4", { title: "Tag research catalogue entries", assignee_id: U.thabo, creator_id: U.zanele, project_id: P.research, due_date: d(-6), status: "completed", completed_at: ts(-6, 12) });
    task("t5", { title: "Blocked: obtain source files for 2019 reports", assignee_id: U.thabo, creator_id: U.thabo, project_id: P.research, due_date: d(5), status: "blocked", blocked_reason: "Waiting for archive access from Operations." });
    // Sipho (PM)
    task("s1", { title: "Confirm facilitator availability for pilot", assignee_id: U.sipho, creator_id: U.sipho, project_id: P.unmasking, meeting_id: MT.unmPlanning, source: "meeting", due_date: d(-4), status: "completed", completed_at: ts(-5, 11) });
    task("s2", { title: "Review Change OS inventory resubmission", assignee_id: U.sipho, creator_id: U.sipho, project_id: P.changeos, due_date: d(1), status: "todo", priority: "high" });
    task("s3", { title: "Prepare Unmasking update for Fakawe", assignee_id: U.sipho, creator_id: U.zanele, project_id: P.unmasking, due_date: d(2), status: "todo", source: "management" });
    // Ayesha (PM)
    task("a1", { title: "Chase partner legal on data-sharing agreement", assignee_id: U.ayesha, creator_id: U.ayesha, project_id: P.d4c, due_date: d(-1), status: "in_progress", priority: "urgent" });
    task("a2", { title: "Draft corporate module outline", assignee_id: U.ayesha, creator_id: U.ayesha, project_id: P.corporate, due_date: d(10), status: "todo" });
    task("a3", { title: "Follow up with Partner Org B on programme interest", assignee_id: U.ayesha, creator_id: U.naledi, source: "opportunity", due_date: d(2), status: "todo" });
    // Pieter
    task("p1", { title: "Grant Research archive access to Thabo", assignee_id: U.pieter, creator_id: U.thabo, due_date: d(1), status: "todo", source: "personal" });
    task("p2", { title: "Get supplier quotes for pilot catering", assignee_id: U.pieter, creator_id: U.sipho, project_id: P.unmasking, due_date: d(-2), status: "todo" });
    task("p3", { title: "Shortlist retreat venues", assignee_id: U.pieter, creator_id: U.naledi, project_id: P.retreat, due_date: d(14), status: "todo" });
    task("p4", { title: "Pricing scenarios for corporate offer", assignee_id: U.pieter, creator_id: U.ayesha, project_id: P.corporate, due_date: d(7), status: "awaiting_review", review_required: 1, reviewer_id: U.ayesha, review_status: "pending" });
    // Zanele, Naledi, Grace
    task("z1", { title: "Review batch 1 research summaries", assignee_id: U.zanele, creator_id: U.zanele, project_id: P.research, deliverable_id: D.summaries, due_date: d(1), status: "todo", priority: "high" });
    task("z2", { title: "Compile this week's Fakawe digest", assignee_id: U.zanele, creator_id: U.zanele, source: "management", due_date: d(2), status: "todo" });
    task("n1", { title: "Decide on D4C reduced-data option", assignee_id: U.naledi, creator_id: U.ayesha, project_id: P.d4c, source: "management", due_date: d(1), status: "todo", priority: "high" });
    task("n2", { title: "Review Q-plan priorities (personal note)", assignee_id: U.naledi, creator_id: U.naledi, is_personal: 1, due_date: d(3), status: "todo" });
    task("g1", { title: "Configure Google Workspace sign-in for the pilot", assignee_id: U.grace, creator_id: U.grace, due_date: d(7), status: "todo", source: "personal", description: "Needs OAuth client created by the Workspace super-admin." });
    // Suggested task awaiting acceptance by Lerato (from AI/meeting review)
    task("sug1", { title: "Shortlist two online facilitation platforms", assignee_id: U.lerato, creator_id: U.ayesha, project_id: P.d4c, meeting_id: MT.d4cPartner, source: "meeting", status: "suggested", source_ref: "Lerato will shortlist two online facilitation platforms", due_date: null });
    // dependency: t1 depends on p1? (archive access blocks t5)
    db.insert("dependencies", { id: newId("dep"), from_type: "task", from_id: T.t5, to_type: "task", to_id: T.p1, note: "Archive access needed", created_by: U.thabo, created_at: now });
    db.insert("dependencies", { id: newId("dep"), from_type: "milestone", from_id: M.cos2, to_type: "milestone", to_id: M.cos1, note: "Toolkit needs the completed inventory", created_by: U.sipho, created_at: now });
    db.insert("dependencies", { id: newId("dep"), from_type: "milestone", from_id: M.d4c2, to_type: "deliverable", to_id: D.dsa, note: "Workshops need signed data-sharing terms", created_by: U.ayesha, created_at: now });
    db.insert("task_collaborators", { task_id: T.l1, user_id: U.thabo });
    db.insert("comments", { id: newId("cmt"), entity_type: "task", entity_id: T.l1, author_id: U.sipho, body: "Please include the accessibility note from the venue check.", created_at: ts(-1, 10) });

    // ------------------------------------------------------------ reports
    const reportContent = {
      sections: [
        { key: "overview", title: "Meeting overview", body: "Unmasking pilot planning meeting held to agree the pilot timeline and recruitment approach (demo record)." },
        { key: "participants", title: "Participants", body: "Sipho Dlamini, Lerato Khumalo, Thabo Nkosi" },
        { key: "discussion", title: "Key discussion points", items: ["Pilot timeline and cohort size", "Recruitment channels"] },
        { key: "decisions", title: "Decisions", items: ["Pilot cohort capped at 12 participants"] },
        { key: "actions", title: "Action items", items: ["Lerato Khumalo — Draft the participant invitation pack", "Sipho Dlamini — Confirm facilitator availability"] },
        { key: "next_steps", title: "Next steps", body: "Begin recruitment once the invitation pack is approved." },
      ],
    };
    const rep = newId("rep");
    db.insert("reports", {
      id: rep, report_type: "call_report", title: "Call report — Unmasking pilot planning", meeting_id: MT.unmPlanning, project_id: P.unmasking,
      content: JSON.stringify(reportContent), status: "approved", audience: "project", generated_by: "system", author_id: U.sipho, reviewer_id: U.naledi,
      approved_by: U.naledi, approved_at: ts(-12), source_records: JSON.stringify([{ type: "meeting", id: MT.unmPlanning, label: "Unmasking pilot planning" }]),
      ...demo, created_at: ts(-13), updated_at: ts(-12),
    });
    db.insert("report_versions", { id: newId("rpv"), report_id: rep, version: 1, content: JSON.stringify(reportContent), status: "approved", changed_by: U.naledi, change_note: "Approved", created_at: ts(-12) });

    const fakaweTpl = db.get<{ id: string }>("SELECT id FROM report_templates WHERE report_type = 'fakawe' AND is_default = 1")?.id ?? null;
    const dow = new Date(today + "T00:00:00Z").getUTCDay();
    const weekStart = addDays(today, -((dow + 6) % 7));
    db.insert("reporting_periods", { id: newId("per"), name: `Fakawe — week of ${weekStart}`, frequency: "weekly", start_date: weekStart, end_date: addDays(weekStart, 6), submission_deadline: addDays(weekStart, 4), owner_id: U.zanele, approver_id: U.naledi, recipients: JSON.stringify([U.naledi, U.sipho, U.ayesha]), template_id: fakaweTpl, status: "open", ...demo, created_at: now });
    const prevPer = newId("per");
    db.insert("reporting_periods", { id: prevPer, name: `Fakawe — week of ${addDays(weekStart, -7)}`, frequency: "weekly", start_date: addDays(weekStart, -7), end_date: addDays(weekStart, -1), submission_deadline: addDays(weekStart, -3), owner_id: U.zanele, approver_id: U.naledi, recipients: JSON.stringify([U.naledi]), template_id: fakaweTpl, status: "archived", ...demo, created_at: now });
    db.insert("reports", {
      id: newId("rep"), report_type: "fakawe", title: `Fakawe digest — week of ${addDays(weekStart, -7)}`, period_id: prevPer, template_id: fakaweTpl,
      content: JSON.stringify({ sections: [
        { key: "executive_overview", title: "Executive overview", body: "Illustrative demo digest. Research catalogue work completed; Change OS inventory remains behind schedule; D4C awaiting partner sign-off." },
        { key: "completed", title: "Completed activities", items: ["Research catalogue entries tagged (Research & Knowledge Initiative)", "Facilitator availability confirmed (Unmasking)"] },
        { key: "risks", title: "Risks and blockers", items: ["D4C — partner data-sharing sign-off outstanding (blocker, high)"] },
      ] }),
      status: "published", audience: "all_staff", generated_by: "rules", author_id: U.zanele, approved_by: U.naledi, approved_at: ts(-3), ...demo, created_at: ts(-4), updated_at: ts(-3),
    });

    // ------------------------------------------------------------ knowledge
    const K: Record<string, string> = {};
    const ki = (key: string, o: Record<string, unknown>) => {
      const id = newId("kno");
      K[key] = id;
      db.insert("knowledge_items", { id, status: "published", published_date: d(-20), access_level: "all_staff", ...o, ...demo, created_at: ts(-30), updated_at: now });
    };
    ki("supplier", { title: "How to onboard a supplier", item_type: "procedure", category: "Procedures", author_id: U.pieter, owner_id: U.pieter, summary: "Steps for registering a new supplier (illustrative procedure).", body: "1. Request the supplier's registration documents and banking confirmation letter.\n2. Check the supplier is not already on the supplier list.\n3. Complete the supplier form and attach documents.\n4. Operations verifies banking details by phone using an independently sourced number.\n5. Finance approves and adds the supplier.\n\nOwner: Operations. This is a demo procedure — replace with CSI's actual process.", keywords: "supplier, vendor, onboarding, procurement", tags: "operations,finance", last_reviewed_date: d(-60), review_date: d(-2), version: 2 });
    ki("callreport", { title: "How to prepare a call report", item_type: "procedure", category: "Procedures", author_id: U.zanele, owner_id: U.zanele, summary: "Using CSI Workspace to turn meeting notes into an approved call report.", body: "1. Open the meeting and submit notes.\n2. Run 'Extract actions & decisions' and review every suggestion.\n3. Approve the meeting record.\n4. Generate the call report, edit, then submit it for review.\n5. Once approved, export to PDF or share the link.", keywords: "call report, meeting, minutes", tags: "reporting", last_reviewed_date: d(-10), review_date: d(170) });
    ki("programme", { title: "How to organise a programme", item_type: "procedure", category: "Procedures", author_id: U.sipho, owner_id: U.sipho, summary: "Checklist for setting up a new programme (illustrative).", body: "Define purpose and outcomes; identify owner; set up the project in CSI Workspace; agree milestones; plan logistics with Operations; schedule kick-off.", keywords: "programme, setup, checklist", tags: "programmes", review_date: d(120) });
    ki("readiness", { title: "Change readiness: literature notes", item_type: "resource", category: "Research", author_id: U.thabo, project_id: P.research, summary: "Working notes summarising common themes in change-readiness literature (demo content, not a CSI publication).", body: "Themes noted: perceived need for change, efficacy, leadership support, personal valence. These notes are illustrative demo content.", keywords: "organisational change, readiness, research", tags: "research,change" });
    ki("facilitation", { title: "Unmasking facilitation guide v1", item_type: "resource", category: "Programme resources", author_id: U.sipho, project_id: P.unmasking, access_level: "project", summary: "Session-by-session guide for the pilot (project members only).", document_url: "https://docs.google.com/document/d/demo-unmasking-guide", keywords: "facilitation, unmasking, guide", tags: "programme" });
    ki("lessonCos", { title: "Lesson: time-box discovery work", item_type: "lesson", category: "Project lessons", author_id: U.sipho, project_id: P.changeos, summary: "Open-ended inventories expand; time-boxing kept Change OS moving (illustrative).", what_happened: "The practice inventory took longer than planned.", what_worked: "Time-boxing and documenting gaps explicitly.", what_did_not_work: "Waiting for every practice to be fully documented.", why: "Practice knowledge sat with individuals.", do_differently: "Set a discovery time-box at project start.", future_benefit: "Any project with an inventory or discovery phase.", keywords: "lessons, discovery, scope", tags: "lessons" });
    ki("onepager", { title: "Insight: partners prefer one-page summaries", item_type: "insight", category: "Partnership knowledge", author_id: U.ayesha, project_id: P.d4c, status: "in_review", summary: "Partners responded faster to one-page summaries than full drafts (demo insight from a meeting).", source_type: "meeting", source_id: MT.d4cPartner, keywords: "partners, communication", tags: "partnerships" });
    ki("mgmtNote", { title: "Management: funding scenarios (restricted)", item_type: "resource", category: "Decisions", author_id: U.naledi, access_level: "management", summary: "Management-only planning note (demo) — demonstrates management-level access.", keywords: "funding, scenarios", tags: "management" });
    ki("template", { title: "Meeting notes template", item_type: "resource", category: "Templates", author_id: U.zanele, summary: "Structured notes template with Action:/Decision:/Risk: markers that CSI Workspace recognises.", body: "Meeting:\nDate:\nParticipants:\n\nDiscussion:\n- \n\nDecisions:\n- \n\nActions:\n- <Name> to <action> by <date>\n\nRisks:\n- ", keywords: "template, meeting notes", tags: "templates" });
    ki("draft", { title: "Draft: Corporate offer positioning", item_type: "resource", category: "Presentations", author_id: U.ayesha, project_id: P.corporate, status: "draft", summary: "Early draft (visible to author only until submitted)." });
    db.insert("entity_links", { id: newId("lnk"), a_type: "knowledge", a_id: K.lessonCos, b_type: "project", b_id: P.changeos, relation: "related", created_by: U.sipho, created_at: now });
    db.insert("entity_links", { id: newId("lnk"), a_type: "knowledge", a_id: K.callreport, b_type: "knowledge", b_id: K.template, relation: "related", created_by: U.zanele, created_at: now });

    // ------------------------------------------------------------ opportunities
    const opp = (name: string, o: Record<string, unknown>) =>
      db.insert("opportunities", { id: newId("opp"), name, date_identified: d(-20), created_by: o.owner_id, ...o, ...demo, created_at: ts(-20), updated_at: now });
    opp("Leadership programme for Partner Org B (fictional)", { opportunity_type: "Corporate programme", organisation: "Partner Org B (fictional)", owner_id: U.ayesha, stage: "engagement", strategic_relevance: "high", estimated_value: 250000, probability: 40, next_action: "Send module outline", follow_up_date: d(2), source: "Referral (demo)" });
    opp("Change-readiness research collaboration", { opportunity_type: "Research partnership", organisation: "Example University (fictional)", owner_id: U.zanele, stage: "exploring", strategic_relevance: "high", next_action: "Intro call", follow_up_date: d(-1), source: "Conference contact (demo)" });
    opp("Unmasking for public-sector teams", { opportunity_type: "Programme expansion", organisation: "", owner_id: U.sipho, stage: "identified", strategic_relevance: "medium", next_action: "Wait for pilot results", follow_up_date: d(45) });
    opp("Annual change practitioners event", { opportunity_type: "Event", owner_id: U.pieter, stage: "developing", strategic_relevance: "medium", estimated_value: 60000, probability: 60, next_action: "Venue options", follow_up_date: d(9) });
    opp("Foundation grant: learning in organisations", { opportunity_type: "Funding", organisation: "Example Foundation (fictional)", owner_id: U.naledi, stage: "proposal", strategic_relevance: "high", estimated_value: 900000, probability: 30, next_action: "Submit proposal draft", follow_up_date: d(5), confidential: 1 });
    opp("Toolkit licensing pilot", { opportunity_type: "Product development", owner_id: U.sipho, stage: "on_hold", strategic_relevance: "low", next_action: "Revisit after Change OS v0.1", follow_up_date: d(60) });
    opp("Workshop series for Retailer C (fictional)", { opportunity_type: "Corporate programme", organisation: "Retailer C (fictional)", owner_id: U.ayesha, stage: "lost", strategic_relevance: "medium", notes: "Client chose an internal option (demo)." });

    // ------------------------------------------------------------ learning
    const month = today.slice(0, 7);
    const theme = newId("lth");
    db.insert("learning_themes", { id: theme, month, title: "Learning from small experiments", description: "This month we share small experiments we tried in our work — what we tried, what happened, and what we learned (demo theme).", reading_material: "Pick any short article on experimentation in organisations.", discussion_prompts: "What did you try differently this month?\nWhat surprised you?", created_by: U.naledi, ...demo, created_at: now });
    db.insert("learning_records", { id: newId("lrn"), contributor_id: U.lerato, record_type: "experiment", title: "Shorter invitation emails", topic: "Communication", project_id: P.unmasking, theme_id: theme, what_tried: "Sent a 5-line invitation instead of a full page.", what_learned: "Replies came faster.", outcome: "More early replies (small sample, demo).", visibility: "shared", ...demo, created_at: ts(-3), updated_at: ts(-3) });
    db.insert("learning_records", { id: newId("lrn"), contributor_id: U.thabo, record_type: "insight", title: "Catalogue before summarising", topic: "Research process", project_id: P.research, what_learned: "Having the full catalogue first made summary batching easier.", visibility: "shared", ...demo, created_at: ts(-9), updated_at: ts(-9) });
    db.insert("learning_records", { id: newId("lrn"), contributor_id: U.pieter, record_type: "lesson", title: "Personal reflection (private)", topic: "Time management", what_learned: "Blocking focus time helped.", visibility: "private", ...demo, created_at: ts(-2), updated_at: ts(-2) });
    const imp = (title: string, o: Record<string, unknown>) => db.insert("improvements", { id: newId("imp"), title, ...o, ...demo, created_at: ts(-12), updated_at: now });
    imp("Single meeting notes template", { area: "Meetings", origin: "Change OS weekly", suggested_by: U.thabo, problem: "Notes formats vary, making actions hard to find.", proposed_solution: "Use the shared template with Action:/Decision: markers.", potential_benefit: "Faster call reports.", priority: "normal", owner_id: U.zanele, status: "accepted", review_date: d(14) });
    imp("Supplier list in one place", { area: "Finance & admin", suggested_by: U.pieter, problem: "Supplier details kept in several spreadsheets.", proposed_solution: "Maintain one supplier register linked from the procedure.", priority: "high", owner_id: U.pieter, status: "in_progress" });
    imp("Monthly lunch-and-learn", { area: "People & culture", suggested_by: U.lerato, problem: "Little cross-team sharing.", proposed_solution: "30-minute monthly session tied to the learning theme.", priority: "low", status: "submitted" });

    // ------------------------------------------------------------ notifications & activity
    const note = (user: string, type: string, title: string, entity: [string, string] | null, daysAgo = 0, read = false) =>
      db.insert("notifications", { id: newId("ntf"), user_id: user, type, title, entity_type: entity?.[0] ?? null, entity_id: entity?.[1] ?? null, link: entity ? `/${entity[0] === "task" ? "tasks" : entity[0] + "s"}/${entity[1]}` : "", read_at: read ? ts(-daysAgo, 12) : null, created_at: ts(-daysAgo, 8) });
    note(U.lerato, "task_assigned", "Sipho Dlamini assigned you: Send pilot reminder emails to nominated participants", ["task", T.l2], 1);
    note(U.lerato, "task_suggested", "A meeting action was suggested for you: Shortlist two online facilitation platforms — please confirm", ["task", T.sug1], 0);
    note(U.lerato, "task_overdue", "Overdue: Book online workshop platform trial", ["task", T.l3], 0);
    note(U.lerato, "meeting_upcoming", "Tomorrow: Knowledge Hub launch sync (preparation required)", ["meeting", MT.rkiSync], 0);
    note(U.zanele, "review_requested", "Lerato Khumalo submitted 'Draft Knowledge Hub FAQ section' for review", ["task", T.l4], 1);
    note(U.ayesha, "meeting_actions", "Suggested actions are ready for review: D4C partner check-in", ["meeting", MT.d4cPartner], 1);
    note(U.ayesha, "review_requested", "Pieter van Wyk submitted 'Pricing scenarios for corporate offer' for review", ["task", T.p4], 2);
    note(U.naledi, "decision_required", "Decision awaiting approval: Approve reduced-data option for D4C", null, 1);
    note(U.thabo, "changes_requested", "Changes requested on 'Practice inventory spreadsheet'", ["project", P.changeos], 3, true);

    const act = (actor: string, verb: string, type: string, id: string, label: string, project: string | null, daysAgo: number, detail = "") =>
      db.insert("activity", { id: newId("act"), actor_id: actor, verb, entity_type: type, entity_id: id, entity_label: label, project_id: project, detail, created_at: ts(-daysAgo, 10 + (daysAgo % 5)) });
    act(U.sipho, "meeting.approved", "meeting", MT.unmPlanning, "Unmasking pilot planning", P.unmasking, 13);
    act(U.naledi, "report.approved", "report", rep, "Call report — Unmasking pilot planning", P.unmasking, 12);
    act(U.lerato, "task.completed", "task", T.l8, "Confirm pilot venue accessibility requirements", P.unmasking, 8);
    act(U.thabo, "task.completed", "task", T.t4, "Tag research catalogue entries", P.research, 6);
    act(U.sipho, "task.completed", "task", T.s1, "Confirm facilitator availability for pilot", P.unmasking, 5);
    act(U.zanele, "project.update", "project", P.research, "Research & Knowledge Initiative", P.research, 4, "Research catalogue complete; batch 1 summaries submitted.");
    act(U.thabo, "deliverable.submitted", "deliverable", D.summaries, "Research summaries (batch 1)", P.research, 3);
    act(U.ayesha, "meeting.notes_submitted", "meeting", MT.d4cPartner, "D4C partner check-in", P.d4c, 2);
    act(U.sipho, "project.update", "project", P.unmasking, "Unmasking", P.unmasking, 2, "Facilitation guide approved; recruitment underway.");
    act(U.lerato, "task.submitted_for_review", "task", T.l4, "Draft Knowledge Hub FAQ section", P.research, 1);
    act(U.sipho, "task.assigned", "task", T.l2, "Send pilot reminder emails to nominated participants", P.unmasking, 1);
    act(U.naledi, "task.assigned", "task", T.p3, "Shortlist retreat venues", P.retreat, 1);
    db.run("UPDATE task_ref_seq SET next = (SELECT COALESCE(MAX(ref), 1000) + 1 FROM tasks) WHERE id = 1");
  });
  return password;
}
