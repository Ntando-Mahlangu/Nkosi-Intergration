import { randomBytes, randomUUID } from "node:crypto";

export function generateId(prefix?: string): string {
  return prefix ? `${prefix}_${randomUUID()}` : randomUUID();
}

export function generateApiKey(): string {
  return `lr_${randomBytes(24).toString("hex")}`;
}

/**
 * A separate, low-privilege token for the public lead-capture form (see
 * POST /public/leads/:tenantId) — distinct from generateApiKey() because
 * it's meant to be embedded in a tenant's own public website, where an
 * actual API key would let anyone who views source read/send on that
 * tenant's behalf. Shorter than an API key is fine: it isn't a secret in
 * the same sense (it's deliberately public), just a scoping token that
 * limits what a caller who doesn't hold the real API key can do.
 */
export function generateFormKey(): string {
  return `lrf_${randomBytes(16).toString("hex")}`;
}

/**
 * A team member's own bearer credential (TenantUser.loginKey) — full
 * tenant-scoped access, same strength as generateApiKey(), just a
 * distinguishable prefix so one is recognizable from the other in logs.
 */
export function generateTenantUserKey(): string {
  return `lru_${randomBytes(24).toString("hex")}`;
}
