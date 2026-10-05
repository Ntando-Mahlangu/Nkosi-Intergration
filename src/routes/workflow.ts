import { Router, type Request, type Response } from "express";
import type { Stores } from "../store/index.js";
import { requireTenantAuth } from "../middleware/auth.js";
import { createTenantLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { runRecoveryWorkflow } from "../workflow.js";
import { withTenantWorkflowLock } from "../workflowLock.js";

/** POST /workflow/run — the same recovery workflow the worker's cron tick runs, triggerable on demand. */
export function createWorkflowRoutes({ tenantStore, tenantUserStore, leadStore, messageStore }: Stores): Router {
  const router = Router();

  // Executes the full workflow: sends via channel adapters, updates lead status, logs messages.
  // Locked per tenant (see workflowLock.ts) so this can never overlap with
  // the worker's own cron tick (or another concurrent call here) for the
  // same tenant and send the same lead's message twice.
  router.post(
    "/workflow/run",
    createTenantLimiter(),
    requireTenantAuth(tenantStore, tenantUserStore),
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = req.tenant!;
      // Unlike a suspended tenant, requireTenantAuth lets a tenant that
      // hasn't accepted the Terms of Service through (it still needs to
      // authenticate to see/accept them) — so sending has to be blocked
      // here explicitly instead of relying on auth to have already 403'd.
      if (!tenant.termsAcceptedAt) {
        res.status(403).json({ error: "this tenant must accept the Terms of Service before running the workflow" });
        return;
      }
      const result = await withTenantWorkflowLock(tenant.id, () =>
        runRecoveryWorkflow(tenant, leadStore, messageStore)
      );
      res.json(result);
    })
  );

  return router;
}
