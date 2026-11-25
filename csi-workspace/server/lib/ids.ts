import crypto from "node:crypto";

/** Prefixed, URL-safe, non-guessable identifiers (e.g. tsk_3f9a1c2b7d4e). */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

export const nowIso = () => new Date().toISOString();

/** Today's calendar date (YYYY-MM-DD) in an IANA timezone. */
export function todayIn(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
