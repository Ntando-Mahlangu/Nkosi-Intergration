import { createHmac } from "node:crypto";
import { safeCompare } from "./security.js";

interface ParsedPaddleSignature {
  timestamp: string;
  /** Usually one value; can carry more than one during a signing-secret rotation on Paddle's side. */
  hashes: string[];
}

/** Parses Paddle's `Paddle-Signature` header: `ts=<unix_seconds>;h1=<hex_hmac>[;h1=<hex_hmac>...]`. */
function parseSignatureHeader(header: string): ParsedPaddleSignature | undefined {
  let timestamp: string | undefined;
  const hashes: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!value) continue;
    if (key === "ts") timestamp = value;
    else if (key === "h1") hashes.push(value);
  }
  return timestamp && hashes.length > 0 ? { timestamp, hashes } : undefined;
}

/**
 * Verifies a Paddle Billing webhook signature: HMAC-SHA256 of `${ts}:${rawBody}`,
 * keyed with the notification destination's signing secret (from the Paddle
 * dashboard), compared against every h1 value in the header. Requires the
 * *raw* request body — re-serializing the parsed JSON (even just reordering
 * keys) produces different bytes than what Paddle actually signed, and
 * verification fails silently. Never throws — a malformed header, an
 * unparseable timestamp, or any other malformed input just fails to verify.
 *
 * `maxAgeSeconds` bounds how old an otherwise-valid signature can be, so an
 * intercepted request/replayed webhook isn't accepted indefinitely — 300s
 * (Stripe's well-established default for the equivalent check) rather than
 * the tighter ~5s some Paddle SDK examples use, since normal delivery retry
 * delay and clock skew between this process and Paddle's can plausibly
 * exceed a few seconds without either side doing anything wrong.
 */
export function verifyPaddleSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
  maxAgeSeconds = 300
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const timestampSeconds = Number(parsed.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > maxAgeSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}:${rawBody}`).digest("hex");
  // safeCompare itself handles a length mismatch with a constant-time-ish
  // fallback (see its own doc comment) — do not add a `.length ===` short
  // circuit in front of it here, since that would skip the burn-time branch
  // entirely and reintroduce the same timing leak safeCompare exists to close.
  return parsed.hashes.some((hash) => safeCompare(hash, expected));
}

const ISO_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/**
 * Compares two Paddle `occurred_at` timestamps chronologically, returning
 * negative/zero/positive like `Array.prototype.sort`'s comparator, or
 * `undefined` if either string isn't in the UTC ISO-8601 form Paddle
 * actually sends (`YYYY-MM-DDTHH:mm:ss[.fraction]Z`) — callers should treat
 * that as "can't tell" rather than guessing.
 *
 * Deliberately does NOT go through `Date.parse`/`Date`: those only have
 * millisecond resolution, and Paddle's `occurred_at` carries microsecond
 * precision, so `Date.parse` silently truncates both timestamps to the same
 * millisecond and makes two genuinely different instants compare equal —
 * defeating the whole point of an out-of-order-delivery check. Instead, the
 * fractional-seconds parts are padded to equal length with trailing zeros
 * (safe because they're both plain digit strings once padded) and compared
 * as strings, which is exact at any precision.
 */
export function compareIsoTimestamps(a: string, b: string): number | undefined {
  const ma = ISO_TIMESTAMP_RE.exec(a);
  const mb = ISO_TIMESTAMP_RE.exec(b);
  if (!ma || !mb) return undefined;
  if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
  const fracLength = Math.max(ma[2]?.length ?? 0, mb[2]?.length ?? 0);
  const fracA = (ma[2] ?? "").padEnd(fracLength, "0");
  const fracB = (mb[2] ?? "").padEnd(fracLength, "0");
  if (fracA === fracB) return 0;
  return fracA < fracB ? -1 : 1;
}
