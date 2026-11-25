/**
 * Administration, governance & configuration (/api/admin).
 * Every endpoint is gated by a specific admin.* permission and every mutation is audited.
 * Exports reuse the record-visibility helpers, so administrators never receive restricted,
 * personal or confidential rows they could not otherwise see.
 */
import crypto from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { h, parse, badRequest, notFound, conflict, zTitle, zText, pageParams, HttpError } from "../lib/http.js";
import { currentUser, requirePerm, type AuthUser } from "../lib/context.js";
import { newId, nowIso, isDate } from "../lib/ids.js";
import { audit, getSetting, setSetting, nextTaskRef, activity } from "../lib/events.js";
import { hashPassword } from "../lib/auth.js";
import { toCsv, parseCsv } from "../lib/csv.js";
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from "../lib/permissions.js";
import { integrationStatus } from "../integrations/google.js";
import { aiStatus } from "../ai/service.js";
import { DEFAULT_AUTOMATIONS, DEFAULT_TAXONOMIES } from "../db/bootstrap.js";
import {
  taskVisibleSql,
  projectVisibleSql,
  meetingVisibleSql,
  knowledgeVisibleSql,
  opportunityVisibleSql,
  decisionVisibleSql,
  projectIdVisibleSql,
} from "../lib/access.js";
import { runRule } from "../automation.js";

export const adminRouter = Router();

const perm = (req: Request, p: Permission) => {
  const u = currentUser(req);
  requirePerm(u, p);
  return u;
};

