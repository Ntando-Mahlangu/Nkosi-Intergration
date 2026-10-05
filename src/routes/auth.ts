import { randomBytes, randomInt } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import type { TenantStore } from "../store/types.js";
import { toPublicTenant } from "../types.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createAuthLimiter } from "../middleware/rateLimit.js";
import { hashPassword, verifyPassword } from "../password.js";
import { sendAccountEmail } from "../authEmail.js";
import { sendAccountSms } from "../authSms.js";
import { publicBaseUrl } from "../publicUrl.js";
import { hashToken } from "../security.js";

const RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Exported so routes/tenants.ts's self-service change-password endpoint enforces the exact same minimum. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Deliberately short compared to RESET_TOKEN_TTL_MS — a 6-digit code is
 * meant to be read off a text message and entered within a couple of
 * minutes, not saved for later the way a password-reset link might be.
 */
const OTP_TTL_MS = 10 * 60 * 1000;
/** Failed verify-code attempts allowed before a fresh code must be requested — see Tenant.otpAttempts. */
const MAX_OTP_ATTEMPTS = 5;
/** Same generic response for "no such phone", "code expired", "too many attempts", and "wrong code" — a distinguishable response for any one of these is exactly what lets an attacker enumerate valid phone numbers or brute-force a code. */
const INVALID_CODE_ERROR = "invalid or expired code";

function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
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

  // Phone-number sign-in, step 1: texts a one-time code to a tenant's
  // loginPhone. A client never sets or remembers a password for this path —
  // the phone itself, freshly verified on every sign-in, is the credential.
  router.post(
    "/auth/request-code",
    createAuthLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const { phone } = (req.body ?? {}) as { phone?: unknown };
      if (typeof phone !== "string" || !phone.trim()) {
        res.status(400).json({ error: "phone is required" });
        return;
      }

      const tenant = await tenantStore.getTenantByLoginPhone(phone.trim());
      if (tenant) {
        const code = generateOtpCode();
        await tenantStore.updateTenant(tenant.id, {
          otpCodeHash: hashToken(code),
          otpExpiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
          otpAttempts: 0,
        });
        await sendAccountSms(
          tenant.loginPhone!,
          `Your LeadRecovery sign-in code is ${code}. It expires in 10 minutes.`
        );
      }
      // Always the same response regardless of whether `tenant` was found —
      // see /auth/forgot-password's own comment on the same principle. The
      // raw code is never returned here even when SMS isn't configured
      // (unlike the password-setup link, which an admin is trusted to relay
      // manually) — this endpoint takes only a phone number, so echoing the
      // code back would let anyone with a phone number log in as that tenant.
      res.json({ ok: true, message: "If that phone number has an account, a code has been sent." });
    })
  );

  // Phone-number sign-in, step 2: verifies the code and resolves to the
  // tenant's real API key, same pattern as /auth/login.
  router.post(
    "/auth/verify-code",
    createAuthLimiter(),
    asyncHandler(async (req: Request, res: Response) => {
      const { phone, code } = (req.body ?? {}) as { phone?: unknown; code?: unknown };
      if (typeof phone !== "string" || !phone.trim() || typeof code !== "string" || !code.trim()) {
        res.status(400).json({ error: "phone and code are required" });
        return;
      }

      const tenant = await tenantStore.getTenantByLoginPhone(phone.trim());
      if (
        !tenant ||
        !tenant.otpCodeHash ||
        !tenant.otpExpiresAt ||
        Date.parse(tenant.otpExpiresAt) < Date.now() ||
        (tenant.otpAttempts ?? 0) >= MAX_OTP_ATTEMPTS
      ) {
        res.status(401).json({ error: INVALID_CODE_ERROR });
        return;
      }
      if (hashToken(code.trim()) !== tenant.otpCodeHash) {
        await tenantStore.updateTenant(tenant.id, { otpAttempts: (tenant.otpAttempts ?? 0) + 1 });
        res.status(401).json({ error: INVALID_CODE_ERROR });
        return;
      }

      // Single-use: clears the code so it can't be replayed, the same
      // principle as a password-reset token. Done as soon as the code is
      // confirmed correct — before the suspended check below — so a
      // correct code is consumed exactly once regardless of outcome,
      // rather than staying valid and reusable for the rest of its TTL
      // whenever the tenant happens to be suspended.
      await tenantStore.updateTenant(tenant.id, {
        otpCodeHash: undefined,
        otpExpiresAt: undefined,
        otpAttempts: 0,
      });
      if (tenant.status === "suspended") {
        res.status(403).json({ error: "this tenant has been suspended" });
        return;
      }
      res.json({ apiKey: tenant.apiKey, tenant: toPublicTenant(tenant) });
    })
  );

  return router;
}
