import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";

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