/** Strong, readable one-time password: 4 groups of base32-ish chars + digit. */
export function tempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}7`;
}

// ===================================================================== safeguards
function rolePerms(db: Db, roleKey: string): string[] {
  const r = db.get<{ permissions: string }>("SELECT permissions FROM roles WHERE key = ?", roleKey);
  try {
    return r ? JSON.parse(r.permissions) : [];
  } catch {
    return [];
  }
}

/**
 * Count active users who would hold admin.roles after a hypothetical change.
 * Overrides let callers simulate a user change (role / active) or a role permission change.
 */
function adminRoleHolders(db: Db, o: { userId?: string; userRole?: string; userActive?: boolean; roleKey?: string; rolePerms?: string[] } = {}): number {
  const roles = new Map(db.all<{ key: string; permissions: string }>("SELECT key, permissions FROM roles").map((r) => [r.key, safeJson<string[]>(r.permissions, [])]));
  if (o.roleKey && o.rolePerms) roles.set(o.roleKey, o.rolePerms);
  let n = 0;
  for (const u of db.all<{ id: string; role_key: string; active: number }>("SELECT id, role_key, active FROM users")) {
    const active = u.id === o.userId && o.userActive !== undefined ? o.userActive : !!u.active;
    const role = u.id === o.userId && o.userRole ? o.userRole : u.role_key;
    if (active && (roles.get(role) ?? []).includes("admin.roles")) n++;
  }
  return n;
}

function safeJson<T>(s: string | null | undefined, fb: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fb;
  } catch {
    return fb;
  }
}

const LAST_ADMIN_MSG = "This change would leave no active user who can manage roles and permissions. Give another active user that permission first.";

// ===================================================================== overview
adminRouter.get(
  "/overview",
  h((req, res) => {
    const u = currentUser(req);
    const adminPerms = [...u.permissions].filter((p) => p.startsWith("admin."));
    if (!adminPerms.length) throw new HttpError(403, "You do not have permission to do that.");
    const db = req.ctx.db;
    res.json({
      permissions: adminPerms,
      counts: {
        users: db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE active = 1")!.n,
        inactiveUsers: db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE active = 0")!.n,
        teams: db.get<{ n: number }>("SELECT COUNT(*) n FROM teams")!.n,
        roles: db.get<{ n: number }>("SELECT COUNT(*) n FROM roles")!.n,
        demoRecords: db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM users WHERE is_demo = 1) + (SELECT COUNT(*) FROM projects WHERE is_demo = 1) + (SELECT COUNT(*) FROM tasks WHERE is_demo = 1) n")!.n,
      },
    });
  }),
);

// ===================================================================== users
const USER_COLS = "u.id, u.name, u.email, u.role_key, r.name AS role_name, u.team_id, t.name AS team_name, u.job_title, u.auth_provider, u.active, u.must_change_password, u.last_login_at, u.is_demo, u.created_at, (u.password_hash IS NOT NULL) AS has_password";

adminRouter.get(
  "/users",
  h((req, res) => {
    perm(req, "admin.users");
    const db = req.ctx.db;
    const where: string[] = [];
    const params: (string | number)[] = [];
    const q = String(req.query.q ?? "").trim();
    if (q) {
      where.push("(u.name LIKE ? OR u.email LIKE ? OR u.job_title LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (req.query.role) {
      where.push("u.role_key = ?");
      params.push(String(req.query.role));
    }
    if (req.query.team) {
      where.push("u.team_id = ?");
      params.push(String(req.query.team));
    }
    if (req.query.active === "1" || req.query.active === "0") {
      where.push("u.active = ?");
      params.push(Number(req.query.active));
    }
    const sql = `SELECT ${USER_COLS} FROM users u JOIN roles r ON r.key = u.role_key LEFT JOIN teams t ON t.id = u.team_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY u.active DESC, u.name`;
    res.json(db.all(sql, ...params));
  }),
);

const zUserBase = {
  name: z.string().trim().min(2, "Enter the person's full name.").max(120),
  role_key: z.string().min(1, "Choose a role."),
  team_id: z.union([z.string(), z.literal(""), z.null()]).optional().transform((v) => v || null),
  job_title: z.string().trim().max(120).optional().default(""),
};

function assertRoleTeam(db: Db, role: string, team: string | null) {
  if (!db.get("SELECT 1 FROM roles WHERE key = ?", role)) throw badRequest("Unknown role.", { fields: { role_key: "Unknown role." } });
  if (team && !db.get("SELECT 1 FROM teams WHERE id = ?", team)) throw badRequest("Unknown team.", { fields: { team_id: "Unknown team." } });
}

adminRouter.post(
  "/users",
  h((req, res) => {
    const me = perm(req, "admin.users");
    const db = req.ctx.db;
    const b = parse(
      z.object({ ...zUserBase, email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(200), auth: z.enum(["password", "google"]).default("password") }),
      req.body,
    );
    assertRoleTeam(db, b.role_key, b.team_id);
    // Assigning roles with admin.roles requires admin.roles yourself (prevents privilege escalation by user managers).
    if (rolePerms(db, b.role_key).some((p) => p.startsWith("admin.")) && !me.permissions.has("admin.roles"))
      throw new HttpError(403, "Only users who manage roles can create administrator accounts.");
    if (db.get("SELECT 1 FROM users WHERE email = ?", b.email)) throw conflict("A user with that email already exists.");
    const id = newId("usr");
    const now = nowIso();
    const pw = b.auth === "password" ? tempPassword() : null;
    db.insert("users", {
      id, name: b.name, email: b.email, role_key: b.role_key, team_id: b.team_id, job_title: b.job_title,
      password_hash: pw ? hashPassword(pw) : null, auth_provider: b.auth === "google" ? "google" : "local",
      must_change_password: pw ? 1 : 0, created_at: now, updated_at: now,
    });
    audit(db, req, "user.create", { type: "user", id }, { email: b.email, role: b.role_key, team: b.team_id, auth: b.auth });
    res.status(201).json({ user: db.get(`SELECT ${USER_COLS} FROM users u JOIN roles r ON r.key = u.role_key LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?`, id), temporaryPassword: pw });
  }),
);

adminRouter.patch(
  "/users/:id",
  h((req, res) => {
    const me = perm(req, "admin.users");
    const db = req.ctx.db;
    const before = db.get<Record<string, unknown>>("SELECT id, name, role_key, team_id, job_title, active FROM users WHERE id = ?", req.params.id);
    if (!before) throw notFound("User not found.");
    const b = parse(z.object({ name: zUserBase.name.optional(), role_key: z.string().optional(), team_id: zUserBase.team_id, job_title: z.string().trim().max(120).optional() }), req.body);
    const role = b.role_key ?? (before.role_key as string);
    const team = b.team_id === undefined ? (before.team_id as string | null) : b.team_id;
    assertRoleTeam(db, role, team);
    if (role !== before.role_key) {
      const touchesAdmin = [...rolePerms(db, role), ...rolePerms(db, before.role_key as string)].some((p) => p.startsWith("admin."));
      if (touchesAdmin && !me.permissions.has("admin.roles")) throw new HttpError(403, "Only users who manage roles can grant or remove administrator access.");
      if (adminRoleHolders(db, { userId: req.params.id, userRole: role }) === 0) throw conflict(LAST_ADMIN_MSG);
    }
    db.update("users", req.params.id, { name: b.name, role_key: role, team_id: team, job_title: b.job_title, updated_at: nowIso() });
    if (role !== before.role_key) {
      audit(db, req, "permission.change", { type: "user", id: req.params.id }, { role: { from: before.role_key, to: role } });
      db.run("DELETE FROM sessions WHERE user_id = ?", req.params.id); // re-login picks up new permissions cleanly
    }
    audit(db, req, "user.update", { type: "user", id: req.params.id }, { before, after: { name: b.name ?? before.name, role_key: role, team_id: team, job_title: b.job_title ?? before.job_title } });
    res.json({ ok: true });
  }),
);

adminRouter.post(
  "/users/:id/deactivate",
  h((req, res) => {
    const me = perm(req, "admin.users");
    const db = req.ctx.db;
    const u = db.get<{ id: string; active: number; role_key: string }>("SELECT id, active, role_key FROM users WHERE id = ?", req.params.id);
    if (!u) throw notFound("User not found.");
    if (u.id === me.id) throw badRequest("You cannot deactivate your own account.");
    if (adminRoleHolders(db, { userId: u.id, userActive: false }) === 0) throw conflict(LAST_ADMIN_MSG);
    db.tx(() => {
      db.run("UPDATE users SET active = 0, updated_at = ? WHERE id = ?", nowIso(), u.id);
      db.run("DELETE FROM sessions WHERE user_id = ?", u.id);
    });
    audit(db, req, "user.deactivate", { type: "user", id: u.id }, { before: { active: !!u.active }, after: { active: false } });
    res.json({ ok: true });
  }),
);

adminRouter.post(
  "/users/:id/reactivate",
  h((req, res) => {
    perm(req, "admin.users");
    const db = req.ctx.db;
    if (!db.get("SELECT 1 FROM users WHERE id = ?", req.params.id)) throw notFound("User not found.");
    db.run("UPDATE users SET active = 1, updated_at = ? WHERE id = ?", nowIso(), req.params.id);
    audit(db, req, "user.reactivate", { type: "user", id: req.params.id }, { after: { active: true } });
    res.json({ ok: true });
  }),
);

adminRouter.post(
  "/users/:id/reset-password",
  h((req, res) => {
    const me = perm(req, "admin.users");
    const db = req.ctx.db;
    const u = db.get<{ id: string; role_key: string }>("SELECT id, role_key FROM users WHERE id = ?", req.params.id);
    if (!u) throw notFound("User not found.");
    if (rolePerms(db, u.role_key).some((p) => p.startsWith("admin.")) && !me.permissions.has("admin.roles") && u.id !== me.id)
      throw new HttpError(403, "Only users who manage roles can reset an administrator's password.");
    const pw = tempPassword();
    db.tx(() => {
      db.run("UPDATE users SET password_hash = ?, must_change_password = 1, auth_provider = 'local', updated_at = ? WHERE id = ?", hashPassword(pw), nowIso(), u.id);
      db.run("DELETE FROM sessions WHERE user_id = ?", u.id);
    });
    audit(db, req, "user.password_reset", { type: "user", id: u.id }, { sessionsRevoked: true });
    res.json({ temporaryPassword: pw });
  }),
);

adminRouter.get(
  "/users/:id/sessions",
  h((req, res) => {
    perm(req, "admin.users");
    res.json(req.ctx.db.all("SELECT substr(id, 1, 12) AS id, created_at, last_seen_at, expires_at, user_agent, ip FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC", req.params.id));
  }),
);

adminRouter.delete(
  "/users/:id/sessions",
  h((req, res) => {
    perm(req, "admin.users");
    const db = req.ctx.db;
    const r = db.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", req.params.id, req.sessionId ?? "");
    audit(db, req, "user.sessions_revoked", { type: "user", id: req.params.id }, { count: Number(r.changes) });
    res.json({ revoked: Number(r.changes) });
  }),
);

// ===================================================================== teams
adminRouter.get(
  "/teams",
  h((req, res) => {
    perm(req, "admin.users");
    res.json(
      req.ctx.db.all(
        "SELECT t.*, l.name AS lead_name, (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.active = 1) AS member_count FROM teams t LEFT JOIN users l ON l.id = t.lead_id ORDER BY t.name",
      ),
    );
  }),
);

const zTeam = z.object({
  name: z.string().trim().min(2, "Enter a team name.").max(80),
  description: zText(500).optional().default(""),
  lead_id: z.union([z.string(), z.literal(""), z.null()]).optional().transform((v) => v || null),
});

adminRouter.post(
  "/teams",
  h((req, res) => {
    perm(req, "admin.users");
    const db = req.ctx.db;
    const b = parse(zTeam, req.body);
    if (db.get("SELECT 1 FROM teams WHERE name = ?", b.name)) throw conflict("A team with that name already exists.");
    if (b.lead_id && !db.get("SELECT 1 FROM users WHERE id = ?", b.lead_id)) throw badRequest("Unknown team lead.");
    const id = newId("team");
    db.insert("teams", { id, ...b, created_at: nowIso() });
    audit(db, req, "team.create", { type: "team", id }, b);
    res.status(201).json(db.get("SELECT * FROM teams WHERE id = ?", id));
  }),
);

adminRouter.patch(
  "/teams/:id",
  h((req, res) => {
    perm(req, "admin.users");
    const db = req.ctx.db;
    const before = db.get("SELECT * FROM teams WHERE id = ?", req.params.id);
    if (!before) throw notFound("Team not found.");
    const b = parse(zTeam.partial(), req.body);
    if (b.name && db.get("SELECT 1 FROM teams WHERE name = ? AND id <> ?", b.name, req.params.id)) throw conflict("A team with that name already exists.");
    if (b.lead_id && !db.get("SELECT 1 FROM users WHERE id = ?", b.lead_id)) throw badRequest("Unknown team lead.");
    db.update("teams", req.params.id, { name: b.name, description: b.description, lead_id: b.lead_id === undefined ? undefined : b.lead_id });
    if (b.lead_id === null) db.run("UPDATE teams SET lead_id = NULL WHERE id = ?", req.params.id);
    audit(db, req, "team.update", { type: "team", id: req.params.id }, { before, after: b });
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  "/teams/:id",
  h((req, res) => {
    perm(req, "admin.users");
    const db = req.ctx.db;
    const t = db.get("SELECT * FROM teams WHERE id = ?", req.params.id);
    if (!t) throw notFound("Team not found.");
    db.run("DELETE FROM teams WHERE id = ?", req.params.id); // FKs set users/projects team_id to NULL
    audit(db, req, "team.delete", { type: "team", id: req.params.id }, { before: t });
    res.json({ ok: true });
  }),
);

// ===================================================================== roles
adminRouter.get(
  "/roles",
  h((req, res) => {
    perm(req, "admin.roles");
    const db = req.ctx.db;
    const roles = db
      .all<{ key: string; name: string; description: string; permissions: string; is_system: number; sort_order: number }>("SELECT * FROM roles ORDER BY sort_order, name")
      .map((r) => ({
        ...r,
        permissions: safeJson<string[]>(r.permissions, []),
        user_count: db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role_key = ? AND active = 1", r.key)!.n,
      }));
    res.json({ roles, catalogue: PERMISSIONS });
  }),
);

const zPerms = z.array(z.string()).refine((a) => a.every((p) => (ALL_PERMISSIONS as string[]).includes(p)), "Unknown permission in list.");

adminRouter.post(
  "/roles",
  h((req, res) => {
    perm(req, "admin.roles");
    const db = req.ctx.db;
    const b = parse(
      z.object({
        key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,39}$/, "Use 3–40 lowercase letters, numbers or underscores."),
        name: z.string().trim().min(2).max(80),
        description: zText(300).optional().default(""),
        permissions: zPerms,
      }),
      req.body,
    );
    if (db.get("SELECT 1 FROM roles WHERE key = ?", b.key)) throw conflict("A role with that key already exists.");
    const order = (db.get<{ m: number }>("SELECT MAX(sort_order) m FROM roles")!.m ?? 0) + 1;
    db.insert("roles", { key: b.key, name: b.name, description: b.description, permissions: JSON.stringify([...new Set(b.permissions)]), is_system: 0, sort_order: order });
    audit(db, req, "permission.change", { type: "role", id: b.key }, { created: true, permissions: b.permissions });
    res.status(201).json({ ok: true });
  }),
);

adminRouter.patch(
  "/roles/:key",
  h((req, res) => {
    perm(req, "admin.roles");
    const db = req.ctx.db;
    const before = db.get<{ name: string; description: string; permissions: string }>("SELECT name, description, permissions FROM roles WHERE key = ?", req.params.key);
    if (!before) throw notFound("Role not found.");
    const b = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), description: zText(300).optional(), permissions: zPerms.optional() }), req.body);
    if (b.permissions && adminRoleHolders(db, { roleKey: req.params.key, rolePerms: b.permissions }) === 0) throw conflict(LAST_ADMIN_MSG);
    db.update("roles", req.params.key, { name: b.name, description: b.description, permissions: b.permissions ? JSON.stringify([...new Set(b.permissions)]) : undefined }, "key");
    const beforePerms = safeJson<string[]>(before.permissions, []);
    audit(db, req, "permission.change", { type: "role", id: req.params.key }, {
      name: b.name && b.name !== before.name ? { from: before.name, to: b.name } : undefined,
      added: b.permissions ? b.permissions.filter((p) => !beforePerms.includes(p)) : [],
      removed: b.permissions ? beforePerms.filter((p) => !b.permissions!.includes(p)) : [],
    });
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  "/roles/:key",
  h((req, res) => {
    perm(req, "admin.roles");
    const db = req.ctx.db;
    const r = db.get<{ is_system: number }>("SELECT is_system FROM roles WHERE key = ?", req.params.key);
    if (!r) throw notFound("Role not found.");
    if (r.is_system) throw badRequest("Built-in roles cannot be deleted. You can edit their permissions instead.");
    if (db.get("SELECT 1 FROM users WHERE role_key = ?", req.params.key)) throw conflict("Move every user (including inactive users) to another role before deleting this one.");
    db.run("DELETE FROM roles WHERE key = ?", req.params.key);
    audit(db, req, "permission.change", { type: "role", id: req.params.key }, { deleted: true });
    res.json({ ok: true });
  }),
);

// ===================================================================== settings
const SETTINGS_SCHEMA = z.object({
  "org.name": z.string().trim().min(2).max(120),
  "org.short_name": z.string().trim().min(1).max(20),
  "org.timezone": z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Use a valid IANA timezone, e.g. Africa/Johannesburg."),
  "org.currency": z.string().trim().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code."),
  "ai.enabled": z.boolean(),
  "projects.default_progress_method": z.enum(["milestones", "deliverables", "tasks", "manual", "weighted"]),
  "projects.health_rules": z.object({
    overdueMilestoneDays: z.number().int().min(0).max(90),
    blockedTasksForAttention: z.number().int().min(1).max(50),
    staleUpdateDays: z.number().int().min(1).max(180),
  }),
  "notifications.reminder_days_before_due": z.number().int().min(0).max(14),
  "fakawe.default_audience": z.enum(["management", "all_staff"]),
});
type SettingKey = keyof z.infer<typeof SETTINGS_SCHEMA>;
const SETTING_KEYS = Object.keys(SETTINGS_SCHEMA.shape) as SettingKey[];

function readSettings(db: Db) {
  const out: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(db, k, null);
  return out;
}

adminRouter.get(
  "/settings",
  h((req, res) => {
    perm(req, "admin.settings");
    res.json(readSettings(req.ctx.db));
  }),
);

adminRouter.patch(
  "/settings",
  h((req, res) => {
    const me = perm(req, "admin.settings");
    const db = req.ctx.db;
    const b = parse(SETTINGS_SCHEMA.partial().strict(), req.body);
    const before = readSettings(db);
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    db.tx(() => {
      for (const [k, v] of Object.entries(b)) {
        if (v === undefined) continue;
        if (JSON.stringify(before[k]) !== JSON.stringify(v)) changed[k] = { from: before[k], to: v };
        setSetting(db, k, v, me.id);
      }
    });
    if (Object.keys(changed).length) audit(db, req, "settings.update", { type: "settings", id: "app" }, changed);
    res.json(readSettings(db));
  }),
);

adminRouter.get(
  "/integrations",
  h((req, res) => {
    perm(req, "admin.settings");
    res.json({ integrations: integrationStatus(req.ctx.config), ai: aiStatus(req.ctx) });
  }),
);

// ---------------------------------------------------------------- taxonomies
const TAXONOMIES = Object.keys(DEFAULT_TAXONOMIES);
const TAXONOMY_LABELS: Record<string, string> = {
  project_category: "Project categories",
  knowledge_category: "Knowledge categories",
  meeting_type: "Meeting types",
  opportunity_type: "Opportunity types",
  task_type: "Task types",
  improvement_area: "Improvement areas",
};

adminRouter.get(
  "/taxonomies",
  h((req, res) => {
    perm(req, "admin.settings");
    const rows = req.ctx.db.all<{ taxonomy: string }>("SELECT * FROM taxonomy_terms ORDER BY taxonomy, sort_order, label");
    res.json({ taxonomies: TAXONOMIES.map((t) => ({ key: t, label: TAXONOMY_LABELS[t] ?? t, terms: rows.filter((r) => r.taxonomy === t) })) });
  }),
);

adminRouter.post(
  "/taxonomies/:taxonomy",
  h((req, res) => {
    perm(req, "admin.settings");
    const db = req.ctx.db;
    if (!TAXONOMIES.includes(req.params.taxonomy)) throw notFound("Unknown taxonomy.");
    const b = parse(z.object({ label: z.string().trim().min(1, "Enter a label.").max(80) }), req.body);
    if (db.get("SELECT 1 FROM taxonomy_terms WHERE taxonomy = ? AND label = ?", req.params.taxonomy, b.label)) throw conflict("That term already exists.");
    const order = (db.get<{ m: number | null }>("SELECT MAX(sort_order) m FROM taxonomy_terms WHERE taxonomy = ?", req.params.taxonomy)!.m ?? -1) + 1;
    const id = newId("tax");
    db.insert("taxonomy_terms", { id, taxonomy: req.params.taxonomy, label: b.label, sort_order: order, active: 1 });
    audit(db, req, "taxonomy.create", { type: "taxonomy_term", id }, { taxonomy: req.params.taxonomy, label: b.label });
    res.status(201).json(db.get("SELECT * FROM taxonomy_terms WHERE id = ?", id));
  }),
);

adminRouter.patch(
  "/taxonomy-terms/:id",
  h((req, res) => {
    perm(req, "admin.settings");
    const db = req.ctx.db;
    const t = db.get<{ taxonomy: string; label: string; active: number; sort_order: number }>("SELECT * FROM taxonomy_terms WHERE id = ?", req.params.id);
    if (!t) throw notFound("Term not found.");
    const b = parse(z.object({ label: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional(), move: z.enum(["up", "down"]).optional() }), req.body);
    if (b.label && b.label !== t.label && db.get("SELECT 1 FROM taxonomy_terms WHERE taxonomy = ? AND label = ? AND id <> ?", t.taxonomy, b.label, req.params.id))
      throw conflict("That term already exists.");
    db.tx(() => {
      db.update("taxonomy_terms", req.params.id, { label: b.label, active: b.active === undefined ? undefined : b.active ? 1 : 0 });
      if (b.move) {
        const terms = db.all<{ id: string }>("SELECT id FROM taxonomy_terms WHERE taxonomy = ? ORDER BY sort_order, label", t.taxonomy).map((r) => r.id);
        const i = terms.indexOf(req.params.id);
        const j = b.move === "up" ? i - 1 : i + 1;
        if (j >= 0 && j < terms.length) [terms[i], terms[j]] = [terms[j], terms[i]];
        terms.forEach((id, idx) => db.run("UPDATE taxonomy_terms SET sort_order = ? WHERE id = ?", idx, id));
      }
    });
    audit(db, req, "taxonomy.update", { type: "taxonomy_term", id: req.params.id }, { before: { label: t.label, active: !!t.active }, after: b });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- report templates
const zSections = z
  .array(z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), title: z.string().trim().min(1).max(120), enabled: z.boolean() }))
  .min(1, "A template needs at least one section.")
  .refine((a) => new Set(a.map((s) => s.key)).size === a.length, "Section keys must be unique.");

adminRouter.get(
  "/templates",
  h((req, res) => {
    perm(req, "admin.settings");
    res.json(
      req.ctx.db
        .all<{ sections: string }>("SELECT * FROM report_templates ORDER BY report_type, is_default DESC, name")
        .map((t) => ({ ...t, sections: safeJson(t.sections, []) })),
    );
  }),
);

const zTemplate = z.object({
  report_type: z.enum(["call_report", "fakawe", "project_report"]),
  name: zTitle,
  header_text: z.string().trim().max(200).optional().default("Change Science Institute"),
  sections: zSections,
  is_default: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
});

function setDefaultTemplate(db: Db, id: string, type: string) {
  db.run("UPDATE report_templates SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE report_type = ?", id, type);
}

adminRouter.post(
  "/templates",
  h((req, res) => {
    perm(req, "admin.settings");
    const db = req.ctx.db;
    const b = parse(zTemplate, req.body);
    const id = newId("tpl");
    const now = nowIso();
    db.tx(() => {
      db.insert("report_templates", { id, report_type: b.report_type, name: b.name, header_text: b.header_text, sections: JSON.stringify(b.sections), is_default: 0, active: b.active ? 1 : 0, created_at: now, updated_at: now });
      if (b.is_default) setDefaultTemplate(db, id, b.report_type);
    });
    audit(db, req, "template.create", { type: "report_template", id }, { name: b.name, type: b.report_type });
    res.status(201).json({ id });
  }),
);

adminRouter.patch(
  "/templates/:id",
  h((req, res) => {
    perm(req, "admin.settings");
    const db = req.ctx.db;
    const t = db.get<{ report_type: string; name: string; is_default: number }>("SELECT * FROM report_templates WHERE id = ?", req.params.id);
    if (!t) throw notFound("Template not found.");
    const b = parse(zTemplate.omit({ report_type: true }).partial(), req.body);
    if (b.active === false && t.is_default) throw badRequest("Choose another default template before deactivating this one.");
    db.tx(() => {
      db.update("report_templates", req.params.id, {
        name: b.name, header_text: b.header_text, sections: b.sections ? JSON.stringify(b.sections) : undefined,
        active: b.active === undefined ? undefined : b.active ? 1 : 0, updated_at: nowIso(),
      });
      if (b.is_default) setDefaultTemplate(db, req.params.id, t.report_type);
    });
    audit(db, req, "template.update", { type: "report_template", id: req.params.id }, { name: t.name, fields: Object.keys(b) });
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  "/templates/:id",
  h((req, res) => {
    perm(req, "admin.settings");
    const db = req.ctx.db;
    const t = db.get<{ is_default: number; name: string }>("SELECT * FROM report_templates WHERE id = ?", req.params.id);
    if (!t) throw notFound("Template not found.");
    if (t.is_default) throw badRequest("The default template cannot be deleted. Make another template the default first.");
    db.run("DELETE FROM report_templates WHERE id = ?", req.params.id); // FKs on reports/periods set NULL
    audit(db, req, "template.delete", { type: "report_template", id: req.params.id }, { name: t.name });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- automations
adminRouter.get(
  "/automations",
  h((req, res) => {
    perm(req, "admin.settings");
    const db = req.ctx.db;
    const rules = db.all<{ key: string; config: string }>("SELECT * FROM automation_rules ORDER BY name").map((r) => ({ ...r, config: safeJson(r.config, {}) }));
    const runs = db.all("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 50");
    res.json({ rules, runs });
  }),
);

adminRouter.patch(
  "/automations/:key",
  h((req, res) => {
    perm(req, "admin.settings");
    const db = req.ctx.db;
    const r = db.get<{ enabled: number; config: string }>("SELECT enabled, config FROM automation_rules WHERE key = ?", req.params.key);
    if (!r) throw notFound("Automation not found.");
    const b = parse(z.object({ enabled: z.boolean().optional(), config: z.record(z.union([z.number(), z.string(), z.boolean()])).optional() }), req.body);
    db.update("automation_rules", req.params.key, { enabled: b.enabled === undefined ? undefined : b.enabled ? 1 : 0, config: b.config ? JSON.stringify(b.config) : undefined }, "key");
    audit(db, req, "automation.update", { type: "automation", id: req.params.key }, { before: { enabled: !!r.enabled, config: safeJson(r.config, {}) }, after: b });
    res.json({ ok: true });
  }),
);

adminRouter.post(
  "/automations/:key/run",
  h((req, res) => {
    perm(req, "admin.settings");
    const db = req.ctx.db;
    if (!DEFAULT_AUTOMATIONS.some((a) => a.key === req.params.key)) throw notFound("Automation not found.");
    const result = runRule(req.ctx, req.params.key, { force: true });
    audit(db, req, "automation.run", { type: "automation", id: req.params.key }, { result });
    res.json(result);
  }),
);

// ===================================================================== audit log
function auditWhere(q: Record<string, unknown>) {
  const where: string[] = [];
  const params: string[] = [];
  if (q.action) {
    where.push("a.action LIKE ?");
    params.push(`${String(q.action)}%`);
  }
  if (q.user) {
    where.push("(a.user_id = ? OR a.user_email LIKE ?)");
    params.push(String(q.user), `%${String(q.user)}%`);
  }
  if (q.entity_type) {
    where.push("a.entity_type = ?");
    params.push(String(q.entity_type));
  }
  if (q.entity_id) {
    where.push("a.entity_id = ?");
    params.push(String(q.entity_id));
  }
  if (isDate(q.from)) {
    where.push("a.created_at >= ?");
    params.push(`${q.from}T00:00:00`);
  }
  if (isDate(q.to)) {
    where.push("a.created_at < ?");
    params.push(new Date(Date.parse(`${q.to}T00:00:00Z`) + 86400000).toISOString());
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

adminRouter.get(
  "/audit",
  h((req, res) => {
    perm(req, "admin.audit");
    const db = req.ctx.db;
    const { limit, offset } = pageParams(req.query as Record<string, unknown>, 50, 200);
    const w = auditWhere(req.query as Record<string, unknown>);
    const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM audit_log a ${w.sql}`, ...w.params)!.n;
    const items = db.all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${w.sql} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, ...w.params, limit, offset);
    const actions = db.all<{ action: string }>("SELECT DISTINCT action FROM audit_log ORDER BY action").map((r) => r.action);
    res.json({ items, total, limit, offset, actions });
  }),
);

