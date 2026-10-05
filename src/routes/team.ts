import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import { toPublicTenantUser, type TenantUser } from "../types.js";
import { requireOwnerRole, requireTenantAuth } from "../middleware/auth.js";
import { createTenantLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { generateId, generateTenantUserKey } from "../idgen.js";
import { recordAudit } from "../audit.js";
import { sendAccountEmail } from "../authEmail.js";
import { buildResetLink, issueTenantUserPasswordResetToken } from "./auth.js";

const MAX_EMAIL_LENGTH = 320;

function isValidEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidRole(value: unknown): value is TenantUser["role"] {
  return value === "owner" || value === "member";
}

/**
 * Team accounts under a tenant — lets more than one person sign in and work
 * a tenant's leads without sharing the tenant's own email/password/apiKey
 * (see README "Team accounts", types.ts's TenantUser). Mounted alongside
 * createTenantRoutes; every route here requires tenant auth, and every
 * mutation additionally requires the "owner" role (requireOwnerRole) — a
 * "member" can see the team list (useful context in the dashboard) but not
 * invite, promote/demote, or remove anyone, including themselves.
 */
export function createTeamRoutes({ tenantStore, tenantUserStore, auditLogStore }: Stores): Router {
  const router = Router();
  const tenantAuth = requireTenantAuth(tenantStore, tenantUserStore);
  const ownerOnly = requireOwnerRole();

  router.get(
    "/tenants/me/team",
    createTenantLimiter(),
    tenantAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const members = await tenantUserStore.listTenantUsers(req.tenant!.id);
      res.json(members.map(toPublicTenantUser));
    })
  );

  router.post(
    "/tenants/me/team",
    createTenantLimiter(),
    tenantAuth,
    ownerOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = req.tenant!;
      const body = (req.body ?? {}) as { email?: unknown; role?: unknown };
      if (!isValidEmail(body.email)) {
        res
          .status(400)
          .json({ error: `email must look like a real email address, up to ${MAX_EMAIL_LENGTH} characters` });
        return;
      }
      if (body.role !== undefined && !isValidRole(body.role)) {
        res.status(400).json({ error: 'role must be "owner" or "member"' });
        return;
      }

      const trimmedEmail = body.email.trim();
      // Checked against both tables — team-member emails are a separate,
      // globally unique login namespace from tenant-owner emails (see
      // TenantUserStore's own doc comment), but a single address resolving
      // to two different accounts would make /auth/login's "look up the
      // owner table, then the team table" resolution ambiguous.
      if (await tenantStore.getTenantByEmail(trimmedEmail)) {
        res.status(409).json({ error: "that email is already in use" });
        return;
      }
      if (await tenantUserStore.getTenantUserByEmail(trimmedEmail)) {
        res.status(409).json({ error: "that email is already in use" });
        return;
      }

      const tenantUser: TenantUser = {
        id: generateId("tenantuser"),
        tenantId: tenant.id,
        email: trimmedEmail,
        loginKey: generateTenantUserKey(),
        role: body.role ?? "member",
        createdAt: new Date().toISOString(),
      };
      const created = await tenantUserStore.createTenantUser(tenantUser);

      // A SaaS-style sign-in needs a password before it's usable — same
      // pattern as POST /admin/tenants's own initial "set your password"
      // email (see that route's own comment).
      const token = await issueTenantUserPasswordResetToken(tenantUserStore, created.tenantId, created.id);
      await sendAccountEmail(
        created.email,
        `You've been added to ${tenant.name}'s LeadRecovery team`,
        `Set your password (expires in 24 hours) to sign in:\n\n${buildResetLink(token)}`
      );

      await recordAudit(auditLogStore, {
        tenantId: tenant.id,
        action: "tenant_user.invite",
        actor: req.actor ?? "owner",
        details: { invitedEmail: created.email, role: created.role },
      });

      res.status(201).json(toPublicTenantUser(created));
    })
  );

  router.patch(
    "/tenants/me/team/:id",
    createTenantLimiter(),
    tenantAuth,
    ownerOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = req.tenant!;
      const existing = await tenantUserStore.getTenantUserById(tenant.id, req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such team member" });
        return;
      }
      const body = (req.body ?? {}) as { role?: unknown };
      if (!isValidRole(body.role)) {
        res.status(400).json({ error: 'role must be "owner" or "member"' });
        return;
      }

      const updated = await tenantUserStore.updateTenantUser(tenant.id, existing.id, { role: body.role });
      await recordAudit(auditLogStore, {
        tenantId: tenant.id,
        action: "tenant_user.role_change",
        actor: req.actor ?? "owner",
        details: { memberEmail: existing.email, from: existing.role, to: body.role },
      });
      res.json(toPublicTenantUser(updated!));
    })
  );

  router.delete(
    "/tenants/me/team/:id",
    createTenantLimiter(),
    tenantAuth,
    ownerOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = req.tenant!;
      const existing = await tenantUserStore.getTenantUserById(tenant.id, req.params.id);
      if (!existing) {
        res.status(404).json({ error: "no such team member" });
        return;
      }
      await tenantUserStore.deleteTenantUser(tenant.id, existing.id);
      await recordAudit(auditLogStore, {
        tenantId: tenant.id,
        action: "tenant_user.remove",
        actor: req.actor ?? "owner",
        details: { memberEmail: existing.email },
      });
      res.status(204).send();
    })
  );

  return router;
}
