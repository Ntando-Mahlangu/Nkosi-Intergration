/**
 * Generic report workflow for call reports, project reports and Fakawe digests (spec §11, §14.5).
 *
 * Content format: { sections: [{ key, title, body?, items?: string[], sources?: {type,id,label}[] }] }
 * Workflow: draft → in_review → (changes_requested → draft…) → approved → final → published → archived.
 * Every content edit creates a new version; every transition is written to status_history + audit log.
 */
import { Router } from "express";
import { z } from "zod";
import type { Request } from "express";
import { h, parse, badRequest, notFound, forbidden, HttpError, zText, zOptId } from "../lib/http.js";
import { currentUser, can, type AuthUser } from "../lib/context.js";
import { newId, nowIso } from "../lib/ids.js";
import { audit, activity, notify, statusChange, getSetting } from "../lib/events.js";
import { reportVisibleSql, canViewReport, canManageMeeting, canManageProject, canViewEntity, canViewMeeting } from "../lib/access.js";
import type { Db } from "../db/index.js";

export const reportsRouter = Router();

interface ReportRow {
  id: string;
  report_type: string;
  title: string;
  meeting_id: string | null;
  project_id: string | null;
  period_id: string | null;
  template_id: string | null;
  content: string;
  status: string;
  audience: string;
  version: number;
  generated_by: string;
  author_id: string | null;
  reviewer_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  review_note: string;
  source_records: string;
  quality_flags: string;
  external_doc_url: string;
  minutes_saved_estimate: number | null;
  created_at: string;
  updated_at: string;
}