adminRouter.get(
  "/audit.csv",
  h((req, res) => {
    perm(req, "admin.audit");
    const db = req.ctx.db;
    const w = auditWhere(req.query as Record<string, unknown>);
    const rows = db.all<Record<string, unknown>>(`SELECT a.created_at, a.user_email, a.action, a.entity_type, a.entity_id, a.ip, a.changes FROM audit_log a ${w.sql} ORDER BY a.created_at DESC LIMIT 50000`, ...w.params);
    audit(db, req, "data.export", { type: "audit_log", id: "csv" }, { rows: rows.length, filters: req.query });
    sendCsv(res, `audit-log-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, ["created_at", "user_email", "action", "entity_type", "entity_id", "ip", "changes"]));
  }),
);

function sendCsv(res: import("express").Response, filename: string, csv: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send("﻿" + csv);
}

// ===================================================================== data governance
export const RETENTION_KEYS = {
  "retention.audit_days": { label: "Audit log", min: 365 },
  "retention.notifications_days": { label: "Notifications", min: 7 },
  "retention.ai_suggestions_days": { label: "Unaccepted AI / rule-based suggestions", min: 7 },
  "retention.sessions_days": { label: "Expired sign-in sessions", min: 1 },
  "retention.meeting_transcripts_days": { label: "Imported meeting transcripts", min: 7 },
} as const;

adminRouter.get(
  "/retention",
  h((req, res) => {
    perm(req, "admin.data");
    const db = req.ctx.db;
    res.json(Object.entries(RETENTION_KEYS).map(([key, m]) => ({ key, label: m.label, min: m.min, days: getSetting<number>(db, key, 0) })));
  }),
);

adminRouter.patch(
  "/retention",
  h((req, res) => {
    const me = perm(req, "admin.data");
    const db = req.ctx.db;
    const b = parse(z.record(z.number().int().min(0).max(36500)), req.body);
    const errors: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) {
      const meta = RETENTION_KEYS[k as keyof typeof RETENTION_KEYS];
      if (!meta) errors[k] = "Unknown retention setting.";
      else if (v !== 0 && v < meta.min) errors[k] = `Use 0 (keep indefinitely) or at least ${meta.min} days.`;
    }
    if (Object.keys(errors).length) throw badRequest("Please check the highlighted fields.", { fields: errors });
    const before: Record<string, number> = {};
    for (const [k, v] of Object.entries(b)) {
      before[k] = getSetting<number>(db, k, 0);
      setSetting(db, k, v, me.id);
    }
    audit(db, req, "retention.update", { type: "settings", id: "retention" }, { before, after: b });
    res.json({ ok: true });
  }),
);

/** FK-safe delete order for demo data (children before parents). */
const DEMO_TABLES = [
  "ai_suggestions", "notifications", "activity", "comments", "attachments", "entity_links", "dependencies", "status_history",
  "task_collaborators", "tasks", "report_versions", "reports", "reporting_periods", "knowledge_access", "knowledge_versions", "knowledge_items",
  "learning_records", "learning_themes", "improvements", "opportunities", "decisions", "risks", "deliverable_versions", "deliverables",
  "milestones", "project_updates", "meeting_participants", "meetings", "project_members", "projects", "programmes",
];

export function purgeDemoData(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  const demoUsers = db.all<{ id: string }>("SELECT id FROM users WHERE is_demo = 1").map((r) => r.id);
  const inList = (col: string) => (demoUsers.length ? `${col} IN (${demoUsers.map(() => "?").join(",")})` : "0");
  db.tx(() => {
    const ids = (table: string) => db.all<{ id: string }>(`SELECT id FROM ${table} WHERE is_demo = 1`).map((r) => r.id);
    const demoTasks = ids("tasks");
    const demoMeetings = ids("meetings");
    const demoProjects = ids("projects");
    const demoKnowledge = ids("knowledge_items");
    const demoReports = ids("reports");
    const del = (label: string, sql: string, ...p: string[]) => {
      const r = db.run(sql, ...p);
      counts[label] = (counts[label] ?? 0) + Number(r.changes);
    };
    const each = (label: string, table: string, col: string, list: string[]) => {
      for (const id of list) del(label, `DELETE FROM ${table} WHERE ${col} = ?`, id);
    };
    each("ai_suggestions", "ai_suggestions", "source_id", demoMeetings);
    each("task_collaborators", "task_collaborators", "task_id", demoTasks);
    each("dependencies", "dependencies", "from_id", [...demoTasks]);
    for (const t of DEMO_TABLES) {
      const hasDemoCol = db.all<{ name: string }>(`PRAGMA table_info(${t})`).some((c) => c.name === "is_demo");
      if (hasDemoCol) del(t, `DELETE FROM ${t} WHERE is_demo = 1`);
    }
    for (const [type, list] of [["task", demoTasks], ["meeting", demoMeetings], ["project", demoProjects], ["knowledge", demoKnowledge], ["report", demoReports]] as const) {
      for (const id of list) {
        del("comments", "DELETE FROM comments WHERE entity_type = ? AND entity_id = ?", type, id);
        del("attachments", "DELETE FROM attachments WHERE entity_type = ? AND entity_id = ?", type, id);
        del("entity_links", "DELETE FROM entity_links WHERE (a_type = ? AND a_id = ?) OR (b_type = ? AND b_id = ?)", type, id, type, id);
        del("activity", "DELETE FROM activity WHERE entity_type = ? AND entity_id = ?", type, id);
        del("status_history", "DELETE FROM status_history WHERE entity_type = ? AND entity_id = ?", type, id);
        del("dependencies", "DELETE FROM dependencies WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)", type, id, type, id);
      }
    }
    if (demoUsers.length) {
      del("notifications", `DELETE FROM notifications WHERE ${inList("user_id")}`, ...demoUsers);
      del("sessions", `DELETE FROM sessions WHERE ${inList("user_id")}`, ...demoUsers);
      del("teams", `DELETE FROM teams WHERE ${inList("lead_id")} AND description LIKE '%(demo)%'`, ...demoUsers);
      del("users", "DELETE FROM users WHERE is_demo = 1");
    }
    for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  });
  return counts;
}

adminRouter.post(
  "/purge-demo",
  h((req, res) => {
    const me = perm(req, "admin.data");
    const db = req.ctx.db;
    const b = parse(z.object({ confirm: z.string() }), req.body);
    if (b.confirm !== "DELETE DEMO DATA") throw badRequest('Type "DELETE DEMO DATA" exactly to confirm.', { fields: { confirm: 'Type "DELETE DEMO DATA" exactly.' } });
    if (me.is_demo) throw badRequest("Sign in with a non-demo administrator account before purging demo data (demo accounts are deleted by the purge). Set BOOTSTRAP_ADMIN_EMAIL/PASSWORD or create a real admin user first.");
    const counts = purgeDemoData(db);
    audit(db, req, "data.purge_demo", { type: "system", id: "demo" }, counts);
    res.json({ deleted: counts });
  }),
);

// ---------------------------------------------------------------- import
const IMPORT_FIELDS = {
  tasks: [
    { key: "title", label: "Title", required: true, aliases: ["title", "task", "task title", "name", "action"] },
    { key: "description", label: "Description", aliases: ["description", "details", "notes"] },
    { key: "assignee_email", label: "Assignee email", aliases: ["assignee", "assignee email", "owner", "owner email", "email", "responsible"] },
    { key: "project", label: "Project name", aliases: ["project", "project name"] },
    { key: "due_date", label: "Due date (YYYY-MM-DD)", aliases: ["due", "due date", "deadline", "due_date"] },
    { key: "priority", label: "Priority", aliases: ["priority"] },
    { key: "status", label: "Status", aliases: ["status", "state"] },
    { key: "tags", label: "Tags", aliases: ["tags", "labels"] },
  ],
  projects: [
    { key: "name", label: "Project name", required: true, aliases: ["name", "project", "project name", "title"] },
    { key: "description", label: "Description", aliases: ["description", "summary"] },
    { key: "owner_email", label: "Owner email", aliases: ["owner", "owner email", "lead", "manager"] },
    { key: "category", label: "Category", aliases: ["category", "type"] },
    { key: "status", label: "Status", aliases: ["status"] },
    { key: "priority", label: "Priority", aliases: ["priority"] },
    { key: "start_date", label: "Start date", aliases: ["start", "start date", "start_date"] },
    { key: "target_date", label: "Target date", aliases: ["target", "target date", "end date", "deadline", "target_date"] },
    { key: "visibility", label: "Visibility", aliases: ["visibility"] },
  ],
} as const;
type ImportEntity = keyof typeof IMPORT_FIELDS;

const TASK_STATUS: Record<string, string> = { todo: "todo", "to do": "todo", open: "todo", "not started": "todo", "in progress": "in_progress", in_progress: "in_progress", doing: "in_progress", blocked: "blocked", done: "completed", complete: "completed", completed: "completed", cancelled: "cancelled", canceled: "cancelled" };
const PROJECT_STATUS = ["proposed", "planning", "active", "on_hold", "at_risk", "completed", "cancelled"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

const zImport = z.object({
  entity: z.enum(["tasks", "projects"]),
  csv: z.string().min(1, "Paste or upload a CSV file.").max(1_500_000, "CSV is too large (max ~1.5 MB). Split it into smaller files."),
  mapping: z.record(z.string()).optional(),
  skipInvalid: z.boolean().optional().default(true),
});

/** Accepts YYYY-MM-DD, DD/MM/YYYY, YYYY/MM/DD. Returns null for invalid. */
function normDate(s: string): string | null | "invalid" {
  const v = s.trim();
  if (!v) return null;
  let iso = v;
  const dmy = v.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  const ymd = v.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (dmy) iso = `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  else if (ymd) iso = `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  if (!isDate(iso)) return "invalid";
  const back = new Date(iso + "T00:00:00Z").toISOString().slice(0, 10);
  return back === iso ? iso : "invalid";
}

interface PreparedRow {
  row: number;
  values: Record<string, string>;
  data: Record<string, unknown>;
  errors: string[];
  warnings: string[];
  duplicate: boolean;
}

function prepareImport(db: Db, u: AuthUser, entity: ImportEntity, csv: string, mappingIn?: Record<string, string>) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest("The CSV needs a header row and at least one data row.");
  if (rows.length > 5001) throw badRequest("Import at most 5,000 rows at a time.");
  const headers = rows[0].map((h) => h.trim());
  const fields = IMPORT_FIELDS[entity];
  const suggested: Record<string, string> = {};
  for (const f of fields) {
    const hit = headers.find((hd) => (f.aliases as readonly string[]).includes(hd.toLowerCase()));
    if (hit) suggested[f.key] = hit;
  }
  const mapping = mappingIn ?? suggested;
  for (const [k, col] of Object.entries(mapping)) {
    if (!fields.some((f) => f.key === k)) throw badRequest(`Unknown field "${k}".`);
    if (col && !headers.includes(col)) throw badRequest(`Column "${col}" is not in the CSV.`);
  }
  const missingRequired = fields.filter((f) => "required" in f && f.required && !mapping[f.key]).map((f) => f.label);

  const usersByEmail = new Map(db.all<{ id: string; email: string; active: number }>("SELECT id, email, active FROM users").map((r) => [r.email.toLowerCase(), r]));
  const pf = projectVisibleSql(u, "p");
  const visibleProjects = new Map(db.all<{ id: string; name: string }>(`SELECT p.id, p.name FROM projects p WHERE ${pf.sql}`, ...pf.params).map((p) => [p.name.toLowerCase(), p.id]));
  const allProjectNames = new Set(db.all<{ name: string }>("SELECT name FROM projects").map((p) => p.name.toLowerCase()));
  const seen = new Set<string>();
  const out: PreparedRow[] = [];

  rows.slice(1).forEach((r, i) => {
    const values: Record<string, string> = {};
    for (const f of fields) {
      const col = mapping[f.key];
      values[f.key] = col ? (r[headers.indexOf(col)] ?? "").trim() : "";
    }
    const errors: string[] = [];
    const warnings: string[] = [];
    const data: Record<string, unknown> = {};
    let duplicate = false;
    const date = (key: string, label: string) => {
      const d = normDate(values[key] ?? "");
      if (d === "invalid") errors.push(`${label} "${values[key]}" is not a valid date (use YYYY-MM-DD).`);
      else data[key] = d;
    };
    const prio = () => {
      const p = (values.priority ?? "").toLowerCase();
      if (!p) data.priority = "normal";
      else if (PRIORITIES.includes(p)) data.priority = p;
      else errors.push(`Priority "${values.priority}" must be one of ${PRIORITIES.join(", ")}.`);
    };
    if (entity === "tasks") {
      if (!values.title) errors.push("Title is required.");
      else if (values.title.length > 300) errors.push("Title is longer than 300 characters.");
      data.title = values.title;
      data.description = (values.description ?? "").slice(0, 5000);
      data.tags = values.tags ?? "";
      date("due_date", "Due date");
      prio();
      const st = (values.status ?? "").toLowerCase();
      if (!st) data.status = "todo";
      else if (TASK_STATUS[st]) data.status = TASK_STATUS[st];
      else errors.push(`Status "${values.status}" is not recognised.`);
      if (values.assignee_email) {
        const usr = usersByEmail.get(values.assignee_email.toLowerCase());
        if (!usr) errors.push(`No user with email ${values.assignee_email}.`);
        else if (!usr.active) errors.push(`${values.assignee_email} is deactivated.`);
        else data.assignee_id = usr.id;
      } else {
        data.assignee_id = u.id;
        warnings.push("No assignee — will be assigned to you.");
      }
      if (values.project) {
        const pid = visibleProjects.get(values.project.toLowerCase());
        if (!pid) errors.push(`Project "${values.project}" not found (or you cannot see it).`);
        else data.project_id = pid;
      } else data.project_id = null;
      const key = `${String(values.title).toLowerCase()}|${data.project_id ?? ""}`;
      if (values.title && (seen.has(key) || db.get("SELECT 1 FROM tasks WHERE lower(title) = ? AND IFNULL(project_id,'') = ? AND status NOT IN ('cancelled','completed')", values.title.toLowerCase(), (data.project_id as string) ?? ""))) {
        duplicate = true;
        warnings.push("Possible duplicate of an existing open task (same title and project).");
      }
      seen.add(key);
    } else {
      if (!values.name) errors.push("Project name is required.");
      data.name = values.name;
      data.description = (values.description ?? "").slice(0, 5000);
      data.category = values.category ?? "";
      date("start_date", "Start date");
      date("target_date", "Target date");
      if (data.start_date && data.target_date && (data.target_date as string) < (data.start_date as string)) errors.push("Target date is before start date.");
      prio();
      const st = (values.status ?? "").toLowerCase().replace(/\s+/g, "_");
      if (!st) data.status = "planning";
      else if (PROJECT_STATUS.includes(st)) data.status = st;
      else errors.push(`Status "${values.status}" must be one of ${PROJECT_STATUS.join(", ")}.`);
      const vis = (values.visibility ?? "").toLowerCase();
      if (!vis) data.visibility = "organisation";
      else if (["organisation", "team", "restricted"].includes(vis)) data.visibility = vis;
      else errors.push(`Visibility "${values.visibility}" must be organisation, team or restricted.`);
      if (values.owner_email) {
        const usr = usersByEmail.get(values.owner_email.toLowerCase());
        if (!usr || !usr.active) errors.push(`No active user with email ${values.owner_email}.`);
        else data.owner_id = usr.id;
      } else {
        data.owner_id = u.id;
        warnings.push("No owner — you will be the owner.");
      }
      const key = String(values.name).toLowerCase();
      if (values.name && (seen.has(key) || allProjectNames.has(key))) {
        duplicate = true;
        warnings.push("A project with this name already exists.");
      }
      seen.add(key);
    }
    out.push({ row: i + 2, values, data, errors, warnings, duplicate });
  });
  return { headers, suggested, mapping, fields, missingRequired, rows: out };
}

adminRouter.post(
  "/import/preview",
  h((req, res) => {
    const u = perm(req, "admin.data");
    const b = parse(zImport, req.body);
    const p = prepareImport(req.ctx.db, u, b.entity, b.csv, b.mapping);
    res.json({
      headers: p.headers,
      fields: p.fields.map((f) => ({ key: f.key, label: f.label, required: "required" in f && !!f.required })),
      suggestedMapping: p.suggested,
      mapping: p.mapping,
      missingRequired: p.missingRequired,
      summary: { total: p.rows.length, valid: p.rows.filter((r) => !r.errors.length).length, invalid: p.rows.filter((r) => r.errors.length).length, duplicates: p.rows.filter((r) => r.duplicate).length },
      rows: p.rows.slice(0, 500).map((r) => ({ row: r.row, values: r.values, errors: r.errors, warnings: r.warnings, duplicate: r.duplicate })),
    });
  }),
);

adminRouter.post(
  "/import/commit",
  h((req, res) => {
    const u = perm(req, "admin.data");
    const db = req.ctx.db;
    const b = parse(zImport.extend({ skipDuplicates: z.boolean().optional().default(true) }), req.body);
    const p = prepareImport(db, u, b.entity, b.csv, b.mapping);
    if (p.missingRequired.length) throw badRequest(`Map the required field(s): ${p.missingRequired.join(", ")}.`);
    const invalid = p.rows.filter((r) => r.errors.length);
    if (invalid.length && !b.skipInvalid) throw badRequest(`${invalid.length} row(s) have errors. Fix them or choose to skip invalid rows.`);
    const toInsert = p.rows.filter((r) => !r.errors.length && !(b.skipDuplicates && r.duplicate));
    const now = nowIso();
    const created: string[] = [];
    db.tx(() => {
      for (const r of toInsert) {
        const id = newId(b.entity === "tasks" ? "tsk" : "prj");
        if (b.entity === "tasks") {
          db.insert("tasks", {
            id, ref: safeTaskRef(db), title: r.data.title, description: r.data.description, assignee_id: r.data.assignee_id, creator_id: u.id,
            project_id: r.data.project_id, source: "import", source_ref: `CSV row ${r.row}`, priority: r.data.priority, status: r.data.status,
            due_date: r.data.due_date ?? null, tags: r.data.tags, completed_at: r.data.status === "completed" ? now : null, created_at: now, updated_at: now,
          });
        } else {
          db.insert("projects", {
            id, name: r.data.name, description: r.data.description, category: r.data.category, owner_id: r.data.owner_id, status: r.data.status,
            priority: r.data.priority, start_date: r.data.start_date ?? null, target_date: r.data.target_date ?? null, visibility: r.data.visibility,
            progress_method: getSetting(db, "projects.default_progress_method", "milestones"), created_by: u.id, created_at: now, updated_at: now,
          });
          db.insert("project_members", { project_id: id, user_id: r.data.owner_id as string, role: "owner", added_at: now });
          activity(db, u, "project.created", { type: "project", id, label: String(r.data.name) }, { projectId: id, detail: "Imported from CSV" });
        }
        created.push(id);
      }
    });
    const result = { created: created.length, skippedInvalid: invalid.length, skippedDuplicates: p.rows.filter((r) => !r.errors.length && r.duplicate && b.skipDuplicates).length, total: p.rows.length };
    audit(db, req, "data.import", { type: b.entity, id: "csv" }, result);
    res.json(result);
  }),
);

adminRouter.get(
  "/import/template/:entity.csv",
  h((req, res) => {
    perm(req, "admin.data");
    const entity = req.params.entity as ImportEntity;
    if (!IMPORT_FIELDS[entity]) throw notFound();
    const cols = IMPORT_FIELDS[entity].map((f) => f.key);
    sendCsv(res, `${entity}-import-template.csv`, toCsv([], cols));
  }),
);

/** nextTaskRef, guarded against a sequence that lags behind existing refs (e.g. seeded data). */
function safeTaskRef(db: Db): number {
  let r = nextTaskRef(db);
  const max = db.get<{ m: number | null }>("SELECT MAX(ref) m FROM tasks")!.m ?? 0;
  if (r <= max) {
    r = max + 1;
    db.run("UPDATE task_ref_seq SET next = ? WHERE id = 1", r + 1);
  }
  return r;
}

// ---------------------------------------------------------------- export (permission-aware)
type ExportDef = { columns: string[]; query: (u: AuthUser) => { sql: string; params: import("node:sqlite").SQLInputValue[] } };
const EXPORTS: Record<string, ExportDef> = {
  tasks: {
    columns: ["ref", "title", "status", "priority", "due_date", "assignee", "project", "source", "review_status", "completed_at", "tags", "created_at"],
    query: (u) => {
      const f = taskVisibleSql(u, "t");
      return {
        sql: `SELECT 'T-' || t.ref AS ref, t.title, t.status, t.priority, t.due_date, a.name AS assignee, p.name AS project, t.source, t.review_status, t.completed_at, t.tags, t.created_at
              FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN projects p ON p.id = t.project_id WHERE ${f.sql} ORDER BY t.ref`,
        params: f.params,
      };
    },
  },
  projects: {
    columns: ["code", "name", "status", "health", "priority", "owner", "programme", "category", "start_date", "target_date", "visibility", "created_at"],
    query: (u) => {
      const f = projectVisibleSql(u, "p");
      return {
        sql: `SELECT p.code, p.name, p.status, p.health, p.priority, o.name AS owner, g.name AS programme, p.category, p.start_date, p.target_date, p.visibility, p.created_at
              FROM projects p LEFT JOIN users o ON o.id = p.owner_id LEFT JOIN programmes g ON g.id = p.programme_id WHERE ${f.sql} ORDER BY p.name`,
        params: f.params,
      };
    },
  },
  meetings: {
    columns: ["meeting_date", "start_time", "title", "meeting_type", "project", "organiser", "status", "summary"],
    query: (u) => {
      const f = meetingVisibleSql(u, "m");
      return {
        sql: `SELECT m.meeting_date, m.start_time, m.title, m.meeting_type, p.name AS project, o.name AS organiser, m.status, m.summary
              FROM meetings m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN users o ON o.id = m.organiser_id WHERE ${f.sql} ORDER BY m.meeting_date DESC`,
        params: f.params,
      };
    },
  },
  knowledge: {
    columns: ["title", "item_type", "category", "status", "access_level", "author", "project", "tags", "document_url", "updated_at"],
    query: (u) => {
      const f = knowledgeVisibleSql(u, "k");
      return {
        sql: `SELECT k.title, k.item_type, k.category, k.status, k.access_level, a.name AS author, p.name AS project, k.tags, k.document_url, k.updated_at
              FROM knowledge_items k LEFT JOIN users a ON a.id = k.author_id LEFT JOIN projects p ON p.id = k.project_id WHERE ${f.sql} ORDER BY k.title`,
        params: f.params,
      };
    },
  },
  opportunities: {
    columns: ["name", "opportunity_type", "organisation", "stage", "strategic_relevance", "estimated_value", "probability", "owner", "next_action", "follow_up_date"],
    query: (u) => {
      const f = opportunityVisibleSql(u, "o");
      return {
        sql: `SELECT o.name, o.opportunity_type, o.organisation, o.stage, o.strategic_relevance, o.estimated_value, o.probability, w.name AS owner, o.next_action, o.follow_up_date
              FROM opportunities o LEFT JOIN users w ON w.id = o.owner_id WHERE ${f.sql} ORDER BY o.name`,
        params: f.params,
      };
    },
  },
  decisions: {
    columns: ["decision_date", "title", "status", "project", "decision_maker", "context", "consequences"],
    query: (u) => {
      const f = decisionVisibleSql(u, "d");
      return {
        sql: `SELECT d.decision_date, d.title, d.status, p.name AS project, m.name AS decision_maker, d.context, d.consequences
              FROM decisions d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN users m ON m.id = d.decision_maker_id WHERE ${f.sql} ORDER BY d.decision_date DESC`,
        params: f.params,
      };
    },
  },
  risks: {
    columns: ["project", "type", "title", "severity", "likelihood", "status", "owner", "identified_date", "review_date", "mitigation"],
    query: (u) => {
      const f = projectIdVisibleSql(u, "r.project_id");
      return {
        sql: `SELECT p.name AS project, r.type, r.title, r.severity, r.likelihood, r.status, o.name AS owner, r.identified_date, r.review_date, r.mitigation
              FROM risks r JOIN projects p ON p.id = r.project_id LEFT JOIN users o ON o.id = r.owner_id WHERE ${f.sql} ORDER BY p.name, r.identified_date`,
        params: f.params,
      };
    },
  },
};

adminRouter.get(
  "/exports",
  h((req, res) => {
    perm(req, "admin.data");
    res.json(Object.keys(EXPORTS));
  }),
);

adminRouter.get(
  "/export/:entity.csv",
  h((req, res) => {
    const u = perm(req, "admin.data");
    const def = EXPORTS[req.params.entity];
    if (!def) throw notFound("Unknown export.");
    const q = def.query(u);
    const rows = req.ctx.db.all<Record<string, unknown>>(q.sql, ...q.params);
    audit(req.ctx.db, req, "data.export", { type: req.params.entity, id: "csv" }, { rows: rows.length });
    sendCsv(res, `csi-${req.params.entity}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, def.columns));
  }),
);
