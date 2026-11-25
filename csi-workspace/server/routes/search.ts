/**
 * Global search + knowledge assistant.
 *
 * Every entity query embeds the module's visibility SQL fragment, so restricted rows are
 * never loaded for unauthorised users — results, snippets, counts and assistant sources
 * are all built from permitted rows only.
 */
import { Router } from "express";
import { z } from "zod";
import type { SQLInputValue } from "node:sqlite";
import { h, parse } from "../lib/http.js";
import { currentUser, type AuthUser } from "../lib/context.js";
import {
  decisionVisibleSql,
  knowledgeVisibleSql,
  learningVisibleSql,
  meetingVisibleSql,
  opportunityVisibleSql,
  projectIdVisibleSql,
  projectVisibleSql,
  reportVisibleSql,
  taskVisibleSql,
  type SqlFrag,
} from "../lib/access.js";
import { answerFromSources, engine, type KnowledgeSource } from "../ai/service.js";
import type { Db } from "../db/index.js";
import { likeTerm } from "./knowledge.js";

export const searchRouter = Router();

export const SEARCH_TYPES = [
  "project", "programme", "task", "meeting", "report", "knowledge", "procedure", "deliverable", "milestone",
  "decision", "risk", "opportunity", "learning", "improvement", "person",
] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  snippet: string;
  date: string | null;
  project_name: string | null;
  status: string | null;
  url: string | null;
  score: number;
}

interface Spec {
  /** SQL selecting: id, title, text (concatenated searchable body), date, project_name, status, + extra cols. */
  select: string;
  from: string;
  vis: (u: AuthUser) => SqlFrag;
  title: string;
  fields: string[];
  url: (r: Record<string, unknown>) => string | null;
  type?: (r: Record<string, unknown>) => SearchType;
  extraWhere?: string;
}

const NONE: SqlFrag = { sql: "1 = 1", params: [] };

/** Flatten report JSON content into readable text for snippets. */
function reportText(content: unknown): string {
  try {
    const c = JSON.parse(String(content ?? "{}")) as { sections?: { title?: string; body?: string; items?: unknown[] }[] };
    return (c.sections ?? []).map((s) => [s.title, s.body, ...(s.items ?? []).map((i) => (typeof i === "string" ? i : JSON.stringify(i)))].filter(Boolean).join(". ")).join(" · ");
  } catch {
    return "";
  }
}