interface Section {
  key: string;
  title: string;
  body?: string;
  items?: string[];
  sources?: { type: string; id: string; label: string }[];
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function loadReport(db: Db, u: AuthUser, id: string): ReportRow {
  const r = db.get<ReportRow>("SELECT * FROM reports WHERE id = ?", id);
  if (!r || !canViewReport(db, u, id)) throw notFound("Report not found.");
  return r;
}

/** Can this user edit content / submit the report? */
export function canEditReport(db: Db, u: AuthUser, r: ReportRow): boolean {
  if (r.report_type === "fakawe") return can(u, "fakawe.manage") || can(u, "fakawe.approve");
  if (r.author_id === u.id) return true;
  if (r.meeting_id && canManageMeeting(db, u, r.meeting_id)) return true;
  if (r.project_id && canManageProject(db, u, r.project_id)) return true;
  return false;
}

/** Can this user approve / request changes? Authors cannot approve their own work unless they manage the project. */
export function canReviewReport(db: Db, u: AuthUser, r: ReportRow): boolean {
  if (r.report_type === "fakawe") return can(u, "fakawe.approve");
  if (r.project_id && canManageProject(db, u, r.project_id) && (r.author_id !== u.id || can(u, "report.review"))) return true;
  if (can(u, "report.review") && r.author_id !== u.id) return true;
  if (r.reviewer_id === u.id && r.author_id !== u.id) return true;
  return false;
}

function permissions(db: Db, u: AuthUser, r: ReportRow) {
  const edit = canEditReport(db, u, r);
  const review = canReviewReport(db, u, r);
  const editable = ["draft", "changes_requested"].includes(r.status);
  return {
    can_edit: edit && editable,
    can_submit: edit && editable,
    can_review: review && r.status === "in_review",
    can_return_to_draft: (edit || review) && ["in_review", "changes_requested", "approved"].includes(r.status),
    can_finalise: (review || (edit && r.report_type !== "fakawe")) && r.status === "approved",
    can_publish: review && ["approved", "final"].includes(r.status),
    can_archive: (review || edit) && ["approved", "final", "published"].includes(r.status),
  };
}

function names(db: Db, r: ReportRow) {
  const n = (sql: string, id: string | null) => (id ? (db.get<{ n: string }>(sql, id)?.n ?? null) : null);
  return {
    author_name: n("SELECT name AS n FROM users WHERE id = ?", r.author_id),
    reviewer_name: n("SELECT name AS n FROM users WHERE id = ?", r.reviewer_id),
    approved_by_name: n("SELECT name AS n FROM users WHERE id = ?", r.approved_by),
    meeting_title: n("SELECT title AS n FROM meetings WHERE id = ?", r.meeting_id),
    meeting_date: n("SELECT meeting_date AS n FROM meetings WHERE id = ?", r.meeting_id),
    project_name: n("SELECT name AS n FROM projects WHERE id = ?", r.project_id),
    period_name: n("SELECT name AS n FROM reporting_periods WHERE id = ?", r.period_id),
    template_name: n("SELECT name AS n FROM report_templates WHERE id = ?", r.template_id),
  };
}

/** Remove references to records this viewer cannot see (never leak restricted titles). */
function filterSources(db: Db, u: AuthUser, list: { type: string; id: string; label: string }[] | undefined) {
  if (!list) return undefined;
  return list.map((s) => (canViewEntity(db, u, s.type, s.id) ? { ...s, visible: true } : { type: s.type, id: "", label: "Restricted record", visible: false }));
}

function present(db: Db, u: AuthUser, r: ReportRow) {
  const content = parseJson<{ sections: Section[] }>(r.content, { sections: [] });
  return {
    ...r,
    ...names(db, r),
    meeting_visible: r.meeting_id ? canViewMeeting(db, u, r.meeting_id) : false,
    content: { sections: (content.sections ?? []).map((s) => ({ ...s, sources: filterSources(db, u, s.sources) })) },
    source_records: filterSources(db, u, parseJson(r.source_records, [] as { type: string; id: string; label: string }[])),
    quality_flags: parseJson<string[]>(r.quality_flags, []),
    versions: db.get<{ n: number }>("SELECT COUNT(*) n FROM report_versions WHERE report_id = ?", r.id)!.n,
    history: db.all(
      "SELECT sh.from_value, sh.to_value, sh.note, sh.changed_at, u.name AS changed_by_name FROM status_history sh LEFT JOIN users u ON u.id = sh.changed_by WHERE sh.entity_type = 'report' AND sh.entity_id = ? ORDER BY sh.changed_at DESC",
      r.id,
    ),
    permissions: permissions(db, u, r),
  };
}

// ---------------------------------------------------------------- list
reportsRouter.get(
  "/",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const f = reportVisibleSql(u, "r");
    const where = [f.sql];
    const params: (string | number)[] = [...(f.params as (string | number)[])];
    const eq = (col: string, key: string) => {
      if (req.query[key]) {
        where.push(`r.${col} = ?`);
        params.push(String(req.query[key]));
      }
    };
    eq("report_type", "type");
    eq("status", "status");
    eq("project_id", "project_id");
    eq("meeting_id", "meeting_id");
    eq("period_id", "period_id");
    if (req.query.q) {
      where.push("(r.title LIKE ? OR r.content LIKE ?)");
      const q = `%${String(req.query.q).slice(0, 100)}%`;
      params.push(q, q);
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? 100), 10) || 100, 1), 300);
    const rows = db.all(
      `SELECT r.id, r.report_type, r.title, r.status, r.version, r.audience, r.generated_by, r.meeting_id, r.project_id, r.period_id,
         r.created_at, r.updated_at, r.approved_at, a.name AS author_name, p.name AS project_name, m.title AS meeting_title, m.meeting_date, rp.name AS period_name
       FROM reports r LEFT JOIN users a ON a.id = r.author_id LEFT JOIN projects p ON p.id = r.project_id
       LEFT JOIN meetings m ON m.id = r.meeting_id LEFT JOIN reporting_periods rp ON rp.id = r.period_id
       WHERE ${where.join(" AND ")} ORDER BY r.updated_at DESC LIMIT ?`,
      ...params,
      limit,
    );
    res.json({ items: rows, total: rows.length });
  }),
);

reportsRouter.get(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    res.json(present(db, u, loadReport(db, u, req.params.id)));
  }),
);

// ---------------------------------------------------------------- edit
const sectionSchema = z.object({
  key: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1, "Section title is required.").max(200),
  body: zText(50000).optional(),
  items: z.array(z.string().trim().max(2000)).max(500).optional(),
  sources: z.array(z.object({ type: z.string().max(40), id: z.string().max(80), label: z.string().max(300) })).max(500).optional(),
});

