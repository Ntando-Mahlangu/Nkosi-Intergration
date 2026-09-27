import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import type { TenantStore } from "../store/types.js";
import { toPublicTenant } from "../types.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createAuthLimiter } from "../middleware/rateLimit.js";
import { hashPassword, verifyPassword } from "../password.js";
import { sendAccountEmail } from "../authEmail.js";
import { publicBaseUrl } from "../publicUrl.js";

const RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Exported so routes/tenants.ts's self-service change-password endpoint enforces the exact same minimum. */
export const MIN_PASSWORD_LENGTH = 8;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generates a fresh password-setup/reset token, persists only its hash +
 * expiry on the tenant (never the raw token — same principle as password
 * hashing itself), and returns the raw token for the caller to email or
 * hand back in an admin-only response. Shared by the initial "set your
 * password" email a new tenant.email gets at creation (see
 * routes/tenants.ts POST /admin/tenants) and by POST /auth/forgot-password
 * below — mechanically identical, just triggered differently.
 */
export async function issuePasswordResetToken(tenantStore: TenantStore, tenantId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await tenantStore.updateTenant(tenantId, {
    passwordResetTokenHash: hashToken(token),
    passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
  });
  return token;
}

/**
 * Builds the link a set-password/reset-password email points to. Needs
 * PUBLIC_BASE_URL to produce a working absolute URL in an email (unlike the
 * admin-facing magic link, which the browser builds client-side from its
 * own origin — see admin.html's buildMagicLink) — falls back to a bare path
 * if unset, which still works for the console-logged dev fallback
 * (src/authEmail.ts) but won't resolve on its own inside a real email.
 */
export function buildResetLink(token: string): string {
  const base = publicBaseUrl() ?? "";
  return `${base}/reset-password.html?token=${token}`;
}

export function createAuthRoutes({ tenantStore }: Stores): Router {
  const router = Router();

  router.post(
    "/auth/login",
    createAuthLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
      if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
        res.status(400).json({ error: "email and password are required" });
        return;
      }

      const tenant = await tenantStore.getTenantByEmail(email.trim());
      // Same generic error whether the email doesn't match a tenant, that
      // tenant never set a password, or the password is wrong — a
      // distinguishable response for "no such account" is exactly what lets
      // an attacker enumerate which emails have one.
      if (!tenant || !tenant.passwordHash || !(await verifyPassword(password, tenant.passwordHash))) {
        res.status(401).json({ error: "invalid email or password" });
        return;
      }
      if (tenant.status === "suspended") {
        res.status(403).json({ error: "this tenant has been suspended" });
        return;
      }

      // Resolves to the tenant's real API key rather than minting a session
      // of its own — every dashboard already knows how to store/send an API
      // key (see the magic-link flow this piggybacks on), and the rest of
      // the API only ever has to check one kind of credential.
      res.json({ apiKey: tenant.apiKey, tenant: toPublicTenant(tenant) });
    })
  );

  router.post(
    "/auth/forgot-password",
    createAuthLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const { email } = (req.body ?? {}) as { email?: unknown };
      if (typeof email !== "string" || !email.trim()) {
        res.status(400).json({ error: "email is required" });
        return;
      }

      const tenant = await tenantStore.getTenantByEmail(email.trim());
      if (tenant) {
        const token = await issuePasswordResetToken(tenantStore, tenant.id);
        await sendAccountEmail(
          tenant.email!,
          "Reset your LeadRecovery password",
          `Use this link to set a new password (expires in 24 hours):\n\n${buildResetLink(token)}\n\n` +
            "If you didn't request this, you can safely ignore this email."
        );
      }
      // Always the same response regardless of whether `tenant` was found —
      // see the login handler's own comment on the same principle.
      res.json({ ok: true, message: "If that email has an account, a reset link has been sent." });
    })
  );

  router.post(
    "/auth/reset-password",
    createAuthLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const { token, newPassword } = (req.body ?? {}) as { token?: unknown; newPassword?: unknown };
      if (typeof token !== "string" || !token) {
        res.status(400).json({ error: "token is required" });
        return;
      }
      if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` });
        return;
      }

      const tenant = await tenantStore.getTenantByPasswordResetTokenHash(hashToken(token));
      if (!tenant || !tenant.passwordResetExpiresAt || Date.parse(tenant.passwordResetExpiresAt) < Date.now()) {
        res.status(400).json({ error: "invalid or expired reset link" });
        return;
      }

      const passwordHash = await hashPassword(newPassword);
      await tenantStore.updateTenant(tenant.id, {
        passwordHash,
        passwordResetTokenHash: undefined,
        passwordResetExpiresAt: undefined,
      });
      res.json({ ok: true, apiKey: tenant.apiKey });
    })
  );

  return router;
}