const SPECS: Record<Exclude<SearchType, "procedure">, Spec> = {
  project: {
    select: "p.id, p.name AS title, COALESCE(p.code, '') || ' ' || p.description || ' ' || p.objectives || ' ' || p.purpose AS text, p.updated_at AS date, p.name AS project_name, p.status",
    from: "projects p",
    vis: (u) => projectVisibleSql(u, "p"),
    title: "p.name",
    fields: ["p.name", "p.code", "p.description", "p.objectives", "p.purpose", "p.category"],
    url: (r) => `/projects/${r.id}`,
  },
  programme: {
    select: "g.id, g.name AS title, g.description AS text, g.updated_at AS date, NULL AS project_name, g.status",
    from: "programmes g",
    vis: () => NONE,
    title: "g.name",
    fields: ["g.name", "g.description"],
    url: (r) => `/projects?programme_id=${r.id}`,
  },
  task: {
    select: "t.id, t.title, t.description || ' ' || t.tags AS text, COALESCE(t.due_date, t.updated_at) AS date, pt.name AS project_name, t.status, t.ref",
    from: "tasks t LEFT JOIN projects pt ON pt.id = t.project_id",
    vis: (u) => taskVisibleSql(u, "t"),
    title: "t.title",
    fields: ["t.title", "t.description", "t.tags", "CAST(t.ref AS TEXT)"],
    url: (r) => `/tasks/${r.id}`,
  },
  meeting: {
    select: "m.id, m.title, m.purpose || ' ' || m.summary || ' ' || m.key_points || ' ' || m.notes AS text, m.meeting_date AS date, pm.name AS project_name, m.status",
    from: "meetings m LEFT JOIN projects pm ON pm.id = m.project_id",
    vis: (u) => meetingVisibleSql(u, "m"),
    title: "m.title",
    // Transcripts are intentionally not searched (sensitive raw material).
    fields: ["m.title", "m.purpose", "m.summary", "m.key_points", "m.notes"],
    url: (r) => `/meetings/${r.id}`,
  },
  report: {
    select: "r.id, r.title, r.content AS text, r.updated_at AS date, pr.name AS project_name, r.status, r.report_type",
    from: "reports r LEFT JOIN projects pr ON pr.id = r.project_id",
    vis: (u) => reportVisibleSql(u, "r"),
    title: "r.title",
    fields: ["r.title", "r.content"],
    url: (r) => `/reports/${r.id}`,
  },
  knowledge: {
    select: "k.id, k.title, k.summary || ' ' || k.body || ' ' || k.keywords || ' ' || k.tags AS text, COALESCE(k.published_date, k.updated_at) AS date, pk.name AS project_name, k.status, k.item_type",
    from: "knowledge_items k LEFT JOIN projects pk ON pk.id = k.project_id",
    vis: (u) => knowledgeVisibleSql(u, "k"),
    title: "k.title",
    fields: ["k.title", "k.summary", "k.body", "k.keywords", "k.tags", "k.category"],
    url: (r) => `/knowledge/${r.id}`,
    type: (r) => (r.item_type === "procedure" ? "procedure" : "knowledge"),
    extraWhere: "k.status <> 'archived'",
  },
  deliverable: {
    select: "d.id, d.name AS title, d.description || ' ' || d.acceptance_criteria AS text, COALESCE(d.due_date, d.updated_at) AS date, pd.name AS project_name, d.status, d.project_id",
    from: "deliverables d JOIN projects pd ON pd.id = d.project_id",
    vis: (u) => projectIdVisibleSql(u, "d.project_id"),
    title: "d.name",
    fields: ["d.name", "d.description", "d.acceptance_criteria"],
    url: (r) => `/projects/${r.project_id}?tab=deliverables`,
  },
  milestone: {
    select: "ms.id, ms.title, ms.description || ' ' || ms.notes AS text, COALESCE(ms.target_date, ms.updated_at) AS date, pms.name AS project_name, ms.status, ms.project_id",
    from: "milestones ms JOIN projects pms ON pms.id = ms.project_id",
    vis: (u) => projectIdVisibleSql(u, "ms.project_id"),
    title: "ms.title",
    fields: ["ms.title", "ms.description", "ms.notes"],
    url: (r) => `/projects/${r.project_id}?tab=milestones`,
  },
  decision: {
    select: "d.id, d.title, d.description || ' ' || d.context || ' ' || d.consequences AS text, COALESCE(d.decision_date, d.updated_at) AS date, pdc.name AS project_name, d.status, d.project_id, d.meeting_id",
    from: "decisions d LEFT JOIN projects pdc ON pdc.id = d.project_id",
    vis: (u) => decisionVisibleSql(u, "d"),
    title: "d.title",
    fields: ["d.title", "d.description", "d.context", "d.consequences"],
    url: (r) => (r.project_id ? `/projects/${r.project_id}?tab=decisions` : r.meeting_id ? `/meetings/${r.meeting_id}` : `/management/decisions`),
  },
  risk: {
    select: "rk.id, rk.title, rk.description || ' ' || rk.mitigation || ' ' || rk.impact AS text, rk.identified_date AS date, prk.name AS project_name, rk.status, rk.project_id",
    from: "risks rk JOIN projects prk ON prk.id = rk.project_id",
    vis: (u) => projectIdVisibleSql(u, "rk.project_id"),
    title: "rk.title",
    fields: ["rk.title", "rk.description", "rk.mitigation", "rk.impact"],
    url: (r) => `/projects/${r.project_id}?tab=risks`,
  },
  opportunity: {
    select: "o.id, o.name AS title, o.description || ' ' || o.organisation || ' ' || o.notes || ' ' || o.next_action AS text, o.updated_at AS date, NULL AS project_name, o.stage AS status",
    from: "opportunities o",
    vis: (u) => opportunityVisibleSql(u, "o"),
    title: "o.name",
    fields: ["o.name", "o.description", "o.organisation", "o.notes", "o.opportunity_type"],
    url: (r) => `/opportunities/${r.id}`,
  },
  learning: {
    select: "l.id, l.title, l.topic || ' ' || l.what_learned || ' ' || l.what_tried || ' ' || l.what_worked || ' ' || l.suggested_improvement AS text, l.created_at AS date, pl.name AS project_name, l.record_type AS status, l.project_id",
    from: "learning_records l LEFT JOIN projects pl ON pl.id = l.project_id",
    vis: (u) => learningVisibleSql(u, "l"),
    title: "l.title",
    fields: ["l.title", "l.topic", "l.what_learned", "l.what_tried", "l.what_worked", "l.what_did_not_work", "l.suggested_improvement"],
    url: (r) => `/learning/records/${r.id}`,
  },
  improvement: {
    select: "i.id, i.title, i.description || ' ' || i.problem || ' ' || i.proposed_solution AS text, i.updated_at AS date, pi.name AS project_name, i.status",
    from: "improvements i LEFT JOIN projects pi ON pi.id = i.project_id",
    vis: () => NONE,
    title: "i.title",
    fields: ["i.title", "i.description", "i.problem", "i.proposed_solution", "i.area"],
    url: (r) => `/learning/improvements/${r.id}`,
  },
  person: {
    // Directory info only: name, job title and team. No email/preferences in search results.
    select: "us.id, us.name AS title, us.job_title || CASE WHEN tm.name IS NOT NULL THEN ' · ' || tm.name ELSE '' END AS text, NULL AS date, NULL AS project_name, NULL AS status",
    from: "users us LEFT JOIN teams tm ON tm.id = us.team_id",
    vis: () => ({ sql: "us.active = 1", params: [] }),
    title: "us.name",
    fields: ["us.name", "us.job_title", "tm.name"],
    url: () => null,
  },
};

