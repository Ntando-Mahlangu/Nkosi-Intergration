import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async Express route handler so a rejected promise reaches
 * Express's error-handling middleware via next(err) instead of becoming an
 * unhandled rejection. Express 4 (unlike 5) does not do this automatically
 * for a handler registered as `async (req, res) => {...}` — a throw inside
 * one is silently dropped as an unhandled rejection.
 *
 * That matters here specifically because installFatalErrorHandlers (see
 * fatalErrorHandlers.ts) treats every unhandled rejection as fatal and exits
 * the process — so without this wrapper, a single provider-level failure
 * (e.g. Twilio rejecting one lead's malformed phone number in
 * POST /workflow/run) would crash the entire multi-tenant server, not just
 * fail that one request.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
