import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { CURRENT_TERMS_VERSION } from "../src/terms.js";

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

describe("trust proxy (rate-limit keying behind a reverse proxy)", () => {
  const DEMO_API_KEY = "demo-key";
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  const originalTrustProxyHops = process.env.TRUST_PROXY_HOPS;

  afterEach(() => {
    if (originalPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
    if (originalTrustProxyHops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = originalTrustProxyHops;
  });

  async function ratelimitRemainingPair(app: ReturnType<typeof createApp>) {
    const first = await request(app)
      .get("/leads")
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .set("X-Forwarded-For", "1.1.1.1");
    const second = await request(app)
      .get("/leads")
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .set("X-Forwarded-For", "2.2.2.2");
    return [Number(first.headers["ratelimit-remaining"]), Number(second.headers["ratelimit-remaining"])] as const;
  }

  it("by default (TRUST_PROXY_HOPS unset), ignores X-Forwarded-For — every request shares one rate-limit bucket", async () => {
    // Regression test: without `trust proxy`, req.ip is always the
    // immediate socket peer (the reverse proxy itself in the topology
    // DEPLOYMENT.md documents), so two different real clients behind that
    // one proxy would incorrectly share a single bucket. Confirmed here via
    // supertest's own loopback connection, which is a stand-in for "the
    // proxy" — two different claimed X-Forwarded-For values still consume
    // the same bucket when trust proxy isn't configured.
    delete process.env.TRUST_PROXY_HOPS;
    const [firstRemaining, secondRemaining] = await ratelimitRemainingPair(createApp());
    expect(secondRemaining).toBe(firstRemaining - 1); // same bucket, decrementing together
  });

  it("setting PUBLIC_BASE_URL alone does NOT enable trust proxy", async () => {
    // Regression test: DEPLOYMENT.md says to set PUBLIC_BASE_URL "any time
    // the app is reachable from the public internet" — including a
    // direct-exposure deployment, or one behind a CDN/load balancer that
    // passes X-Forwarded-For straight through instead of overwriting it.
    // Inferring "trust this header" from that unrelated signal would let
    // any client set their own X-Forwarded-For and get a fresh rate-limit
    // bucket on every request, bypassing the abuse protection those
    // limiters exist for — trust proxy must only ever be opted into via
    // TRUST_PROXY_HOPS itself, an explicit assertion about the real topology.
    delete process.env.TRUST_PROXY_HOPS;
    process.env.PUBLIC_BASE_URL = "https://leadrecovery.example.com";
    const [firstRemaining, secondRemaining] = await ratelimitRemainingPair(createApp());
    expect(secondRemaining).toBe(firstRemaining - 1); // still one shared bucket
  });

  it("setting TRUST_PROXY_HOPS honors X-Forwarded-For — each claimed client IP gets its own bucket", async () => {
    process.env.TRUST_PROXY_HOPS = "1";
    const [firstRemaining, secondRemaining] = await ratelimitRemainingPair(createApp());
    expect(secondRemaining).toBe(firstRemaining); // independent buckets, both fresh
  });

  it("falls back to trusting 1 hop (not silently 'trust nothing') when TRUST_PROXY_HOPS is invalid", async () => {
    // Regression test: Number("not-a-number") is NaN, and Express's `trust
    // proxy` treats a NaN hop count as "trust nothing" — the exact
    // shared-bucket bug this whole setting exists to fix, reintroduced
    // silently (no thrown error) by a typo'd env var, on a deployment that
    // already opted in. The fix validates TRUST_PROXY_HOPS and falls back
    // to the documented default (1) rather than passing NaN straight to
    // app.set(...).
    process.env.TRUST_PROXY_HOPS = "not-a-number";
    const [firstRemaining, secondRemaining] = await ratelimitRemainingPair(createApp());
    expect(secondRemaining).toBe(firstRemaining); // still independent buckets — trust proxy didn't silently disable
  });

  it("honors TRUST_PROXY_HOPS=0 as an explicit opt-out, not an invalid value promoted to 1 hop", async () => {
    // Regression test: 0 is a valid hop count (Express's own meaning: trust
    // no proxies, i.e. same as leaving trust proxy unset), which an operator
    // might set deliberately — e.g. after removing a reverse proxy — to spell
    // out "trust proxy off" rather than just deleting the var. The parsing
    // used to only accept parsed > 0 as valid, so 0 fell into the same
    // "invalid" bucket as NaN/negative and was silently promoted to 1 hop,
    // inverting the operator's explicit intent and enabling X-Forwarded-For
    // spoofing they'd opted out of.
    process.env.TRUST_PROXY_HOPS = "0";
    const [firstRemaining, secondRemaining] = await ratelimitRemainingPair(createApp());
    expect(secondRemaining).toBe(firstRemaining - 1); // shared bucket — X-Forwarded-For is NOT trusted
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
        "appointmentAt,appointmentReminderSentAt,preferredChannel,hadMissedCall,respondedAfterContact,notes"
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

describe("PATCH /leads/:id", () => {
  const DEMO_API_KEY = "demo-key";

  it("requires tenant auth", async () => {
    const res = await request(createApp()).patch("/leads/some-id").send({ notes: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for a lead that doesn't belong to this tenant", async () => {
    const res = await request(createApp())
      .patch("/leads/no-such-lead")
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .send({ notes: "x" });
    expect(res.status).toBe(404);
  });

  it("sets appointmentAt/appointmentStatus, which is what the 24h reminder keys off", async () => {
    const app = createApp();
    const leads = await request(app).get("/leads").set("Authorization", `Bearer ${DEMO_API_KEY}`);
    const leadId = leads.body[0].id;

    const res = await request(app)
      .patch(`/leads/${leadId}`)
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .send({ appointmentStatus: "booked", appointmentAt: "2026-12-01T10:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.appointmentStatus).toBe("booked");
    expect(res.body.appointmentAt).toBe("2026-12-01T10:00:00.000Z");
  });

  it("rejects an invalid appointmentAt or appointmentStatus", async () => {
    const app = createApp();
    const leads = await request(app).get("/leads").set("Authorization", `Bearer ${DEMO_API_KEY}`);
    const leadId = leads.body[0].id;

    const badDate = await request(app)
      .patch(`/leads/${leadId}`)
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .send({ appointmentAt: "not-a-date" });
    expect(badDate.status).toBe(400);

    const badStatus = await request(app)
      .patch(`/leads/${leadId}`)
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .send({ appointmentStatus: "not-a-real-status" });
    expect(badStatus.status).toBe(400);
  });

  it("clearing appointmentAt to null also clears appointmentReminderSentAt", async () => {
    const app = createApp();
    const leads = await request(app).get("/leads").set("Authorization", `Bearer ${DEMO_API_KEY}`);
    const leadId = leads.body[0].id;

    await request(app)
      .patch(`/leads/${leadId}`)
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .send({ appointmentStatus: "booked", appointmentAt: "2026-12-01T10:00:00.000Z" });

    const cleared = await request(app)
      .patch(`/leads/${leadId}`)
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .send({ appointmentAt: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.appointmentAt).toBeUndefined();
    expect(cleared.body.appointmentReminderSentAt).toBeUndefined();
  });

  it("never accepts a status change through this route (compliance-sensitive, admin/workflow-owned only)", async () => {
    const app = createApp();
    const leads = await request(app).get("/leads").set("Authorization", `Bearer ${DEMO_API_KEY}`);
    const leadId = leads.body[0].id;

    const res = await request(app)
      .patch(`/leads/${leadId}`)
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .send({ status: "opted_out", notes: "trying to sneak a status change in" });

    expect(res.status).toBe(200);
    expect(res.body.status).not.toBe("opted_out");
    expect(res.body.notes).toBe("trying to sneak a status change in"); // the field this route does own still applies
  });
});

describe("POST /leads/import", () => {
  const DEMO_API_KEY = "demo-key";

  it("requires tenant auth", async () => {
    const res = await request(createApp()).post("/leads/import").send({ csv: "phone\n+27821234567\n" });
    expect(res.status).toBe(401);
  });

  it("imports leads from CSV text and reports counts", async () => {
    const app = createApp();
    const before = await request(app).get("/leads").set("Authorization", `Bearer ${DEMO_API_KEY}`);

    const res = await request(app)
      .post("/leads/import")
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .send({
        csv:
          "name,phone,appointmentAt\n" +
          "Web Import One,+27821110001,\n" +
          "Web Import Two,+27821110002,2026-12-01T10:00:00Z\n" +
          "No Contact Info,,\n",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ imported: 2, skipped: 1 });

    const after = await request(app).get("/leads").set("Authorization", `Bearer ${DEMO_API_KEY}`);
    expect(after.body.length).toBe(before.body.length + 2);
    const imported = after.body.find((l: { name?: string }) => l.name === "Web Import Two");
    expect(imported.appointmentStatus).toBe("booked");
  });

  it("rejects a request with no csv field", async () => {
    const res = await request(createApp())
      .post("/leads/import")
      .set("Authorization", `Bearer ${DEMO_API_KEY}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /workflow/run — Terms of Service gate", () => {
  const DEMO_API_KEY = "demo-key";

  it("runs normally for the demo tenant (grandfathered — already accepted)", async () => {
    const res = await request(createApp()).post("/workflow/run").set("Authorization", `Bearer ${DEMO_API_KEY}`);
    expect(res.status).toBe(200);
  });

  it("refuses to run for a brand-new tenant that hasn't accepted the Terms of Service yet", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    try {
      const app = createApp();
      const created = await request(app)
        .post("/admin/tenants")
        .set("Authorization", "Bearer admin-secret")
        .send({ name: "Brand New Co", timezone: "UTC" });
      expect(created.status).toBe(201);
      expect(created.body.termsAcceptedAt).toBeUndefined();

      const res = await request(app).post("/workflow/run").set("Authorization", `Bearer ${created.body.apiKey}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Terms of Service/);
    } finally {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it("runs again once the tenant accepts the current terms version", async () => {
    process.env.ADMIN_API_KEY = "admin-secret";
    try {
      const app = createApp();
      const created = await request(app)
        .post("/admin/tenants")
        .set("Authorization", "Bearer admin-secret")
        .send({ name: "Brand New Co", timezone: "UTC" });

      const accepted = await request(app)
        .post("/tenants/me/accept-terms")
        .set("Authorization", `Bearer ${created.body.apiKey}`)
        .send({ version: CURRENT_TERMS_VERSION });
      expect(accepted.status).toBe(200);

      const res = await request(app).post("/workflow/run").set("Authorization", `Bearer ${created.body.apiKey}`);
      expect(res.status).toBe(200);
    } finally {
      delete process.env.ADMIN_API_KEY;
    }
  });
});
