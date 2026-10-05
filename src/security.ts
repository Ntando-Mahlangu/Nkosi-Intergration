import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (admin key, webhook shared
 * tokens). A plain `===` leaks timing information proportional to how many
 * leading characters match, which is enough to brute-force a secret given
 * many attempts — this is why every secret comparison in this codebase goes
 * through here instead.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on mismatched lengths; comparing against a
  // same-length buffer first keeps the whole check constant-time-ish
  // without leaking length via an early return on a length check alone.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // burn equivalent time to a real compare
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * One-way hash for a short-lived bearer token (an OTP code, a password-reset
 * token, a chat-widget session token) before storing it — the raw token is
 * never persisted, only this hash, the same way a password is never stored
 * in plaintext. Not a password hash (no per-value salt/cost): these tokens
 * are already high-entropy random values, not user-chosen secrets, so a fast
 * hash is the right tradeoff — verifying it on every request stays cheap.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
