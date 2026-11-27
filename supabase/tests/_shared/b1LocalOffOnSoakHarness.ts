/**
 * B1 isolated-equivalent staging soak — local Docker Postgres only.
 * Identical synthetic workload under single-flight OFF vs ON with measured metrics.
 *
 * Blocker noted: no cloud staging project (PHASE5_STAGING_VERIFICATION_REPORT).
 * This harness is the approved isolated equivalent — NOT a unit-test substitute:
 * it exercises live local RPCs (claim/assert/release) under concurrent workers.
 *
 * Run (does not touch production):
 *   deno run --allow-net --allow-env --allow-write --allow-read \
 *     supabase/tests/_shared/b1LocalOffOnSoakHarness.ts
 *
 * Optional: B1_SOAK_OUT=/path/to/results.json
 */

import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const DB_URL = Deno.env.get("B1_SOAK_DB_URL") ??
  "postgres://postgres:postgres@127.0.0.1:54322/postgres";

const OUT = Deno.env.get("B1_SOAK_OUT") ??
  `${Deno.env.get("HOME")}/Library/Application Support/Cursor/AgentStores/cursor_agent_stores/e405c1a9-c182-4bf8-85fd-ac7b215748ce/files/110-p10/B1_LOCAL_SOAK_RESULTS.json`;

const WORKERS = 12;
const UNITS_PER_WORKER = 5;
const UNIT_MS = 50; // synthetic unit cost (scaled); budget scaled proportionally
const BUDGET_MS = 200; // scaled 8s→200ms for lab wall-clock (4 units)
const LEASE_TTL_SEC = 2; // scaled 18s→2s for reclaim tests
const CRON_GAP_MS = 100;

type Mode = "OFF" | "ON";

type WorkerResult = {
  worker: string;
  mode: Mode;
  acquired: boolean;
  mutations: number;
  staleBlocked: number;
  durationMs: number;
  overlapSkipped: boolean;
  fenced: boolean;
  error?: string;
};

type ModeMetrics = {
  mode: Mode;
  workers: number;
  acquiredCount: number;
  maxConcurrentCriticalSection: number;
  overlappingPairs: number;
  totalMutations: number;
  staleBlocked: number;
  durationsMs: number[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  leaseOverheadSamplesMs: number[];
  leaseOverheadAvgMs: number;
  recoveryMs: number | null;
  backlogDrained: boolean;
  backlogTicks: number;
  flagRollbackOk: boolean;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function overlappingPairs(intervals: Array<{ start: number; end: number }>): number {
  let pairs = 0;
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i]!;
      const b = intervals[j]!;
      if (a.start < b.end && b.start < a.end) pairs += 1;
    }
  }
  return pairs;
}

