import { createPublicKey, createVerify } from "node:crypto";

/**
 * Verifies a SendGrid Event Webhook signature (ECDSA P-256/SHA-256), per
 * SendGrid's "Signed Event Webhook" feature. `publicKeyBase64` is the
 * base64 DER (SPKI) key SendGrid shows when you enable that setting.
 * Never throws — a malformed key/signature/timestamp just fails to verify.
 */
export function verifySendGridEventSignature(
  publicKeyBase64: string,
  payload: string,
  signatureBase64: string,
  timestamp: string
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const verifier = createVerify("sha256");
    verifier.update(timestamp + payload);
    verifier.end();
    return verifier.verify(publicKey, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
