import { randomBytes, randomUUID } from "node:crypto";

export function generateId(prefix?: string): string {
  return prefix ? `${prefix}_${randomUUID()}` : randomUUID();
}

export function generateApiKey(): string {
  return `lr_${randomBytes(24).toString("hex")}`;
}
