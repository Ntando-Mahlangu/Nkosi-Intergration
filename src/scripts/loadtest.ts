function parseArgs(argv: string[]): { url: string; key: string; concurrency: number; durationSec: number } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return {
    url: (out.url ?? "http://localhost:3000").replace(/\/$/, ""),
    key: out.key ?? "demo-key",
    concurrency: Number(out.concurrency ?? 10),
    durationSec: Number(out.duration ?? 10),
  };
}

interface RequestResult {
  path: string;
  status: number;
  ms: number;
  ok: boolean;
}

// Deliberately read-only: this hits GET routes only. Never include
// POST /workflow/run here — a load test that actually sends real
// SMS/WhatsApp/email to a real tenant's leads is not a load test, it's an
// incident. Point this at the bundled demo tenant unless you know exactly
// which real tenant's traffic budget you're spending.
const ENDPOINTS = ["/health", "/leads", "/leads/plan"];

async function fireOne(baseUrl: string, key: string): Promise<RequestResult> {
  const path = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
  const start = performance.now();
  try {
    const res = await fetch(baseUrl + path, {
      headers: path === "/health" ? {} : { Authorization: `Bearer ${key}` },
    });
    return { path, status: res.status, ms: performance.now() - start, ok: res.ok };
  } catch {
    return { path, status: 0, ms: performance.now() - start, ok: false };
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * A baseline load-test tool, not a full performance-testing suite: fires
 * concurrent GET requests at a handful of read-only endpoints for a fixed
 * duration and reports throughput/latency percentiles. Useful as a sanity
 * check before/after a change that might affect performance (a new
 * migration's indexes, a Postgres pool size change, moving to a smaller
 * instance), not as a substitute for real production traffic modeling.
 */
async function main() {
  const { url, key, concurrency, durationSec } = parseArgs(process.argv.slice(2));
  console.log(
    `Load-testing ${url} (concurrency=${concurrency}, duration=${durationSec}s, endpoints=${ENDPOINTS.join(", ")})...\n`
  );

  const results: RequestResult[] = [];
  const deadline = Date.now() + durationSec * 1000;

  async function worker() {
    while (Date.now() < deadline) {
      results.push(await fireOne(url, key));
    }
  }

  const wallStart = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - wallStart;

  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const failed = results.filter((r) => !r.ok);

  console.log(`Requests:     ${results.length}`);
  console.log(
    `Failed:       ${failed.length}${failed.length ? ` (${((failed.length / results.length) * 100).toFixed(1)}%)` : ""}`
  );
  console.log(`Throughput:   ${(results.length / (wallMs / 1000)).toFixed(1)} req/s`);
  console.log(`Latency p50:  ${percentile(latencies, 50).toFixed(1)}ms`);
  console.log(`Latency p95:  ${percentile(latencies, 95).toFixed(1)}ms`);
  console.log(`Latency p99:  ${percentile(latencies, 99).toFixed(1)}ms`);

  if (failed.length) {
    const byStatus = new Map<number, number>();
    for (const r of failed) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    console.log("\nFailure breakdown (status: count):");
    for (const [status, count] of byStatus) console.log(`  ${status || "(network error)"}: ${count}`);

    if ((byStatus.get(429) ?? 0) > 0) {
      console.log(
        "\nNote: 429s here likely mean you tripped the tenant rate limiter " +
          "(60 req/min by default — src/middleware/rateLimit.ts), not a real " +
          "failure. That's the limiter doing its job; lower --concurrency/" +
          "--duration, or read latency/throughput on the requests that got " +
          "through instead of treating this as an error rate."
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
