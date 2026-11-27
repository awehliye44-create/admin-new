/**
 * Batch O2 — safe representative concurrency harness (local / staging only).
 *
 * NEVER pointed at production. NEVER creates paid bookings.
 * Simulates overlapping in-process timers only (no HTTP by default).
 *
 * Usage (local):
 *   deno run scripts/perf/safeConcurrencyHarness.ts
 *   CONCURRENCY=8 DURATION_MS=2000 deno run scripts/perf/safeConcurrencyHarness.ts
 *
 * Optional dry-run against a STAGING base URL with a read-only health path:
 *   ALLOW_STAGING_HTTP=1 STAGING_BASE_URL=https://… deno run --allow-net scripts/perf/safeConcurrencyHarness.ts
 */

function readHarnessEnv(): {
  concurrency: number;
  durationMs: number;
  allowStagingHttp: boolean;
  stagingBaseUrl: string;
} {
  return {
    concurrency: Math.min(
      32,
      Math.max(1, Number(Deno.env.get("CONCURRENCY") ?? "4") || 4),
    ),
    durationMs: Math.min(
      10_000,
      Math.max(100, Number(Deno.env.get("DURATION_MS") ?? "1500") || 1500),
    ),
    allowStagingHttp: Deno.env.get("ALLOW_STAGING_HTTP") === "1",
    stagingBaseUrl: (Deno.env.get("STAGING_BASE_URL") ?? "").replace(/\/$/, ""),
  };
}

export function assertNotProductionUrl(url: string): void {
  const lower = url.toLowerCase();
  if (
    lower.includes("prod") ||
    lower.includes("onecab.app") ||
    (lower.includes("supabase.co") && !lower.includes("staging"))
  ) {
    // Soft guard — require explicit allow + staging in hostname.
    if (!lower.includes("staging") && !lower.includes("localhost")) {
      throw new Error(
        "Refusing HTTP target that does not look like staging/localhost. Set a staging URL or omit ALLOW_STAGING_HTTP.",
      );
    }
  }
}

async function simulatedWork(id: number): Promise<{ id: number; ms: number }> {
  const t0 = performance.now();
  // Representative CPU+timer overlap (no I/O).
  let x = 0;
  for (let i = 0; i < 20_000; i++) x = (x + i * id) % 9973;
  await new Promise((r) => setTimeout(r, 5 + (id % 7)));
  void x;
  return { id, ms: Math.round(performance.now() - t0) };
}

async function optionalStagingProbe(
  id: number,
  env: ReturnType<typeof readHarnessEnv>,
): Promise<{ id: number; ms: number; ok: boolean }> {
  if (!env.allowStagingHttp || !env.stagingBaseUrl) {
    const sim = await simulatedWork(id);
    return { ...sim, ok: true };
  }
  assertNotProductionUrl(env.stagingBaseUrl);
  const t0 = performance.now();
  // Read-only health-ish path only — never booking/payment endpoints.
  const res = await fetch(`${env.stagingBaseUrl}/functions/v1/`, {
    method: "GET",
  }).catch(() => null);
  return {
    id,
    ms: Math.round(performance.now() - t0),
    ok: res != null && res.status < 500,
  };
}

async function runWave(): Promise<void> {
  const env = readHarnessEnv();
  const started = performance.now();
  const results: { id: number; ms: number; ok: boolean }[] = [];
  while (performance.now() - started < env.durationMs) {
    const wave = await Promise.all(
      Array.from({ length: env.concurrency }, (_, i) => optionalStagingProbe(i, env)),
    );
    results.push(...wave);
  }
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const p95 = ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)] ?? null;
  console.log(
    JSON.stringify(
      {
        harness: "safe_concurrency_o2",
        concurrency: env.concurrency,
        duration_ms: env.durationMs,
        samples: results.length,
        failures: results.filter((r) => !r.ok).length,
        p50_ms: ms[Math.floor(ms.length / 2)] ?? null,
        p95_ms: p95,
        http_enabled: env.allowStagingHttp && Boolean(env.stagingBaseUrl),
        note: "Local/staging only — never production; never paid bookings",
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await runWave();
}

export { simulatedWork };
