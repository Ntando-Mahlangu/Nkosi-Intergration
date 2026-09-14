import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySendGridEventSignature } from "../src/sendgridVerify.js";

function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { publicKeyBase64, privateKey };
}

function sign(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  timestamp: string,
  payload: string
): string {
  const signer = createSign("sha256");
  signer.update(timestamp + payload);
  signer.end();
  return signer.sign(privateKey).toString("base64");
}

describe("verifySendGridEventSignature", () => {
  it("accepts a genuinely signed payload", () => {
    const { publicKeyBase64, privateKey } = generateKeyPair();
    const timestamp = "1700000000";
    const payload = JSON.stringify([{ event: "delivered", leadrecovery_message_id: "msg-1" }]);
    const signature = sign(privateKey, timestamp, payload);

    expect(verifySendGridEventSignature(publicKeyBase64, payload, signature, timestamp)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const { publicKeyBase64, privateKey } = generateKeyPair();
    const timestamp = "1700000000";
    const payload = JSON.stringify([{ event: "delivered", leadrecovery_message_id: "msg-1" }]);
    const signature = sign(privateKey, timestamp, payload);

    const tamperedPayload = JSON.stringify([{ event: "delivered", leadrecovery_message_id: "msg-2" }]);
    expect(verifySendGridEventSignature(publicKeyBase64, tamperedPayload, signature, timestamp)).toBe(false);
  });

  it("rejects a tampered timestamp", () => {
    const { publicKeyBase64, privateKey } = generateKeyPair();
    const timestamp = "1700000000";
    const payload = JSON.stringify([{ event: "delivered" }]);
    const signature = sign(privateKey, timestamp, payload);

    expect(verifySendGridEventSignature(publicKeyBase64, payload, signature, "1700000001")).toBe(false);
  });

  it("rejects a signature from the wrong key", () => {
    const { privateKey } = generateKeyPair();
    const { publicKeyBase64: wrongPublicKey } = generateKeyPair();
    const timestamp = "1700000000";
    const payload = JSON.stringify([{ event: "delivered" }]);
    const signature = sign(privateKey, timestamp, payload);

    expect(verifySendGridEventSignature(wrongPublicKey, payload, signature, timestamp)).toBe(false);
  });

  it("never throws on a malformed key or signature", () => {
    expect(verifySendGridEventSignature("not-a-real-key", "payload", "not-a-signature", "123")).toBe(false);
    expect(verifySendGridEventSignature("", "", "", "")).toBe(false);
  });
});
