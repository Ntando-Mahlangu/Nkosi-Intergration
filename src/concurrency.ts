/**
 * Maps `items` through `fn` with at most `limit` running concurrently —
 * used so the worker doesn't process every tenant strictly one-at-a-time
 * (where one tenant with a lot of leads would delay everyone behind it),
 * without spawning unbounded concurrent work either.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));
  return results;
}
