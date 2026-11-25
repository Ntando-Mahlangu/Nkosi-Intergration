import type { NextFunction, Request, Response, RequestHandler } from "express";
import { z, ZodError, type ZodTypeAny } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const forbidden = (m = "You do not have permission to do that.") => new HttpError(403, m);
export const notFound = (m = "Not found.") => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

/** Wrap a (sync or async) handler so thrown errors reach the error middleware. */
export function h(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(next);
    } catch (e) {
      next(e);
    }
  };
}

/** Validate input with zod; throws a 400 with field-level messages. */
export function parse<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) fields[issue.path.join(".") || "_"] = issue.message;
    throw new HttpError(400, "Please check the highlighted fields.", { fields });
  }
  return r.data;
}

// Reusable field schemas
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date (YYYY-MM-DD).").refine((s) => !Number.isNaN(Date.parse(s + "T00:00:00Z")), "Use a valid date.");
export const zOptDate = z.union([zDate, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
export const zTime = z.union([z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM."), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
export const zId = z.string().min(3).max(64);
export const zOptId = z.union([zId, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
export const zText = (max = 5000) => z.string().trim().max(max);
export const zTitle = z.string().trim().min(1, "This field is required.").max(300);
export const zUrl = z.union([z.literal(""), z.string().trim().url("Use a full URL starting with https://").refine((u) => /^https?:\/\//i.test(u), "Only http(s) links are allowed.")]).optional().default("");
export const zPriority = z.enum(["low", "normal", "high", "urgent"]);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid input." });
    return;
  }
  if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.too.large") {
    res.status(413).json({ error: "The submitted content is too large." });
    return;
  }
  // Never leak internals (SQL, stack traces) to the client.
  console.error("[error]", err);
  res.status(500).json({ error: "Something went wrong on our side. The error has been logged." });
}

export function pageParams(q: Record<string, unknown>, defLimit = 50, maxLimit = 200) {
  const limit = Math.min(Math.max(parseInt(String(q.limit ?? defLimit), 10) || defLimit, 1), maxLimit);
  const offset = Math.max(parseInt(String(q.offset ?? 0), 10) || 0, 0);
  return { limit, offset };
}
