import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

/**
 * One-way password hashing via scrypt (Node's built-in, no extra
 * dependency — consistent with src/crypto.ts already using node:crypto
 * rather than pulling in bcrypt/argon2 for the one place this project
 * needs password hashing). Output is `salt.hash`, both hex, so it
 * round-trips through a single text column like src/crypto.ts's own
 * `iv.authTag.ciphertext` encoding.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(plain, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}.${derived.toString("hex")}`;
}

/** Constant-time verification against a hash produced by hashPassword. Never throws on a malformed stored hash — treats it as a mismatch. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(".");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== KEY_LENGTH) return false;
  const derived = (await scrypt(plain, salt, KEY_LENGTH)) as Buffer;
  return timingSafeEqual(derived, expected);
}