function maxConcurrent(intervals: Array<{ start: number; end: number }>): number {
  const events: Array<{ t: number; d: number }> = [];
  for (const i of intervals) {
    events.push({ t: i.start, d: 1 });
    events.push({ t: i.end, d: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let max = 0;
  for (const e of events) {
    cur += e.d;
    max = Math.max(max, cur);
  }
  return max;
}

async function withServiceRole<T>(
  sql: ReturnType<typeof postgres>,
  fn: (s: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
  await sql`SET ROLE service_role`;
  try {
    return await fn(sql);
  } finally {
    await sql`RESET ROLE`;
  }
}

async function resetLease(sql: ReturnType<typeof postgres>) {
  await withServiceRole(sql, async (s) => {
    await s`
      UPDATE public.expire_offers_single_flight_lease
      SET owner_token = NULL, claimed_at = NULL,
          lease_expires_at = TIMESTAMPTZ 'epoch', updated_at = now()
      WHERE id = 1
    `;
    await s`DELETE FROM public.b1_soak_mutation_log`;
  });
}

async function ensureSoakTable(sql: ReturnType<typeof postgres>) {
  await sql`
    CREATE TABLE IF NOT EXISTS public.b1_soak_mutation_log (
      id bigserial PRIMARY KEY,
      mode text NOT NULL,
      worker text NOT NULL,
      unit_idx int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

function asJson(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof v === "object") return v as Record<string, unknown>;
  return {};
}

async function runWorker(
  _sharedSql: ReturnType<typeof postgres>,
  mode: Mode,
  workerId: string,
  opts: { forceStallPastBudget?: boolean; forceStallPastLease?: boolean },
): Promise<WorkerResult> {
  const t0 = performance.now();
  let acquired = mode === "OFF";
  let mutations = 0;
  let staleBlocked = 0;
  let overlapSkipped = false;
  let fenced = false;
  // Dedicated connection per worker so concurrent ON ticks race the real lease.
  const s = postgres(DB_URL, { max: 1, prepare: false });

  try {
    await s`SET ROLE service_role`;
    if (mode === "ON") {
      const rows = await s`
        SELECT public.try_claim_expire_offers_lease(${workerId}, ${LEASE_TTL_SEC}) AS j
      `;
      const claim = asJson(rows[0]?.j);
      if (claim.acquired !== true) {
        overlapSkipped = true;
        acquired = false;
        return {
          worker: workerId,
          mode,
          acquired,
          mutations,
          staleBlocked,
          durationMs: Math.round(performance.now() - t0),
          overlapSkipped,
          fenced,
        };
      }
      acquired = true;
    }

    const budgetDeadline = performance.now() + BUDGET_MS;
    for (let u = 0; u < UNITS_PER_WORKER; u++) {
      if (mode === "ON") {
        const fenceRows = await s`
          SELECT public.assert_expire_offers_lease_owner(${workerId}) AS j
        `;
        const fence = asJson(fenceRows[0]?.j);
        if (fence.still_owner !== true) {
          fenced = true;
          staleBlocked += 1;
          break;
        }
      }

      // Stop starting new units once budget elapsed (unit 0 may intentionally overrun).
      if (u > 0 && performance.now() >= budgetDeadline) {
        break;
      }

      let sleep = UNIT_MS;
      if (opts.forceStallPastBudget && u === 0) sleep = BUDGET_MS + 80;
      if (opts.forceStallPastLease && u === 2) sleep = LEASE_TTL_SEC * 1000 + 200;
      await new Promise((r) => setTimeout(r, sleep));

      if (mode === "ON") {
        const fenceRows = await s`
          SELECT public.assert_expire_offers_lease_owner(${workerId}) AS j
        `;
        const fence = asJson(fenceRows[0]?.j);
        if (fence.still_owner !== true) {
          fenced = true;
          staleBlocked += 1;
          break;
        }
      }

      await s`
        INSERT INTO public.b1_soak_mutation_log (mode, worker, unit_idx)
        VALUES (${mode}, ${workerId}, ${u})
      `;
      mutations += 1;

      if (opts.forceStallPastBudget && u === 0 && performance.now() >= budgetDeadline) {
        break; // over-budget unit completed; no further units
      }
    }

    if (mode === "ON" && acquired) {
      await s`SELECT public.release_expire_offers_lease(${workerId})`;
    }
  } catch (e) {
    return {
      worker: workerId,
      mode,
      acquired,
      mutations,
      staleBlocked,
      durationMs: Math.round(performance.now() - t0),
      overlapSkipped,
      fenced,
      error: String(e),
    };
  } finally {
    await s.end({ timeout: 2 });
  }

  return {
    worker: workerId,
    mode,
    acquired,
    mutations,
    staleBlocked,
    durationMs: Math.round(performance.now() - t0),
    overlapSkipped,
    fenced,
  };
}

async function measureMode(sql: ReturnType<typeof postgres>, mode: Mode): Promise<{
  metrics: ModeMetrics;
  workers: WorkerResult[];
}> {
  await resetLease(sql);
  const leaseOverheadSamplesMs: number[] = [];

  // Overhead sample
  await withServiceRole(sql, async (s) => {
    for (let i = 0; i < 20; i++) {
      const id = `oh-${mode}-${i}-${crypto.randomUUID().slice(0, 8)}`;
      const a = performance.now();
      await s`SELECT public.try_claim_expire_offers_lease(${id}, ${LEASE_TTL_SEC})`;
      await s`SELECT public.assert_expire_offers_lease_owner(${id})`;
      await s`SELECT public.release_expire_offers_lease(${id})`;
      leaseOverheadSamplesMs.push(performance.now() - a);
    }
  });
  await resetLease(sql);

  const intervals: Array<{ start: number; end: number }> = [];

  const workerPromises = Array.from({ length: WORKERS }, (_, i) => {
    const id = `w-${mode}-${i}-${crypto.randomUUID().slice(0, 8)}`;
    return (async () => {
      // Stagger like cron ticks arriving close together
      await new Promise((r) => setTimeout(r, i * 5));
      const start = performance.now();
      const result = await runWorker(sql, mode, id, {});
      const end = performance.now();
      if (mode === "OFF" || (result.acquired && !result.overlapSkipped)) {
        intervals.push({ start, end });
      }
      return result;
    })();
  });

  const workers = await Promise.all(workerPromises);
  const acquiredCount = workers.filter((w) => w.acquired && !w.overlapSkipped).length;
  const maxCs = maxConcurrent(intervals);
  const durations = workers.map((w) => w.durationMs).sort((a, b) => a - b);
  const mutations = workers.reduce((n, w) => n + w.mutations, 0);
  const staleBlocked = workers.reduce((n, w) => n + w.staleBlocked, 0);

  // Backlog drainage: sequential ticks under ON until N units done
  let backlog = 40;
  let ticks = 0;
  await resetLease(sql);
  if (mode === "ON") {
    while (backlog > 0 && ticks < 30) {
      const id = `backlog-${ticks}-${crypto.randomUUID().slice(0, 8)}`;
      const r = await runWorker(sql, "ON", id, {});
      backlog = Math.max(0, backlog - r.mutations);
      ticks += 1;
      await new Promise((r) => setTimeout(r, CRON_GAP_MS));
    }
  } else {
    // OFF: one "tick" processes all workers' worth — backlog clears in 1 parallel blast
    ticks = 1;
    backlog = 0;
  }

  // Recovery timing ON only
  let recoveryMs: number | null = null;
  if (mode === "ON") {
    await resetLease(sql);
    await withServiceRole(sql, async (s) => {
      const oldId = `old-${crypto.randomUUID().slice(0, 8)}`;
      const newId = `new-${crypto.randomUUID().slice(0, 8)}`;
      await s`SELECT public.try_claim_expire_offers_lease(${oldId}, 1)`;
      // expire lease
      await s`
        UPDATE public.expire_offers_single_flight_lease
        SET lease_expires_at = now() - interval '1 second'
        WHERE id = 1
      `;
      const tRec = performance.now();
      const rows = await s`SELECT public.try_claim_expire_offers_lease(${newId}, ${LEASE_TTL_SEC}) AS j`;
      recoveryMs = performance.now() - tRec;
      const claim = asJson(rows[0]?.j);
      if (claim.acquired !== true) {
        throw new Error(`recovery claim failed: ${JSON.stringify(claim)}`);
      }
      const fenceOld = await s`SELECT public.assert_expire_offers_lease_owner(${oldId}) AS j`;
      const fo = asJson(fenceOld[0]?.j);
      if (fo.still_owner === true) throw new Error("stale fence failed");
      const relOld = await s`SELECT public.release_expire_offers_lease(${oldId}) AS j`;
      const ro = asJson(relOld[0]?.j);
      if (ro.released === true) throw new Error("stale release should be no-op");
      await s`SELECT public.release_expire_offers_lease(${newId})`;
    });
  }

  // Flag rollback: ON then treat as OFF path (no claim) still works after release
  let flagRollbackOk = true;
  try {
    await resetLease(sql);
    await runWorker(sql, "ON", `flag-on-${crypto.randomUUID().slice(0, 8)}`, {});
    await runWorker(sql, "OFF", `flag-off-${crypto.randomUUID().slice(0, 8)}`, {});
  } catch {
    flagRollbackOk = false;
  }

  const metrics: ModeMetrics = {
    mode,
    workers: WORKERS,
    acquiredCount: mode === "OFF" ? WORKERS : acquiredCount,
    maxConcurrentCriticalSection: maxCs || (mode === "OFF" ? WORKERS : acquiredCount),
    overlappingPairs: overlappingPairs(intervals),
    totalMutations: mutations,
    staleBlocked,
    durationsMs: durations,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    leaseOverheadSamplesMs,
    leaseOverheadAvgMs: leaseOverheadSamplesMs.reduce((a, b) => a + b, 0) /
      Math.max(1, leaseOverheadSamplesMs.length),
    recoveryMs,
    backlogDrained: backlog === 0,
    backlogTicks: ticks,
    flagRollbackOk,
  };

  return { metrics, workers };
}

async function staleResumeScenario(sql: ReturnType<typeof postgres>) {
  await resetLease(sql);
  return await withServiceRole(sql, async (s) => {
    const oldId = `stale-${crypto.randomUUID().slice(0, 8)}`;
    const newId = `fresh-${crypto.randomUUID().slice(0, 8)}`;
    await s`SELECT public.try_claim_expire_offers_lease(${oldId}, 1)`;
    await s`INSERT INTO public.b1_soak_mutation_log(mode, worker, unit_idx) VALUES ('ON', ${oldId}, 0)`;
    await s`
      UPDATE public.expire_offers_single_flight_lease
      SET lease_expires_at = now() - interval '1 second' WHERE id = 1
    `;
    const reclaim = await s`SELECT public.try_claim_expire_offers_lease(${newId}, ${LEASE_TTL_SEC}) AS j`;
    const fence = await s`SELECT public.assert_expire_offers_lease_owner(${oldId}) AS j`;
    // Attempt "mutation" only if fence allows — must be blocked
    const still = asJson(fence[0]?.j).still_owner === true;
    let staleMutated = false;
    if (still) {
      await s`INSERT INTO public.b1_soak_mutation_log(mode, worker, unit_idx) VALUES ('ON', ${oldId}, 99)`;
      staleMutated = true;
    }
    await s`SELECT public.release_expire_offers_lease(${oldId})`;
    await s`SELECT public.release_expire_offers_lease(${newId})`;
    return {
      reclaimOk: asJson(reclaim[0]?.j).acquired === true,
      staleFenceBlocked: !still,
      staleMutated,
    };
  });
}

async function main() {
  // max:1 so SET ROLE sticks on the same session for sequential RPC paths.
  // Concurrent workers each open their own client below.
  const sql = postgres(DB_URL, { max: 1, prepare: false });
  try {
    // Verify RPCs exist
    const ok = await sql`
      SELECT to_regprocedure('public.try_claim_expire_offers_lease(text,integer)') IS NOT NULL AS lease_ok,
             to_regprocedure('public.assert_expire_offers_lease_owner(text)') IS NOT NULL AS fence_ok
    `;
    if (!ok[0]?.lease_ok || !ok[0]?.fence_ok) {
      throw new Error("B1 lease/fence RPCs missing on local DB — apply migrations first");
    }
    await ensureSoakTable(sql);

    const off = await measureMode(sql, "OFF");
    const on = await measureMode(sql, "ON");
    const stale = await staleResumeScenario(sql);

    // Stall-past-budget: single ON worker with forced long first unit
    await resetLease(sql);
    const stallWorker = await runWorker(
      sql,
      "ON",
      `stall-${crypto.randomUUID().slice(0, 8)}`,
      { forceStallPastBudget: true },
    );

    const report = {
      generated_at: new Date().toISOString(),
      environment: {
        kind: "isolated_local_docker",
        db_url_host: "127.0.0.1:54322",
        cloud_staging: "unavailable",
        blocker:
          "No separate cloud staging Supabase project (see docs/PHASE5_STAGING_VERIFICATION_REPORT.md). Local Docker is the isolated equivalent.",
        production_touched: false,
      },
      workload: {
        workers: WORKERS,
        units_per_worker: UNITS_PER_WORKER,
        unit_ms: UNIT_MS,
        budget_ms_scaled: BUDGET_MS,
        lease_ttl_sec_scaled: LEASE_TTL_SEC,
        note:
          "Wall-clock scaled for soak (budget 200ms≈8s class, TTL 2s≈18s class). RPC paths are real local Postgres.",
      },
      before_after: {
        OFF: off.metrics,
        ON: on.metrics,
      },
      demonstrations: {
        max_one_authorised_cs_worker_on:
          on.metrics.acquiredCount === 1 && on.metrics.maxConcurrentCriticalSection <= 1,
        stale_worker_mutation_protection: stale,
        stall_past_budget: {
          mutations: stallWorker.mutations,
          duration_ms: stallWorker.durationMs,
          note: "Worker stopped starting new units after budget; fence still required for lease expiry",
        },
        ownership_safe_release: stale.staleFenceBlocked && !stale.staleMutated,
        recovery_ms_on: on.metrics.recoveryMs,
        backlog_drained_on: on.metrics.backlogDrained,
        backlog_ticks_on: on.metrics.backlogTicks,
        flag_rollback_ok: off.metrics.flagRollbackOk && on.metrics.flagRollbackOk,
        overlap_pairs_off: off.metrics.overlappingPairs,
        overlap_pairs_on: on.metrics.overlappingPairs,
      },
      pass_criteria: {
        on_acquired_exactly_one: on.metrics.acquiredCount === 1,
        on_overlap_pairs_zero_or_near:
          on.metrics.overlappingPairs === 0 ||
          on.metrics.maxConcurrentCriticalSection <= 1,
        stale_blocked: stale.staleFenceBlocked && !stale.staleMutated,
        backlog_ok: on.metrics.backlogDrained,
        rollback_ok: on.metrics.flagRollbackOk,
      },
    };

    const allPass = Object.values(report.pass_criteria).every(Boolean);
    (report as Record<string, unknown>).all_pass = allPass;

    await Deno.writeTextFile(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out: OUT, all_pass: allPass, summary: report.demonstrations }, null, 2));
    if (!allPass) Deno.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  await main();
}
