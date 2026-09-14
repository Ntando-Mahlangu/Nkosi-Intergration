import { timingSafeEqual } from "node:crypto";

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
