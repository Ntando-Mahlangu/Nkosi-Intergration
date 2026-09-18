import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDbLock, withTenantWorkflowLock } from "../src/workflowLock.js";
import { InMemoryLeadStore, InMemoryMessageStore } from "../src/store/memory.js";
import { runRecoveryWorkflow } from "../src/workflow.js";
import type { Lead, Tenant } from "../src/types.js";

function fakeConnection() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
}

describe("withTenantWorkflowLock (in-process serialization, no DATABASE_URL)", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("never runs two calls for the same tenant concurrently", async () => {
    let active = 0;
    let overlapped = false;

    const run = () =>
      withTenantWorkflowLock("tenant-a", async () => {
        active++;
        if (active > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
      });

    await Promise.all([run(), run(), run()]);
    expect(overlapped).toBe(false);
  });

  it("does not serialize calls for different tenants against each other", async () => {
    let active = 0;
    let maxActive = 0;

    const run = (tenantId: string) =>
      withTenantWorkflowLock(tenantId, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
      });

    await Promise.all([run("tenant-a"), run("tenant-b"), run("tenant-c")]);
    expect(maxActive).toBeGreaterThan(1);
  });

  it("propagates the wrapped function's resolved value", async () => {
    await expect(withTenantWorkflowLock("tenant-b2", async () => 42)).resolves.toBe(42);
  });

  it("a failed call doesn't block or poison the next call for the same tenant", async () => {
    await expect(
      withTenantWorkflowLock("tenant-fail", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(withTenantWorkflowLock("tenant-fail", async () => "ok")).resolves.toBe("ok");
  });
});

describe("withDbLock (Postgres advisory lock, against a fake connection)", () => {
  it("acquires a per-tenant advisory lock, runs the function, then unlocks and releases the connection", async () => {
    const connection = fakeConnection();
    const result = await withDbLock(
      "tenant-x",
      async () => "done",
      () => Promise.resolve(connection)
    );

    expect(result).toBe("done");
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("pg_advisory_lock"),
      expect.arrayContaining([expect.stringContaining("tenant-x")])
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("pg_advisory_unlock"),
      expect.arrayContaining([expect.stringContaining("tenant-x")])
    );
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it("still unlocks and releases the connection when the wrapped function throws", async () => {
    const connection = fakeConnection();
    await expect(
      withDbLock(
        "tenant-y",
        async () => {
          throw new Error("boom");
        },
        () => Promise.resolve(connection)
      )
    ).rejects.toThrow("boom");

    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("pg_advisory_unlock"),
      expect.anything()
    );
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it("surfaces the wrapped function's own error, not a masking error from a failed unlock", async () => {
    // Regression test: a throw inside a `finally` block replaces whatever
    // exception was already propagating — so if pg_advisory_unlock itself
    // fails (e.g. during the same DB outage that likely broke fn()), an
    // unguarded `await connection.query(unlock...)` in that finally would
    // hide fn()'s real error behind an unrelated "unlock failed" one.
    const connection = fakeConnection();
    connection.query.mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("pg_advisory_unlock")) {
        return Promise.reject(new Error("connection lost during unlock"));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      withDbLock(
        "tenant-z",
        async () => {
          throw new Error("the real failure");
        },
        () => Promise.resolve(connection)
      )
    ).rejects.toThrow("the real failure");
    expect(connection.release).toHaveBeenCalledTimes(1); // still cleaned up despite the failed unlock
  });
});

describe("runRecoveryWorkflow race between two concurrent calls for the same tenant", () => {
  const NOW = new Date("2026-09-12T00:00:00.000Z");
  const TENANT: Tenant = {
    id: "race-tenant",
    name: "Race Co",
    apiKey: "test-key",
    timezone: "UTC",
    devMode: true,
    quietHours: { startHour: 0, endHour: 0 },
    channels: {},
    createdAt: NOW.toISOString(),
  };
  const LEAD: Lead = {
    id: "race-lead",
    tenantId: TENANT.id,
    name: "Race Lead",
    phone: "+27821111111",
    source: "missed_call",
    createdAt: NOW.toISOString(),
    hadMissedCall: true,
    status: "new",
  };

  it("without the lock, a manual trigger racing another run for the same tenant sends the same lead's message twice", async () => {
    // Regression test for the underlying bug: buildRecoveryPlans reads the
    // lead's status at the top of runRecoveryWorkflow (await
    // store.getAllLeads), before anything is sent — two calls started
    // together both see "new" and both go on to actually call safeSend
    // (workflow.ts's sendPlans), before either has written back. The
    // updateLead(..., { onlyIfStatusIn }) guard only protects the *store
    // write* from the second call; it does nothing about the send that
    // already went out.
    const store = new InMemoryLeadStore([{ ...LEAD }]);
    const messages = new InMemoryMessageStore();

    const [resultA, resultB] = await Promise.all([
      runRecoveryWorkflow(TENANT, store, messages, NOW),
      runRecoveryWorkflow(TENANT, store, messages, NOW),
    ]);

    const sentForLead = [...resultA.sent, ...resultB.sent].filter((s) => s.plan.lead.id === LEAD.id && s.result.ok);
    expect(sentForLead).toHaveLength(2); // the bug: sent twice
  });

  it("with the lock, the same race sends the lead's message exactly once", async () => {
    const store = new InMemoryLeadStore([{ ...LEAD }]);
    const messages = new InMemoryMessageStore();

    const [resultA, resultB] = await Promise.all([
      withTenantWorkflowLock(TENANT.id, () => runRecoveryWorkflow(TENANT, store, messages, NOW)),
      withTenantWorkflowLock(TENANT.id, () => runRecoveryWorkflow(TENANT, store, messages, NOW)),
    ]);

    const sentForLead = [...resultA.sent, ...resultB.sent].filter((s) => s.plan.lead.id === LEAD.id && s.result.ok);
    expect(sentForLead).toHaveLength(1);

    const updated = await store.getLeadById(TENANT.id, LEAD.id);
    expect(updated?.status).toBe("contacted_no_response");
  });
});
