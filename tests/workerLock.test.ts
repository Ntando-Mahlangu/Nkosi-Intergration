import { describe, expect, it, vi } from "vitest";
import { tryAcquireWorkerLock } from "../src/workerLock.js";

function fakeClient(locked: boolean) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ locked }] }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("tryAcquireWorkerLock", () => {
  it("returns true and leaves the client open when the lock is acquired", async () => {
    const client = fakeClient(true);
    const result = await tryAcquireWorkerLock(client);
    expect(result).toBe(true);
    expect(client.end).not.toHaveBeenCalled();
  });

  it("returns false and closes the client when another process already holds the lock", async () => {
    const client = fakeClient(false);
    const result = await tryAcquireWorkerLock(client);
    expect(result).toBe(false);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("calls pg_try_advisory_lock with a fixed numeric key", async () => {
    const client = fakeClient(true);
    await tryAcquireWorkerLock(client);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("pg_try_advisory_lock"), [expect.any(Number)]);
  });
});
