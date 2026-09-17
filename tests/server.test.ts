import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("GET /health and /ready", () => {
  it("/health is a pure liveness check — always 200", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("/ready reports database as not configured in demo mode (no DATABASE_URL)", async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    const res = await request(createApp()).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, database: "not configured" });
  });
});

describe("X-API-Version header", () => {
  it("is set on every response to the exact package.json version", async () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")) as { version: string };
    const res = await request(createApp()).get("/health");
    expect(res.headers["x-api-version"]).toBe(pkg.version);
  });
});

describe("GET /leads/export", () => {
  const DEMO_API_KEY = "demo-key"; // src/demoTenant.ts — the fixed demo tenant this app boots with when DATABASE_URL is unset

  it("requires tenant auth", async () => {
    const res = await request(createApp()).get("/leads/export");
    expect(res.status).toBe(401);
  });

  it("defaults to a CSV attachment with a header row and one row per lead", async () => {
    const app = createApp();
    const leads = await request(app).get("/leads").set("Authorization", `Bearer ${DEMO_API_KEY}`);

    const res = await request(app).get("/leads/export").set("Authorization", `Bearer ${DEMO_API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain('attachment; filename="leads-export.csv"');
    const lines = res.text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "id,name,phone,email,source,status,createdAt,firstOutreachSentAt,lastContactedAt,followUpCount," +
        "nextFollowUpAt,requestedService,previousQuote,previousConversationSummary,appointmentStatus," +
        "preferredChannel,hadMissedCall,respondedAfterContact,notes"
    );
    expect(lines).toHaveLength(1 + leads.body.length); // header + one row per lead
  });

  it("returns the full lead objects as a JSON attachment when ?format=json", async () => {
    const app = createApp();
    const leads = await request(app).get("/leads").set("Authorization", `Bearer ${DEMO_API_KEY}`);

    const res = await request(app)
      .get("/leads/export")
      .query({ format: "json" })
      .set("Authorization", `Bearer ${DEMO_API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain('attachment; filename="leads-export.json"');
    expect(res.body).toHaveLength(leads.body.length);
    expect(res.body.map((l: { id: string }) => l.id).sort()).toEqual(
      leads.body.map((l: { id: string }) => l.id).sort()
    );
  });
});
