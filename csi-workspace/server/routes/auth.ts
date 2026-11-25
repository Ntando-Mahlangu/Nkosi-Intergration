import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { h, parse, HttpError, badRequest } from "../lib/http.js";
import {
  clearThrottle,
  createSession,
  destroySession,
  hashPassword,
  loginThrottle,
  passwordProblems,
  sessionToken,
  setSessionCookie,
  SESSION_COOKIE,
  verifyPassword,
} from "../lib/auth.js";
import { audit, getSetting } from "../lib/events.js";
import { currentUser } from "../lib/context.js";
import { nowIso } from "../lib/ids.js";
import { googleAuthUrl, googleConfigured, googleExchange } from "../integrations/google.js";

export const authRouter = Router();

authRouter.get(
  "/config",
  h((req, res) => {
    const db = req.ctx.db;
    res.json({
      orgName: getSetting(db, "org.name", "Change Science Institute"),
      googleSignIn: googleConfigured(req.ctx.config),
      demoMode: !!db.get("SELECT 1 FROM users WHERE is_demo = 1 LIMIT 1"),
      demoAccounts:
        req.ctx.config.env !== "production" && db.get("SELECT 1 FROM users WHERE is_demo = 1 LIMIT 1")
          ? db.all("SELECT u.email, u.name, r.name AS role FROM users u JOIN roles r ON r.key = u.role_key WHERE u.is_demo = 1 AND u.active = 1 ORDER BY r.sort_order, u.name")
          : [],
    });
  }),
);

authRouter.post(
  "/login",
  h((req, res) => {
    const db = req.ctx.db;
    const body = parse(z.object({ email: z.string().trim().email("Enter a valid email."), password: z.string().min(1, "Enter your password.").max(200) }), req.body);
    const key = `${req.ip}|${body.email.toLowerCase()}`;
    if (!loginThrottle(key)) throw new HttpError(429, "Too many sign-in attempts. Please wait 15 minutes and try again.");
    const u = db.get<{ id: string; email: string; password_hash: string | null; active: number }>("SELECT id, email, password_hash, active FROM users WHERE email = ?", body.email);
    if (!u || !u.active || !verifyPassword(body.password, u.password_hash)) {
      audit(db, req, "auth.login_failed", null, { email: body.email }, { id: u?.id ?? null, email: body.email });
      throw new HttpError(401, "That email and password combination is not recognised.");
    }
    clearThrottle(key);
    const token = createSession(db, u.id, req);
    setSessionCookie(res, token, req.ctx.config.secureCookies);
    audit(db, req, "auth.login", { type: "user", id: u.id }, { method: "password" }, { id: u.id, email: u.email });
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/logout",
  h((req, res) => {
    destroySession(req.ctx.db, sessionToken(req));
    if (req.user) audit(req.ctx.db, req, "auth.logout", { type: "user", id: req.user.id });
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/change-password",
  h((req, res) => {
    const u = currentUser(req);
    const db = req.ctx.db;
    const body = parse(z.object({ currentPassword: z.string().max(200).optional().default(""), newPassword: z.string().max(200) }), req.body);
    const row = db.get<{ password_hash: string | null; must_change_password: number }>("SELECT password_hash, must_change_password FROM users WHERE id = ?", u.id)!;
    if (row.password_hash && !verifyPassword(body.currentPassword, row.password_hash)) throw badRequest("Your current password is incorrect.", { fields: { currentPassword: "Incorrect password." } });
    const problem = passwordProblems(body.newPassword);
    if (problem) throw badRequest(problem, { fields: { newPassword: problem } });
    db.run("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?", hashPassword(body.newPassword), nowIso(), u.id);
    // Invalidate other sessions.
    db.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", u.id, req.sessionId ?? "");
    audit(db, req, "auth.password_changed", { type: "user", id: u.id });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- Google Workspace sign-in (OIDC)
authRouter.get(
  "/google",
  h((req, res) => {
    if (!googleConfigured(req.ctx.config)) throw new HttpError(404, "Google sign-in is not configured.");
    const state = crypto.randomBytes(16).toString("base64url");
    res.cookie("csi_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: req.ctx.config.secureCookies, maxAge: 600000, path: "/auth" });
    res.redirect(googleAuthUrl(req.ctx.config, state));
  }),
);

authRouter.get(
  "/google/callback",
  h(async (req, res) => {
    const db = req.ctx.db;
    const cfg = req.ctx.config;
    if (!googleConfigured(cfg)) throw new HttpError(404, "Google sign-in is not configured.");
    const cookieState = (req.headers.cookie ?? "").split(";").map((s) => s.trim()).find((s) => s.startsWith("csi_oauth_state="))?.split("=")[1];
    if (!req.query.state || req.query.state !== cookieState) return res.redirect("/login?error=state");
    const code = String(req.query.code ?? "");
    if (!code) return res.redirect("/login?error=denied");
    let profile: { email: string; name: string; hd?: string };
    try {
      profile = await googleExchange(cfg, code);
    } catch (e) {
      console.error("[google] exchange failed", e);
      return res.redirect("/login?error=google");
    }
    if (cfg.google.allowedDomain && profile.hd !== cfg.google.allowedDomain) {
      audit(db, req, "auth.login_failed", null, { email: profile.email, reason: "domain" }, { id: null, email: profile.email });
      return res.redirect("/login?error=domain");
    }
    // Accounts are provisioned by administrators — Google sign-in never self-creates users.
    const u = db.get<{ id: string; active: number }>("SELECT id, active FROM users WHERE email = ?", profile.email);
    if (!u || !u.active) {
      audit(db, req, "auth.login_failed", null, { email: profile.email, reason: "not_provisioned" }, { id: null, email: profile.email });
      return res.redirect("/login?error=not_provisioned");
    }
    const token = createSession(db, u.id, req);
    setSessionCookie(res, token, cfg.secureCookies);
    audit(db, req, "auth.login", { type: "user", id: u.id }, { method: "google" }, { id: u.id, email: profile.email });
    res.redirect("/");
  }),
);