export function searchTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter((t) => t.length >= 2))].slice(0, 6);
}

export function makeSnippet(text: string, terms: string[], len = 180): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  let pos = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return t.length > len ? t.slice(0, len).trimEnd() + "…" : t;
  const start = Math.max(0, pos - 60);
  const end = Math.min(t.length, start + len);
  return (start > 0 ? "…" : "") + t.slice(start, end).trim() + (end < t.length ? "…" : "");
}

function scoreRow(title: string, text: string, q: string, terms: string[]): number {
  const tl = title.toLowerCase();
  const xl = text.toLowerCase();
  let s = 0;
  if (tl === q) s += 100;
  else if (tl.includes(q)) s += 60;
  for (const t of terms) {
    if (tl.includes(t)) s += 15;
    if (xl.includes(t)) s += 3;
  }
  return s;
}

export function runSearch(db: Db, u: AuthUser, q: string, types: SearchType[], perType: number): SearchResult[] {
  const terms = searchTerms(q);
  if (!terms.length) return [];
  const ql = q.toLowerCase().trim();
  const out: SearchResult[] = [];
  const specKeys = new Set<keyof typeof SPECS>();
  for (const t of types) specKeys.add(t === "procedure" ? "knowledge" : t);
  for (const key of specKeys) {
    const spec = SPECS[key];
    const vis = spec.vis(u);
    const where: string[] = [vis.sql];
    const params: SQLInputValue[] = [...vis.params];
    if (spec.extraWhere) where.push(spec.extraWhere);
    for (const term of terms) {
      where.push(`(${spec.fields.map((f) => `COALESCE(${f}, '') LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      params.push(...spec.fields.map(() => likeTerm(term)));
    }
    const rows = db.all<Record<string, unknown>>(`SELECT ${spec.select} FROM ${spec.from} WHERE ${where.join(" AND ")} LIMIT 200`, ...params);
    const scored = rows
      .map((r) => {
        const title = String(r.title ?? "");
        const text = key === "report" ? reportText(r.text) : String(r.text ?? "");
        const type = spec.type ? spec.type(r) : (key as SearchType);
        return {
          type,
          id: String(r.id),
          title: key === "task" && r.ref ? `T-${r.ref} ${title}` : title,
          snippet: makeSnippet(text, terms),
          date: r.date ? String(r.date).slice(0, 10) : null,
          project_name: (r.project_name as string | null) ?? null,
          status: (r.status as string | null) ?? null,
          url: spec.url(r),
          score: scoreRow(title, text, ql, terms),
        } satisfies SearchResult;
      })
      .filter((r) => types.includes(r.type))
      .sort((a, b) => b.score - a.score || (b.date ?? "").localeCompare(a.date ?? ""));
    // Apply per-type limit per resulting type (knowledge/procedure share a query).
    const perTypeCount: Record<string, number> = {};
    for (const r of scored) {
      perTypeCount[r.type] = (perTypeCount[r.type] ?? 0) + 1;
      if (perTypeCount[r.type] <= perType) out.push(r);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

searchRouter.get(
  "/search",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const p = parse(
      z.object({
        q: z.string().trim().min(2, "Enter at least 2 characters.").max(200, "Search text is too long."),
        types: z.string().max(400).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional().default(10),
      }),
      req.query,
    );
    const requested = (p.types ?? "").split(",").map((s) => s.trim()).filter((s): s is SearchType => (SEARCH_TYPES as readonly string[]).includes(s));
    const types = requested.length ? requested : [...SEARCH_TYPES];
    const results = runSearch(db, u, p.q, types, p.limit);
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.type] = (counts[r.type] ?? 0) + 1;
    res.json({ q: p.q, terms: searchTerms(p.q), results, counts });
  }),
);

// ------------------------------------------------------------------ knowledge assistant
const STOP = new Set(
  "the a an and or of to in on for with what which who whom how have has had does did do is are was were be been our we us csi about from that this these those where when there their any can could should would previous previously been find".split(" "),
);

interface AssistantSource extends KnowledgeSource {
  type: string;
  rawId: string;
  score: number;
}

export function assistantSources(db: Db, u: AuthUser, question: string, max = 6): AssistantSource[] {
  const terms = searchTerms(question).filter((t) => t.length >= 3 && !STOP.has(t));
  if (!terms.length) return [];
  const cands: AssistantSource[] = [];
  const termWhere = (fields: string[]) => {
    const sql = `(${terms.map(() => `(${fields.map((f) => `COALESCE(${f},'') LIKE ? ESCAPE '\\'`).join(" OR ")})`).join(" OR ")})`;
    const params: SQLInputValue[] = [];
    for (const t of terms) params.push(...fields.map(() => likeTerm(t)));
    return { sql, params };
  };
  // Approved sources only: published knowledge, approved meeting summaries, made/approved decisions, approved reports.
  {
    const v = knowledgeVisibleSql(u, "k");
    const w = termWhere(["k.title", "k.summary", "k.body", "k.keywords", "k.tags"]);
    for (const r of db.all<Record<string, string>>(
      `SELECT k.id, k.title, k.category, k.summary, k.body || ' ' || k.what_happened || ' ' || k.what_worked || ' ' || k.what_did_not_work || ' ' || k.do_differently AS body FROM knowledge_items k WHERE ${v.sql} AND k.status = 'published' AND ${w.sql} LIMIT 100`,
      ...v.params,
      ...w.params,
    )) cands.push({ type: "knowledge", rawId: r.id, id: `knowledge:${r.id}`, title: r.title, category: r.category, summary: r.summary, body: r.body, link: `/knowledge/${r.id}`, score: 0 });
  }
  {
    const v = meetingVisibleSql(u, "m");
    const w = termWhere(["m.title", "m.summary", "m.key_points"]);
    for (const r of db.all<Record<string, string>>(
      `SELECT m.id, m.title, m.meeting_date, m.summary, m.key_points FROM meetings m WHERE ${v.sql} AND m.status = 'approved' AND m.summary <> '' AND ${w.sql} LIMIT 50`,
      ...v.params,
      ...w.params,
    )) cands.push({ type: "meeting", rawId: r.id, id: `meeting:${r.id}`, title: `${r.title} (${r.meeting_date})`, category: "Approved meeting summary", summary: r.summary, body: r.key_points, link: `/meetings/${r.id}`, score: 0 });
  }
  {
    const v = decisionVisibleSql(u, "d");
    const w = termWhere(["d.title", "d.description", "d.context"]);
    for (const r of db.all<Record<string, string>>(
      `SELECT d.id, d.title, d.description, d.context, d.decision_date, d.status, d.project_id, d.meeting_id FROM decisions d WHERE ${v.sql} AND d.status IN ('made','approved') AND ${w.sql} LIMIT 50`,
      ...v.params,
      ...w.params,
    ))
      cands.push({
        type: "decision", rawId: r.id, id: `decision:${r.id}`, title: r.title, category: `Decision (${r.status}${r.decision_date ? ", " + r.decision_date : ""})`,
        summary: r.description, body: r.context, link: r.project_id ? `/projects/${r.project_id}?tab=decisions` : r.meeting_id ? `/meetings/${r.meeting_id}` : "/management/decisions", score: 0,
      });
  }
  {
    const v = reportVisibleSql(u, "r");
    const w = termWhere(["r.title", "r.content"]);
    for (const r of db.all<Record<string, string>>(
      `SELECT r.id, r.title, r.report_type, r.content FROM reports r WHERE ${v.sql} AND r.status IN ('approved','final','published','archived') AND ${w.sql} LIMIT 50`,
      ...v.params,
      ...w.params,
    )) cands.push({ type: "report", rawId: r.id, id: `report:${r.id}`, title: r.title, category: r.report_type === "fakawe" ? "Fakawe report" : "Approved report", summary: "", body: reportText(r.content), link: `/reports/${r.id}`, score: 0 });
  }
  for (const c of cands) {
    const tl = c.title.toLowerCase();
    const xl = `${c.summary} ${c.body}`.toLowerCase();
    for (const t of terms) {
      if (tl.includes(t)) c.score += 5;
      let i = xl.indexOf(t);
      let n = 0;
      while (i >= 0 && n < 5) {
        n++;
        i = xl.indexOf(t, i + t.length);
      }
      c.score += n;
    }
  }
  return cands.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
}

searchRouter.post(
  "/assistant/ask",
  h(async (req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const b = parse(z.object({ question: z.string().trim().min(3, "Ask a question of at least 3 characters.").max(500, "Please keep questions under 500 characters.") }), req.body);
    const sources = assistantSources(db, u, b.question);
    const terms = searchTerms(b.question);
    const results = sources.map((s) => ({ type: s.type, id: s.rawId, title: s.title, category: s.category, snippet: makeSnippet(`${s.summary} ${s.body}`, terms, 220), url: s.link }));
    const e = engine(req.ctx);
    if (!sources.length) {
      return res.json({
        engine: e.kind === "anthropic" ? `anthropic:${e.model}` : "rules",
        answer: null,
        insufficient: true,
        citations: [],
        results: [],
        note: "No approved records you have access to match this question. Try different words, or ask a knowledge manager.",
      });
    }
    const ai = await answerFromSources(req.ctx, u.id, b.question, sources);
    if (!ai) {
      return res.json({
        engine: "rules",
        answer: null,
        insufficient: false,
        citations: [],
        results,
        note: e.kind === "anthropic" ? "The AI assistant could not answer right now — showing the most relevant records." : "AI assistant not configured — showing the most relevant records.",
      });
    }
    const byId = new Map(sources.map((s) => [s.id, s]));
    res.json({
      engine: ai.engine,
      answer: ai.answer,
      insufficient: ai.insufficient,
      citations: ai.cited.map((id) => byId.get(id)!).filter(Boolean).map((s) => ({ type: s.type, id: s.rawId, title: s.title, url: s.link })),
      results,
      note: "AI-generated answer based only on approved records you can access. Check the cited sources before relying on it.",
    });
  }),
);
