import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns results in the same order as the input regardless of completion order", async () => {
    const items = [30, 10, 20];
    const result = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it("never runs more than `limit` items concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return i;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen: number[] = [];
    await mapWithConcurrency(items, 4, async (i) => {
      seen.push(i);
      return i;
    });
    expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it("propagates an error from any single item", async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(items, 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      })
    ).rejects.toThrow("boom");
  });

  it("handles an empty input", async () => {
    const result = await mapWithConcurrency([], 4, async (i: number) => i);
    expect(result).toEqual([]);
  });

  it("caps the number of concurrent workers to the item count", async () => {
    // Limit (10) larger than the item count (2) shouldn't cause any issue.
    const result = await mapWithConcurrency([1, 2], 10, async (i) => i * 2);
    expect(result).toEqual([2, 4]);
  });
});
