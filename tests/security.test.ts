import { describe, expect, it } from "vitest";
import { safeCompare } from "../src/security.js";
import { decryptSecret, encryptSecret, generateEncryptionKey } from "../src/crypto.js";

describe("safeCompare", () => {
  it("returns true for equal strings", () => {
    expect(safeCompare("super-secret", "super-secret")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(safeCompare("super-secret", "super-secreT")).toBe(false);
  });

  it("returns false for different-length strings without throwing", () => {
    expect(safeCompare("short", "a-lot-longer-string")).toBe(false);
  });

  it("returns false comparing against an empty string", () => {
    expect(safeCompare("", "nonempty")).toBe(false);
    expect(safeCompare("nonempty", "")).toBe(false);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    const key = generateEncryptionKey();
    const ciphertext = encryptSecret("super secret twilio token", key);
    expect(ciphertext).not.toContain("super secret twilio token");
    expect(decryptSecret(ciphertext, key)).toBe("super secret twilio token");
  });

  it("produces different ciphertext each time (random IV)", () => {
    const key = generateEncryptionKey();
    const a = encryptSecret("same plaintext", key);
    const b = encryptSecret("same plaintext", key);
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key", () => {
    const key = generateEncryptionKey();
    const wrongKey = generateEncryptionKey();
    const ciphertext = encryptSecret("secret", key);
    expect(() => decryptSecret(ciphertext, wrongKey)).toThrow();
  });

  it("rejects a key that isn't 32 bytes", () => {
    expect(() => encryptSecret("secret", Buffer.from("too-short").toString("base64"))).toThrow(/32 bytes/);
  });

  it("rejects a malformed ciphertext payload", () => {
    const key = generateEncryptionKey();
    expect(() => decryptSecret("not-a-valid-payload", key)).toThrow(/malformed/);
  });
});