reportsRouter.patch(
  "/:id",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadReport(db, u, req.params.id);
    if (!canEditReport(db, u, r)) throw forbidden("You can't edit this report.");
    if (!["draft", "changes_requested"].includes(r.status)) throw badRequest("Only draft reports (or reports with changes requested) can be edited. Return it to draft first.");
    const b = parse(
      z.object({
        title: z.string().trim().min(1, "A title is required.").max(300).optional(),
        sections: z.array(sectionSchema).max(60).optional(),
        audience: z.enum(["participants", "project", "management", "all_staff"]).optional(),
        reviewer_id: zOptId,
        change_note: zText(500).optional().default(""),
      }),
      req.body,
    );
    const raw = req.body as Record<string, unknown>;
    if (raw.reviewer_id !== undefined && b.reviewer_id && !db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", b.reviewer_id)) throw badRequest("Unknown reviewer.", { fields: { reviewer_id: "Unknown person." } });
    const oldContent = parseJson<{ sections: Section[] }>(r.content, { sections: [] });
    let newContent = r.content;
    if (b.sections) {
      // Preserve server-recorded sources for sections the client returned without them (sources are not user-editable).
      const prevByKey = new Map(oldContent.sections.map((s) => [s.key, s]));
      const sections = b.sections.map((s) => ({ ...s, sources: prevByKey.get(s.key)?.sources }));
      newContent = JSON.stringify({ sections });
    }
    const contentChanged = newContent !== r.content || (b.title !== undefined && b.title !== r.title);
    const now = nowIso();
    db.tx(() => {
      const version = contentChanged ? r.version + 1 : r.version;
      db.update("reports", r.id, {
        title: b.title,
        content: newContent,
        audience: b.audience,
        reviewer_id: raw.reviewer_id !== undefined ? b.reviewer_id : undefined,
        version,
        updated_at: now,
      });
      if (contentChanged) {
        db.insert("report_versions", { id: newId("rpv"), report_id: r.id, version, content: newContent, status: r.status, changed_by: u.id, change_note: b.change_note || "Edited", created_at: now });
      }
    });
    audit(db, req, "report.edit", { type: "report", id: r.id }, { fields: Object.keys(raw) });
    res.json(present(db, u, db.get<ReportRow>("SELECT * FROM reports WHERE id = ?", r.id)!));
  }),
);

// ---------------------------------------------------------------- workflow
const ACTIONS = ["submit", "approve", "request_changes", "return_to_draft", "finalise", "publish", "archive"] as const;

function reviewerCandidates(db: Db, r: ReportRow): string[] {
  if (r.reviewer_id) return [r.reviewer_id];
  if (r.report_type === "fakawe" && r.period_id) {
    const a = db.get<{ approver_id: string | null }>("SELECT approver_id FROM reporting_periods WHERE id = ?", r.period_id)?.approver_id;
    if (a) return [a];
  }
  if (r.project_id) {
    const o = db.get<{ owner_id: string | null }>("SELECT owner_id FROM projects WHERE id = ?", r.project_id)?.owner_id;
    if (o && o !== r.author_id) return [o];
  }
  if (r.meeting_id) {
    const o = db.get<{ organiser_id: string | null }>("SELECT organiser_id FROM meetings WHERE id = ?", r.meeting_id)?.organiser_id;
    if (o && o !== r.author_id) return [o];
  }
  return [];
}

