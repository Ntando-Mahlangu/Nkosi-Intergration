import express from "express";
import request from "supertest";
import rateLimit, { type Store } from "express-rate-limit";
import { describe, expect, it } from "vitest";

/**
 * Exercises the exact `passOnStoreError` choice createWebhookLimiter makes
 * (see src/middleware/rateLimit.ts's own comment on why) against a store
 * that always throws, standing in for a transient Postgres error from
 * PgRateLimitStore. Built directly with express-rate-limit's own `rateLimit()`
 * rather than through createWebhookLimiter itself, since that factory picks
 * its store based on DATABASE_URL/getPool() — not something a unit test can
 * safely fake without a real (or connection-faking) Postgres pool. What's
 * actually under test is the option, not which factory sets it.
 */
class AlwaysThrowsStore implements Store {
  init() {}
  async increment(): Promise<never> {
    throw new Error("simulated transient Postgres error");
  }
  async decrement() {}
  async resetKey() {}
}

function buildApp(passOnStoreError: boolean) {
  const app = express();
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
      store: new AlwaysThrowsStore(),
      passOnStoreError,
    })
  );
  app.post("/webhooks/twilio/sms", (_req, res) => res.status(200).send("<Response/>"));
  return app;
}

describe("webhook rate limiter's passOnStoreError choice", () => {
  it("without passOnStoreError, a store error 500s the request — would block every inbound webhook at once", async () => {
    const res = await request(buildApp(false)).post("/webhooks/twilio/sms");
    expect(res.status).toBe(500);
  });

  it("with passOnStoreError (our actual config), a store error still lets the request through", async () => {
    const res = await request(buildApp(true)).post("/webhooks/twilio/sms");
    expect(res.status).toBe(200);
  });
});
