import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function loadKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must decode (base64) to exactly ${KEY_BYTES} bytes — got ${key.length}. ` +
        "Generate one with generateEncryptionKey() or `openssl rand -base64 32`."
    );
  }
  return key;
}

/** Generates a fresh random key suitable for LEADRECOVERY_ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * Encrypts a string with AES-256-GCM. Output is `iv.authTag.ciphertext`,
 * each base64-encoded, so it round-trips safely through a single text/JSONB
 * column. Used to keep tenant provider credentials (Twilio/SendGrid) out of
 * the database in cleartext.
 */
export function encryptSecret(plaintext: string, base64Key: string): string {
  const key = loadKey(base64Key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString("base64")).join(".");
}

export function decryptSecret(payload: string, base64Key: string): string {
  const key = loadKey(base64Key);
  const [ivB64, authTagB64, ciphertextB64] = payload.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("malformed encrypted payload (expected iv.authTag.ciphertext)");
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
