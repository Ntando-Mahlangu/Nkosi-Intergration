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