reportsRouter.post(
  "/:id/transition",
  h((req: Request, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadReport(db, u, req.params.id);
    const b = parse(z.object({ action: z.enum(ACTIONS), note: zText(2000).optional().default(""), reviewer_id: zOptId, audience: z.enum(["participants", "project", "management", "all_staff"]).optional() }), req.body);
    const perms = permissions(db, u, r);
    const now = nowIso();
    let to = r.status;
    const patch: Record<string, unknown> = { updated_at: now };
    const deny = (msg: string) => {
      throw new HttpError(403, msg);
    };
    switch (b.action) {
      case "submit":
        if (!perms.can_submit) deny(["draft", "changes_requested"].includes(r.status) ? "You can't submit this report." : "Only draft reports can be submitted for review.");
        if (b.reviewer_id) {
          if (!db.get("SELECT 1 FROM users WHERE id = ? AND active = 1", b.reviewer_id)) throw badRequest("Unknown reviewer.");
          patch.reviewer_id = b.reviewer_id;
        }
        to = "in_review";
        break;
      case "approve":
        if (!perms.can_review) deny(r.status !== "in_review" ? "Only reports in review can be approved." : "You can't approve this report.");
        to = "approved";
        patch.approved_by = u.id;
        patch.approved_at = now;
        patch.review_note = b.note;
        break;
      case "request_changes":
        if (!perms.can_review) deny(r.status !== "in_review" ? "Only reports in review can be sent back." : "You can't review this report.");
        if (!b.note.trim()) throw badRequest("Explain what needs to change.", { fields: { note: "Feedback is required." } });
        to = "changes_requested";
        patch.review_note = b.note;
        break;
      case "return_to_draft":
        if (!perms.can_return_to_draft) deny("You can't return this report to draft.");
        to = "draft";
        patch.approved_by = null;
        patch.approved_at = null;
        break;
      case "finalise":
        if (!perms.can_finalise) deny(r.status !== "approved" ? "Only approved reports can be finalised." : "You can't finalise this report.");
        to = "final";
        break;
      case "publish":
        if (!perms.can_publish) deny(!["approved", "final"].includes(r.status) ? "Approve the report before publishing it." : "You can't publish this report.");
        to = "published";
        if (b.audience) patch.audience = b.audience;
        else if (r.report_type === "fakawe" && r.audience === "participants") patch.audience = getSetting(db, "fakawe.default_audience", "management");
        break;
      case "archive":
        if (!perms.can_archive) deny("You can't archive this report.");
        to = "archived";
        break;
    }
    patch.status = to;
    db.tx(() => {
      db.update("reports", r.id, patch);
      statusChange(db, u.id, "report", r.id, "status", r.status, to, b.note);
      if (b.action === "approve" || b.action === "publish") {
        const updated = db.get<ReportRow>("SELECT * FROM reports WHERE id = ?", r.id)!;
        db.insert("report_versions", { id: newId("rpv"), report_id: r.id, version: updated.version, content: updated.content, status: to, changed_by: u.id, change_note: b.action === "approve" ? "Approved" : "Published", created_at: now });
      }
      if (b.action === "request_changes" && b.note) {
        db.insert("comments", { id: newId("cmt"), entity_type: "report", entity_id: r.id, author_id: u.id, body: b.note, kind: "review_feedback", created_at: now });
      }
    });
    audit(db, req, `report.${b.action}`, { type: "report", id: r.id }, { from: r.status, to, note: b.note.slice(0, 200) });
    if (["approve", "publish"].includes(b.action)) activity(db, u, b.action === "approve" ? "report.approved" : "report.published", { type: "report", id: r.id, label: r.title }, { projectId: r.project_id });
    if (b.action === "submit") {
      const reviewers = patch.reviewer_id ? [patch.reviewer_id as string] : reviewerCandidates(db, r);
      for (const rid of reviewers) notify(db, { userId: rid, actorId: u.id, type: "report_review", title: `${u.name} submitted “${r.title}” for review`, entity: { type: "report", id: r.id } });
    }
    if (b.action === "request_changes") notify(db, { userId: r.author_id, actorId: u.id, type: "changes_requested", title: `Changes requested on “${r.title}”`, body: b.note.slice(0, 500), entity: { type: "report", id: r.id } });
    if (b.action === "approve") notify(db, { userId: r.author_id, actorId: u.id, type: "report_review", title: `“${r.title}” was approved by ${u.name}`, entity: { type: "report", id: r.id } });
    res.json(present(db, u, db.get<ReportRow>("SELECT * FROM reports WHERE id = ?", r.id)!));
  }),
);

// ---------------------------------------------------------------- versions
reportsRouter.get(
  "/:id/versions",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadReport(db, u, req.params.id);
    res.json(
      db.all(
        "SELECT v.id, v.version, v.status, v.change_note, v.created_at, us.name AS changed_by_name FROM report_versions v LEFT JOIN users us ON us.id = v.changed_by WHERE v.report_id = ? ORDER BY v.created_at DESC, v.version DESC",
        r.id,
      ),
    );
  }),
);

reportsRouter.get(
  "/:id/versions/:v",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadReport(db, u, req.params.id);
    const v = db.get<{ version: number; content: string; status: string; change_note: string; created_at: string }>(
      "SELECT version, content, status, change_note, created_at FROM report_versions WHERE report_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1",
      r.id,
      parseInt(req.params.v, 10) || 0,
    );
    if (!v) throw notFound("Version not found.");
    const content = parseJson<{ sections: Section[] }>(v.content, { sections: [] });
    res.json({ ...v, content: { sections: content.sections.map((s) => ({ ...s, sources: filterSources(db, u, s.sources) })) } });
  }),
);

// ---------------------------------------------------------------- export
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const TYPE_LABEL: Record<string, string> = { call_report: "Call report", fakawe: "Fakawe digest", project_report: "Project report" };

