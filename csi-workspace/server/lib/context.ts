import type { Request } from "express";
import type { Db } from "../db/index.js";
import type { Permission } from "./permissions.js";
import { forbidden, HttpError } from "./http.js";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role_key: string;
  role_name: string;
  team_id: string | null;
  job_title: string;
  permissions: Set<Permission>;
  preferences: Record<string, unknown>;
  must_change_password: boolean;
  is_demo: boolean;
}

export interface AppContext {
  db: Db;
  config: AppConfig;
}

export interface AppConfig {
  env: "development" | "production" | "test";
  publicUrl: string;
  secureCookies: boolean;
  anthropicApiKey: string;
  aiModel: string;
  google: { clientId: string; clientSecret: string; allowedDomain: string };
  demoPassword: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
    sessionId?: string;
    ctx: AppContext;
  }
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, "Please sign in.");
  return req.user;
}

export const can = (u: AuthUser, p: Permission) => u.permissions.has(p);

export function requirePerm(u: AuthUser, p: Permission) {
  if (!can(u, p)) throw forbidden();
}
