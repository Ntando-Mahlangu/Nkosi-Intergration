/**
 * Test harness: fresh in-memory database with bootstrap defaults + demo seed,
 * and logged-in supertest agents per demo user.
 *
 *   const t = await setup();
 *   const lerato = await t.as("lerato");          // supertest agent with session + CSRF header
 *   await lerato.get("/api/workspace/summary").expect(200);
 *   t.db.get("SELECT ...")                         // direct DB assertions
 */
import request from "supertest";
import { openDb } from "../server/db/index.js";
import { bootstrap } from "../server/db/bootstrap.js";
import { seedDemo } from "../server/db/seed.js";
import { createApp, loadConfig } from "../server/app.js";

export const DEMO_PASSWORD = "Test-password-123";
export type DemoUser = "naledi" | "sipho" | "ayesha" | "thabo" | "lerato" | "pieter" | "zanele" | "grace";

export interface Agent {
  get: (url: string) => request.Test;
  post: (url: string, body?: object) => request.Test;
  patch: (url: string, body?: object) => request.Test;
  put: (url: string, body?: object) => request.Test;
  del: (url: string) => request.Test;
}

export async function setup(opts: { seed?: boolean; env?: Record<string, string> } = {}) {
  const db = openDb(":memory:");
  bootstrap(db);
  if (opts.seed !== false) seedDemo(db, DEMO_PASSWORD);
  const config = loadConfig({ NODE_ENV: "test", ...(opts.env ?? {}) });
  const app = createApp(db, config);

  const userId = (u: DemoUser) => db.get<{ id: string }>("SELECT id FROM users WHERE email = ?", `${u}@demo.csi.example`)!.id;

  async function as(u: DemoUser): Promise<Agent> {
    const agent = request.agent(app);
    await agent.post("/auth/login").set("x-csi-request", "1").send({ email: `${u}@demo.csi.example`, password: DEMO_PASSWORD }).expect(200);
    return {
      get: (url) => agent.get(url),
      post: (url, body = {}) => agent.post(url).set("x-csi-request", "1").send(body),
      patch: (url, body = {}) => agent.patch(url).set("x-csi-request", "1").send(body),
      put: (url, body = {}) => agent.put(url).set("x-csi-request", "1").send(body),
      del: (url) => agent.delete(url).set("x-csi-request", "1"),
    };
  }
  return { db, app, config, as, userId, anon: () => request(app) };
}
