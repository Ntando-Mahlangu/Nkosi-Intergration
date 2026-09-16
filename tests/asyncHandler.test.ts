import { describe, expect, it, afterEach } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { asyncHandler } from "../src/middleware/asyncHandler.js";

/**
 * Regression test for a real production-crashing bug: Express 4 does not
 * forward a rejected promise from an `async (req, res) => {...}` handler to
 * error-handling middleware on its own — it becomes an unhandled rejection.
 * Combined with installFatalErrorHandlers (which treats any unhandled
 * rejection as fatal and calls process.exit(1)), a single failing request
 * anywhere in the app — e.g. Twilio rejecting one lead's malformed phone
 * number in POST /workflow/run — used to crash the entire multi-tenant
 * server. asyncHandler forwards the rejection to next(err) instead.
 */
describe("asyncHandler", () => {
  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
  });

  function buildApp() {
    const app = express();
    app.get(
      "/boom",
      asyncHandler(async () => {
        throw new Error("provider exploded");
      })
    );
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: (err as Error).message });
    });
    return app;
  }

  it("forwards a rejected handler to error middleware instead of crashing the process", async () => {
    let unhandled: unknown;
    process.once("unhandledRejection", (reason) => {
      unhandled = reason;
    });

    const res = await request(buildApp()).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "provider exploded" });
    // The whole point: no unhandled rejection escaped to the process level
    // (which installFatalErrorHandlers would treat as fatal in production).
    expect(unhandled).toBeUndefined();
  });

  it("does not interfere with a handler that resolves normally", async () => {
    const app = express();
    app.get(
      "/ok",
      asyncHandler(async (_req, res) => {
        res.json({ ok: true });
      })
    );

    const res = await request(app).get("/ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
