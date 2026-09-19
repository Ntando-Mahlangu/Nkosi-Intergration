import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareIsoTimestamps, verifyPaddleSignature } from "../src/paddleVerify.js";

const SECRET = "pdl_ntfset_test_secret";

function sign(secret: string, timestamp: string, rawBody: string): string {
  const hash = createHmac("sha256", secret).update(`${timestamp}:${rawBody}`).digest("hex");
  return `ts=${timestamp};h1=${hash}`;
}

describe("verifyPaddleSignature", () => {
  it("accepts a genuinely signed payload with a fresh timestamp", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ event_type: "subscription.canceled", data: { id: "sub_1" } });
    const header = sign(SECRET, timestamp, rawBody);

    expect(verifyPaddleSignature(SECRET, rawBody, header)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ event_type: "subscription.canceled", data: { id: "sub_1" } });
    const header = sign(SECRET, timestamp, rawBody);

    const tampered = JSON.stringify({ event_type: "subscription.canceled", data: { id: "sub_2" } });
    expect(verifyPaddleSignature(SECRET, tampered, header)).toBe(false);
  });

  it("rejects a signature from the wrong secret", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ event_type: "subscription.canceled" });
    const header = sign("a-different-secret", timestamp, rawBody);

    expect(verifyPaddleSignature(SECRET, rawBody, header)).toBe(false);
  });

  it("rejects a signature older than maxAgeSeconds (replay protection)", () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600); // 1 hour old
    const rawBody = JSON.stringify({ event_type: "subscription.canceled" });
    const header = sign(SECRET, staleTimestamp, rawBody);

    expect(verifyPaddleSignature(SECRET, rawBody, header)).toBe(false); // default 300s window
    expect(verifyPaddleSignature(SECRET, rawBody, header, 7200)).toBe(true); // explicit wider window still works
  });

  it("accepts when any h1 value in the header matches (secret-rotation support)", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ event_type: "subscription.canceled" });
    const realHash = sign(SECRET, timestamp, rawBody).split(";")[1];
    const header = `ts=${timestamp};h1=deadbeef;${realHash}`;

    expect(verifyPaddleSignature(SECRET, rawBody, header)).toBe(true);
  });

  it("never throws on a malformed header", () => {
    const rawBody = "{}";
    expect(verifyPaddleSignature(SECRET, rawBody, "")).toBe(false);
    expect(verifyPaddleSignature(SECRET, rawBody, "garbage")).toBe(false);
    expect(verifyPaddleSignature(SECRET, rawBody, "ts=not-a-number;h1=abc")).toBe(false);
    expect(verifyPaddleSignature(SECRET, rawBody, "h1=abc")).toBe(false); // missing ts
    expect(verifyPaddleSignature(SECRET, rawBody, "ts=123")).toBe(false); // missing h1
  });
});

describe("compareIsoTimestamps", () => {
  it("orders two timestamps a millisecond apart", () => {
    expect(compareIsoTimestamps("2023-06-01T13:47:47.100Z", "2023-06-01T13:47:47.200Z")).toBeLessThan(0);
    expect(compareIsoTimestamps("2023-06-01T13:47:47.200Z", "2023-06-01T13:47:47.100Z")).toBeGreaterThan(0);
  });

  it("treats identical timestamps as equal", () => {
    expect(compareIsoTimestamps("2023-06-01T13:47:47.100Z", "2023-06-01T13:47:47.100Z")).toBe(0);
  });

  it("correctly orders a microsecond-precision timestamp against a millisecond-precision one in the same millisecond", () => {
    // The exact case Date.parse gets wrong: both truncate to .972Z at
    // millisecond resolution, but .972196Z is genuinely later.
    expect(compareIsoTimestamps("2023-06-01T13:47:47.972196Z", "2023-06-01T13:47:47.972Z")).toBeGreaterThan(0);
    expect(compareIsoTimestamps("2023-06-01T13:47:47.972Z", "2023-06-01T13:47:47.972196Z")).toBeLessThan(0);
  });

  it("handles timestamps with no fractional seconds at all", () => {
    expect(compareIsoTimestamps("2023-06-01T13:47:47Z", "2023-06-01T13:47:47.000001Z")).toBeLessThan(0);
    expect(compareIsoTimestamps("2023-06-01T13:47:47Z", "2023-06-01T13:47:47Z")).toBe(0);
  });

  it("returns undefined for a value that isn't a UTC ISO-8601 timestamp", () => {
    expect(compareIsoTimestamps("not-a-timestamp", "2023-06-01T13:47:47.100Z")).toBeUndefined();
    expect(compareIsoTimestamps("2023-06-01T13:47:47.100Z", "2023-06-01T13:47:47+02:00")).toBeUndefined();
    expect(compareIsoTimestamps("", "")).toBeUndefined();
  });
});
