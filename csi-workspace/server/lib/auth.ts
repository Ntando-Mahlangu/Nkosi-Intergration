import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/index.js";
import type { AuthUser } from "./context.js";
import type { Permission } from "./permissions.js";
import { nowIso } from "./ids.js";
import { HttpError } from "./http.js";

export const SESSION_COOKIE = "csi_session";
const SESSION_DAYS = 7;
const IDLE_HOURS = 12;

// ---------------------------------------------------------------- passwords (scrypt)
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = crypto.scryptSync(pw, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}
export function passwordProblems(pw: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Use a mix of letters and numbers.";
  return null;
}

// ---------------------------------------------------------------- sessions
const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export function createSession(db: Db, userId: string, req: Request): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  db.insert("sessions", {
    id: hashToken(token),
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString(),
    last_seen_at: now.toISOString(),
    user_agent: String(req.headers["user-agent"] ?? "").slice(0, 300),
    ip: req.ip ?? "",
  });
  db.run("UPDATE users SET last_login_at = ? WHERE id = ?", now.toISOString(), userId);
  return token;
}

export function setSessionCookie(res: Response, token: string, secure: boolean) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_DAYS * 86400000,
  });
}

export function destroySession(db: Db, token: string | undefined) {
  if (token) db.run("DELETE FROM sessions WHERE id = ?", hashToken(token));
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
export const sessionToken = (req: Request) => readCookie(req, SESSION_COOKIE);

export function loadUser(db: Db, userId: string): AuthUser | null {
  const r = db.get<Record<string, unknown>>(
    `SELECT u.*, r.name AS role_name, r.permissions AS role_permissions FROM users u JOIN roles r ON r.key = u.role_key WHERE u.id = ? AND u.active = 1`,
    userId,
  );
  if (!r) return null;
  let perms: Permission[] = [];
  let prefs: Record<string, unknown> = {};
  try {
    perms = JSON.parse(String(r.role_permissions));
  } catch {
    /* empty */
  }
  try {
    prefs = JSON.parse(String(r.preferences || "{}"));
  } catch {
    /* empty */
  }
  return {
    id: String(r.id),
    name: String(r.name),
    email: String(r.email),
    role_key: String(r.role_key),
    role_name: String(r.role_name),
    team_id: (r.team_id as string) ?? null,
    job_title: String(r.job_title ?? ""),
    permissions: new Set(perms),
    preferences: prefs,
    must_change_password: !!r.must_change_password,
    is_demo: !!r.is_demo,
  };
}

/** Attach req.user when a valid session cookie is present. Does not reject. */
export function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  const token = sessionToken(req);
  if (token) {
    const db = req.ctx.db;
    const id = hashToken(token);
    const s = db.get<{ user_id: string; expires_at: string; last_seen_at: string }>("SELECT user_id, expires_at, last_seen_at FROM sessions WHERE id = ?", id);
    const now = Date.now();
    if (s && Date.parse(s.expires_at) > now && now - Date.parse(s.last_seen_at) < IDLE_HOURS * 3600000) {
      const user = loadUser(db, s.user_id);
      if (user) {
        req.user = user;
        req.sessionId = id;
        // Touch at most once per minute to avoid a write on every request.
        if (now - Date.parse(s.last_seen_at) > 60000) db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", nowIso(), id);
      }
    } else if (s) {
      db.run("DELETE FROM sessions WHERE id = ?", id);
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, "Please sign in."));
  next();
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests: require a
 * custom header (cannot be set cross-site without a CORS preflight, which we
 * never grant) in addition to SameSite=Lax cookies.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.headers["x-csi-request"] !== "1") return next(new HttpError(403, "Request blocked (missing CSRF header)."));
  next();
}

// ---------------------------------------------------------------- login throttling (in-memory)
const attempts = new Map<string, { count: number; first: number }>();
export function loginThrottle(key: string): boolean {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now - a.first > 15 * 60000) {
    attempts.set(key, { count: 1, first: now });
    return true;
  }
  a.count++;
  return a.count <= 10;
}
export function clearThrottle(key: string) {
  attempts.delete(key);
}
