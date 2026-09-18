import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { createCorsMiddleware } from "../src/middleware/cors.js";

function buildApp() {
  const app = express();
  app.use(createCorsMiddleware());
  app.get("/thing", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS middleware", () => {
  afterEach(() => {
    delete process.env.LEADRECOVERY_CORS_ORIGIN;
  });

  it("sends no CORS headers when unset (default, same-origin only)", async () => {
    const res = await request(buildApp()).get("/thing").set("Origin", "https://evil.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reflects an allowed origin from a comma-separated list", async () => {
    process.env.LEADRECOVERY_CORS_ORIGIN = "https://app.example.com,https://admin.example.com";
    const res = await request(buildApp()).get("/thing").set("Origin", "https://admin.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://admin.example.com");
  });

  it("exposes X-Total-Count to cross-origin JS, not just same-origin", async () => {
    // Regression test: per the Fetch/CORS spec, a cross-origin caller can't
    // read a response header via JS unless it's listed in
    // Access-Control-Expose-Headers — every paginated list endpoint
    // (/leads, /leads/plan, /admin/tenants, /admin/audit-log) sets
    // X-Total-Count, and admin.html's pager depends on reading it back.
    // Without this, a cross-origin caller (the exact scenario
    // LEADRECOVERY_CORS_ORIGIN exists to support) sees it as null ->
    // Number(null) === 0, silently showing "0 of 0" instead of the real count.
    process.env.LEADRECOVERY_CORS_ORIGIN = "https://admin.example.com";
    const res = await request(buildApp()).get("/thing").set("Origin", "https://admin.example.com");
    expect(res.headers["access-control-expose-headers"]).toContain("X-Total-Count");
  });

  it("doesn't expose headers to an origin that isn't allowed", async () => {
    process.env.LEADRECOVERY_CORS_ORIGIN = "https://app.example.com";
    const res = await request(buildApp()).get("/thing").set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-expose-headers"]).toBeUndefined();
  });

  it("does not reflect an origin not on the allowed list", async () => {
    process.env.LEADRECOVERY_CORS_ORIGIN = "https://app.example.com";
    const res = await request(buildApp()).get("/thing").set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it('allows any origin when set to "*"', async () => {
    process.env.LEADRECOVERY_CORS_ORIGIN = "*";
    const res = await request(buildApp()).get("/thing").set("Origin", "https://anything.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://anything.example.com");
  });

  it("answers an OPTIONS preflight request directly", async () => {
    process.env.LEADRECOVERY_CORS_ORIGIN = "https://app.example.com";
    const res = await request(buildApp())
      .options("/thing")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "PATCH");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
  });
});