function renderHtml(db: Db, r: ReportRow, orgName: string): string {
  const n = names(db, r);
  const content = parseJson<{ sections: Section[] }>(r.content, { sections: [] });
  const meta = [
    n.meeting_title ? `Meeting: ${n.meeting_title}${n.meeting_date ? ` (${n.meeting_date})` : ""}` : "",
    n.project_name ? `Project: ${n.project_name}` : "",
    n.period_name ? `Reporting period: ${n.period_name}` : "",
    `Status: ${r.status.replace(/_/g, " ")} · Version ${r.version}`,
    n.approved_by_name ? `Approved by ${n.approved_by_name} on ${(r.approved_at ?? "").slice(0, 10)}` : "Not yet approved",
  ].filter(Boolean);
  const paras = (t: string) =>
    t
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
  const sections = content.sections
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.title)}</h2>${s.body ? paras(s.body) : ""}${s.items && s.items.length ? `<ul>${s.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : ""}${
          !s.body && !(s.items && s.items.length) ? "<p class=\"muted\">Nothing recorded.</p>" : ""
        }</section>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(r.title)}</title>
<style>
body{font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1b2230;max-width:820px;margin:32px auto;padding:0 24px;line-height:1.55}
header{border-bottom:2px solid #0f1b2d;padding-bottom:12px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-end;gap:16px}
.org{font-weight:700;color:#0f1b2d;letter-spacing:.02em}.type{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6b7385}
h1{font-size:22px;margin:4px 0 0}h2{font-size:16px;color:#16253b;margin:22px 0 8px}.meta{font-size:13px;color:#4a5263}.muted{color:#6b7385}
.note{font-size:12px;color:#6b7385;border:1px solid #e2dfd8;border-radius:6px;padding:6px 10px;margin-bottom:16px}
footer{margin-top:32px;border-top:1px solid #e2dfd8;padding-top:8px;font-size:11px;color:#6b7385}
@media print{.note{display:none}body{margin:0}}
</style></head><body>
<p class="note">To save as PDF, use your browser's Print command and choose “Save as PDF”.</p>
<header><div><div class="org">${escapeHtml(orgName)}</div><div class="type">${escapeHtml(TYPE_LABEL[r.report_type] ?? "Report")}</div><h1>${escapeHtml(r.title)}</h1></div></header>
<div class="meta">${meta.map((m) => `<div>${escapeHtml(m)}</div>`).join("")}</div>
${sections}
<footer>Generated from CSI Workspace on ${escapeHtml(nowIso().slice(0, 10))}.${r.status === "draft" || r.status === "in_review" || r.status === "changes_requested" ? " DRAFT — not approved." : ""}</footer>
</body></html>`;
}

function renderMarkdown(db: Db, r: ReportRow, orgName: string): string {
  const n = names(db, r);
  const content = parseJson<{ sections: Section[] }>(r.content, { sections: [] });
  const lines = [`# ${r.title}`, "", `**${orgName}** — ${TYPE_LABEL[r.report_type] ?? "Report"}`, ""];
  if (n.meeting_title) lines.push(`- Meeting: ${n.meeting_title}${n.meeting_date ? ` (${n.meeting_date})` : ""}`);
  if (n.project_name) lines.push(`- Project: ${n.project_name}`);
  if (n.period_name) lines.push(`- Reporting period: ${n.period_name}`);
  lines.push(`- Status: ${r.status.replace(/_/g, " ")} (version ${r.version})`, "");
  for (const s of content.sections) {
    lines.push(`## ${s.title}`, "");
    if (s.body) lines.push(s.body, "");
    if (s.items?.length) lines.push(...s.items.map((i) => `- ${i}`), "");
  }
  return lines.join("\n");
}

reportsRouter.get(
  "/:id/export",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const r = loadReport(db, u, req.params.id);
    const format = String(req.query.format ?? "html");
    const orgName = getSetting(db, "org.name", "Change Science Institute");
    const safeName = r.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "report";
    if (format === "gdoc") throw new HttpError(501, "Google Docs export is not configured. Download HTML or Markdown and paste it into Google Docs, or ask an administrator to set up the Google Docs integration.");
    audit(db, req, "export.report", { type: "report", id: r.id }, { format });
    if (format === "md") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.md"`);
      return res.send(renderMarkdown(db, r, orgName));
    }
    if (format !== "html") throw badRequest("Unsupported export format.");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Standalone document: no scripts, inline styles only.
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${safeName}.html"`);
    res.send(renderHtml(db, r, orgName));
  }),
);
