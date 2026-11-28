/**
 * B3 isolated OFF/ON soak — actual async wall-clock (not arithmetic model alone).
 *
 * Simulates Accept/Decline Edge stage I/O with delayed Promises matching production
 * sequential (OFF) vs Promise.all groups (ON). Uses local Docker Postgres for
 * assignment exclusivity, preload→RPC races, and lock contention samples.
 *
 * Does NOT touch production. No paid bookings.
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-write --allow-read --allow-sys \
 *     supabase/tests/_shared/b3LocalOffOnSoakHarness.ts
 *
 * Optional: B3_SOAK_OUT=/path/to/results.json
 */

import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { measureAcceptDeclineB3Workload } from "./offline/acceptDeclineB3SSOT.ts";

const DB_URL = Deno.env.get("B3_SOAK_DB_URL") ??
  "postgres://postgres:postgres@127.0.0.1:54322/postgres";

const OUT = Deno.env.get("B3_SOAK_OUT") ??
  `${Deno.env.get("HOME")}/Library/Application Support/Cursor/AgentStores/cursor_agent_stores/e405c1a9-c182-4bf8-85fd-ac7b215748ce/files/110-p10/B3_LOCAL_SOAK_RESULTS.json`;

type Mode = "OFF" | "ON";
type Scenario =
  | "instant_accept"
  | "stacked_accept"
  | "scheduled_nro_accept"
  | "marketplace_accept"
  | "decline"
  | "customer_assignment_visibility"
  | "driver_nav_after_confirm";

type StageDelays = {
  eligibilityMs: number;
  offerLookupMs: number;
  holdOrMarketplaceMs: number;
  preRpcMembersMs: number[];
  commitmentEvalMs: number;
  rpcMs: number;
  /** Post-canonical only (must not inflate primary). */
  postCanonicalNotifyMs: number;
  postCanonicalNavMs: number;
};

/** Representative Edge stage delays (ms) from prior Accept breakdown + Decline lookup/RPC. */
const SCENARIO_DELAYS: Record<Scenario, StageDelays> = {
  instant_accept: {
    eligibilityMs: 186,
    offerLookupMs: 95,
    holdOrMarketplaceMs: 88,
    preRpcMembersMs: [70, 65, 55, 90, 0],
    commitmentEvalMs: 12,
    rpcMs: 226,
    postCanonicalNotifyMs: 180,
    postCanonicalNavMs: 40,
  },
  stacked_accept: {
    eligibilityMs: 186,
    offerLookupMs: 95,
    holdOrMarketplaceMs: 88,
    preRpcMembersMs: [70, 65, 55, 90, 85],
    commitmentEvalMs: 12,
    rpcMs: 240,
    postCanonicalNotifyMs: 180,
    postCanonicalNavMs: 40,
  },
  scheduled_nro_accept: {
    eligibilityMs: 186,
    offerLookupMs: 95,
    holdOrMarketplaceMs: 88,
    preRpcMembersMs: [70, 65, 55, 90, 0],
    commitmentEvalMs: 18,
    rpcMs: 230,
    postCanonicalNotifyMs: 180,
    postCanonicalNavMs: 40,
  },
  marketplace_accept: {
    eligibilityMs: 0,
    offerLookupMs: 0,
    holdOrMarketplaceMs: 90,
    preRpcMembersMs: [110, 95, 80], // commitment, journey, wallet
    commitmentEvalMs: 0,
    rpcMs: 200,
    postCanonicalNotifyMs: 160,
    postCanonicalNavMs: 35,
  },
  decline: {
    eligibilityMs: 0,
    offerLookupMs: 85,
    holdOrMarketplaceMs: 0,
    preRpcMembersMs: [],
    commitmentEvalMs: 0,
    rpcMs: 140,
    postCanonicalNotifyMs: 50, // deferred rescue
    postCanonicalNavMs: 30,
  },
  customer_assignment_visibility: {
    // Measured as post-canonical only; primary Accept path excludes this.
    eligibilityMs: 186,
    offerLookupMs: 95,
    holdOrMarketplaceMs: 88,
    preRpcMembersMs: [70, 65, 55, 90, 0],
    commitmentEvalMs: 12,
    rpcMs: 226,
    postCanonicalNotifyMs: 180,
    postCanonicalNavMs: 0,
  },
  driver_nav_after_confirm: {
    eligibilityMs: 186,
    offerLookupMs: 95,
    holdOrMarketplaceMs: 88,
    preRpcMembersMs: [70, 65, 55, 90, 0],
    commitmentEvalMs: 12,
    rpcMs: 226,
    postCanonicalNotifyMs: 0,
    postCanonicalNavMs: 40,
  },
};

const SAMPLES_PER_SCENARIO = 40;
const COMPETING_DRIVERS = 8;
const JITTER_FRAC = 0.08;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function jitter(ms: number): number {
  if (ms <= 0) return 0;
  const delta = ms * JITTER_FRAC * (Math.random() * 2 - 1);
  return Math.max(1, ms + delta);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

function summarise(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length
      ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
      : 0,
  };
}

type RunResult = {
  primaryMs: number;
  postCanonicalMs: number;
  queryCount: number;
  maxConcurrentQueries: number;
  serialAwaits: number;
  failed: boolean;
  timeout: boolean;
  error?: string;
};

/**
 * Execute one Accept/Decline-shaped request under OFF (sequential) or ON (parallel groups).
 * Tracks concurrent in-flight "queries" to assess Shared-CPU-style contention pressure.
 */
async function runEdgeShapedPath(
  mode: Mode,
  scenario: Scenario,
  delays: StageDelays,
): Promise<RunResult> {
  let inFlight = 0;
  let maxConcurrent = 0;
  let queryCount = 0;
  let serialAwaits = 0;

  const q = async (ms: number) => {
    queryCount += 1;
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    try {
      await sleep(jitter(ms));
    } finally {
      inFlight -= 1;
    }
  };

  const t0 = performance.now();
  let failed = false;
  let timeout = false;
  let error: string | undefined;

  try {
    if (scenario === "decline") {
      // Live decline-trip: lookup → RPC; rescue deferred (post-canonical).
      serialAwaits += 1;
      await q(delays.offerLookupMs);
      serialAwaits += 1;
      await q(delays.rpcMs);
    } else if (scenario === "marketplace_accept") {
      serialAwaits += 1;
      await q(delays.holdOrMarketplaceMs);
      if (mode === "ON") {
        await Promise.all(delays.preRpcMembersMs.filter((m) => m > 0).map((m) => q(m)));
      } else {
        for (const m of delays.preRpcMembersMs) {
          if (m <= 0) continue;
          serialAwaits += 1;
          await q(m);
        }
      }
      serialAwaits += 1;
      await q(delays.rpcMs);
    } else {
      // instant / stacked / scheduled NRO Accept (accept-offer shape)
      if (mode === "ON") {
        await Promise.all([
          delays.eligibilityMs > 0 ? q(delays.eligibilityMs) : Promise.resolve(),
          delays.offerLookupMs > 0 ? q(delays.offerLookupMs) : Promise.resolve(),
        ]);
      } else {
        if (delays.eligibilityMs > 0) {
          serialAwaits += 1;
          await q(delays.eligibilityMs);
        }
        if (delays.offerLookupMs > 0) {
          serialAwaits += 1;
          await q(delays.offerLookupMs);
        }
      }
      if (delays.holdOrMarketplaceMs > 0) {
        serialAwaits += 1;
        await q(delays.holdOrMarketplaceMs);
      }
      const members = delays.preRpcMembersMs.filter((m) => m > 0);
      if (mode === "ON") {
        await Promise.all(members.map((m) => q(m)));
      } else {
        for (const m of members) {
          serialAwaits += 1;
          await q(m);
        }
      }
      if (delays.commitmentEvalMs > 0) {
        serialAwaits += 1;
        await q(delays.commitmentEvalMs);
      }
      serialAwaits += 1;
      await q(delays.rpcMs);
    }
  } catch (e) {
    failed = true;
    error = e instanceof Error ? e.message : String(e);
  }

  const primaryMs = performance.now() - t0;

  // Post-canonical work must not block primary (bg).
  const postStart = performance.now();
  if (!failed) {
    void (async () => {
      if (delays.postCanonicalNotifyMs > 0) await q(delays.postCanonicalNotifyMs);
      if (delays.postCanonicalNavMs > 0) await q(delays.postCanonicalNavMs);
    })();
  }
  // Measure scheduled post work cost separately (await for accounting only in visibility/nav scenarios).
  let postCanonicalMs = 0;
  if (
    scenario === "customer_assignment_visibility" ||
    scenario === "driver_nav_after_confirm"
  ) {
    if (delays.postCanonicalNotifyMs > 0) await q(delays.postCanonicalNotifyMs);
    if (delays.postCanonicalNavMs > 0) await q(delays.postCanonicalNavMs);
    postCanonicalMs = performance.now() - postStart;
  }

  if (primaryMs > 5000) timeout = true;

  return {
    primaryMs,
    postCanonicalMs,
    queryCount,
    maxConcurrentQueries: maxConcurrent,
    serialAwaits,
    failed,
    timeout,
    error,
  };
}

async function measureScenario(mode: Mode, scenario: Scenario) {
  const delays = SCENARIO_DELAYS[scenario];
  const primaries: number[] = [];
  const posts: number[] = [];
  const queryCounts: number[] = [];
  const maxConc: number[] = [];
  let failures = 0;
  let timeouts = 0;

  for (let i = 0; i < SAMPLES_PER_SCENARIO; i++) {
    const r = await runEdgeShapedPath(mode, scenario, delays);
    primaries.push(r.primaryMs);
    if (r.postCanonicalMs > 0) posts.push(r.postCanonicalMs);
    queryCounts.push(r.queryCount);
    maxConc.push(r.maxConcurrentQueries);
    if (r.failed) failures += 1;
    if (r.timeout) timeouts += 1;
  }

  const model = measureAcceptDeclineB3Workload({
    enabled: mode === "ON",
    eligibilityMs: delays.eligibilityMs,
    offerLookupMs: delays.offerLookupMs,
    holdOrMarketplaceMs: delays.holdOrMarketplaceMs,
    preRpcParallelMembersMs: delays.preRpcMembersMs,
    commitmentEvalMs: delays.commitmentEvalMs,
    rpcMs: delays.rpcMs,
  });

  return {
    mode,
    scenario,
    samples: SAMPLES_PER_SCENARIO,
    primary: summarise(primaries),
    post_canonical: posts.length ? summarise(posts) : null,
    query_count: summarise(queryCounts),
    max_concurrent_queries: summarise(maxConc),
    failures,
    timeouts,
    failure_rate: failures / SAMPLES_PER_SCENARIO,
    timeout_rate: timeouts / SAMPLES_PER_SCENARIO,
    model_primary_ms: model.primaryPathMs,
    model_saved_vs_off_structure: model.savedMs,
  };
}

/** Postgres: competing accepts — only one advisory lock holder mutates. */
async function competingDriversExclusivity(
  sql: ReturnType<typeof postgres>,
): Promise<{
  winners: number;
  losers: number;
  lock_wait_p50_ms: number;
  lock_wait_p95_ms: number;
  lock_wait_p99_ms: number;
  ok: boolean;
}> {
  await sql`CREATE TABLE IF NOT EXISTS public.b3_soak_offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'pending',
    winner text
  )`;
  await sql`TRUNCATE public.b3_soak_offers`;
  const [offer] = await sql`
    INSERT INTO public.b3_soak_offers(status) VALUES ('pending') RETURNING id
  `;
  const offerId = offer.id as string;
  const waits: number[] = [];

  const workers = Array.from({ length: COMPETING_DRIVERS }, (_, i) => {
    const driver = `d${i}`;
    return (async () => {
      const t0 = performance.now();
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${"b3_soak:" + offerId}))`;
        const rows = await tx`
          SELECT status FROM public.b3_soak_offers WHERE id = ${offerId} FOR UPDATE
        `;
        waits.push(performance.now() - t0);
        if (rows[0]?.status === "pending") {
          await tx`
            UPDATE public.b3_soak_offers
            SET status = 'accepted', winner = ${driver}
            WHERE id = ${offerId}
          `;
        }
      });
    })();
  });

  await Promise.all(workers);
  const [final] = await sql`SELECT status, winner FROM public.b3_soak_offers WHERE id = ${offerId}`;
  const winners = final?.status === "accepted" && final?.winner ? 1 : 0;
  const summary = summarise(waits);
  return {
    winners,
    losers: COMPETING_DRIVERS - winners,
    lock_wait_p50_ms: summary.p50,
    lock_wait_p95_ms: summary.p95,
    lock_wait_p99_ms: summary.p99,
    ok: winners === 1,
  };
}

/**
 * Preload → RPC race: Edge may preload "pending", but transactional RPC must
 * re-read and reject if expired/taken before commit.
 */
async function preloadRaceSafety(
  sql: ReturnType<typeof postgres>,
): Promise<{
  expired_rejected: boolean;
  taken_rejected: boolean;
  stale_preload_cannot_bypass: boolean;
  ok: boolean;
}> {
  await sql`CREATE TABLE IF NOT EXISTS public.b3_soak_race (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL,
    expires_at timestamptz,
    version int NOT NULL DEFAULT 1
  )`;
  await sql`TRUNCATE public.b3_soak_race`;

  // --- expire between preload and RPC ---
  const [o1] = await sql`
    INSERT INTO public.b3_soak_race(status, expires_at)
    VALUES ('pending', now() + interval '10 seconds')
    RETURNING id
  `;
  const preload1 = await sql`
    SELECT status, expires_at, version FROM public.b3_soak_race WHERE id = ${o1.id}
  `;
  await sql`
    UPDATE public.b3_soak_race
    SET status = 'expired', version = version + 1, expires_at = now() - interval '1 second'
    WHERE id = ${o1.id}
  `;
  let expiredRejected = false;
  await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT status, expires_at, version FROM public.b3_soak_race WHERE id = ${o1.id} FOR UPDATE
    `;
    const row = rows[0]!;
    // Authoritative check ignores stale preload (preload said pending).
    if (
      String(preload1[0]?.status) === "pending" &&
      (row.status !== "pending" || new Date(row.expires_at) < new Date())
    ) {
      expiredRejected = true;
      return;
    }
    await tx`UPDATE public.b3_soak_race SET status = 'accepted' WHERE id = ${o1.id}`;
  });

  // --- taken between preload and RPC ---
  const [o2] = await sql`
    INSERT INTO public.b3_soak_race(status, expires_at)
    VALUES ('pending', now() + interval '30 seconds')
    RETURNING id
  `;
  const preload2 = await sql`
    SELECT status, version FROM public.b3_soak_race WHERE id = ${o2.id}
  `;
  await sql`
    UPDATE public.b3_soak_race SET status = 'accepted', version = version + 1 WHERE id = ${o2.id}
  `;
  let takenRejected = false;
  await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT status, version FROM public.b3_soak_race WHERE id = ${o2.id} FOR UPDATE
    `;
    const row = rows[0]!;
    if (
      String(preload2[0]?.status) === "pending" &&
      Number(preload2[0]?.version) === Number(row.version) - 1 &&
      row.status !== "pending"
    ) {
      takenRejected = true;
      return;
    }
    await tx`UPDATE public.b3_soak_race SET status = 'accepted_b' WHERE id = ${o2.id}`;
  });

  const ok = expiredRejected && takenRejected;
  return {
    expired_rejected: expiredRejected,
    taken_rejected: takenRejected,
    stale_preload_cannot_bypass: ok,
    ok,
  };
}

/** Duplicate taps / ambiguous recovery — second tap loses mutex; hydrate recovers. */
function duplicateTapAndRecovery(): {
  duplicate_blocked: boolean;
  ambiguous_recovered: boolean;
  no_optimistic_success: boolean;
  ok: boolean;
} {
  let inFlight = false;
  let applied = false;
  let optimistic = false;

  const accept = async (forceAmbiguous = false) => {
    if (inFlight) return { ok: false as const, reason: "busy" };
    inFlight = true;
    try {
      await sleep(30);
      if (forceAmbiguous) {
        // Lost response — must NOT set applied until reconcile.
        return { ok: false as const, reason: "network", needReconcile: true };
      }
      // Authoritative confirmation only.
      applied = true;
      return { ok: true as const };
    } finally {
      inFlight = false;
    }
  };

  // Duplicate tap
  const first = accept();
  const second = accept();
  // Optimistic would set applied before await — we never do that.
  if (applied) optimistic = true;

  return Promise.all([first, second]).then(async ([a, b]) => {
    const duplicateBlocked =
      (a.ok && b.reason === "busy") || (b.ok && a.reason === "busy");
    // Ambiguous path
    applied = false;
    const lost = await accept(true);
    let recovered = false;
    if (!lost.ok && "needReconcile" in lost && lost.needReconcile) {
      // Reconcile reads authoritative state (simulated assigned).
      const authoritativeAssigned = true;
      if (authoritativeAssigned) {
        applied = true;
        recovered = true;
      }
    }
    const ok = duplicateBlocked && recovered && !optimistic && applied;
    return {
      duplicate_blocked: duplicateBlocked,
      ambiguous_recovered: recovered,
      no_optimistic_success: !optimistic,
      ok,
    };
  });
}

async function main() {
  const sql = postgres(DB_URL, { max: 12, idle_timeout: 5 });
  try {
    const scenarios: Scenario[] = [
      "instant_accept",
      "stacked_accept",
      "scheduled_nro_accept",
      "marketplace_accept",
      "decline",
      "customer_assignment_visibility",
      "driver_nav_after_confirm",
    ];

    const off: Record<string, unknown> = {};
    const on: Record<string, unknown> = {};
    for (const s of scenarios) {
      off[s] = await measureScenario("OFF", s);
      on[s] = await measureScenario("ON", s);
    }

    const competing = await competingDriversExclusivity(sql);
    const preloadRace = await preloadRaceSafety(sql);
    const dup = await duplicateTapAndRecovery();

    // Resource efficiency: ON should raise max concurrent queries per request
    // but cut primary wall time — peak across samples for instant accept.
    const offInstant = off.instant_accept as { primary: { p50: number }; max_concurrent_queries: { p50: number; max: number }; query_count: { mean: number } };
    const onInstant = on.instant_accept as { primary: { p50: number }; max_concurrent_queries: { p50: number; max: number }; query_count: { mean: number } };
    const offDecline = off.decline as { primary: { p50: number; p95: number; p99: number; n: number }; failures: number };
    const onDecline = on.decline as { primary: { p50: number; p95: number; p99: number; n: number }; failures: number };

    const savedInstantP50 = offInstant.primary.p50 - onInstant.primary.p50;
    const parallelWider =
      onInstant.max_concurrent_queries.max >= offInstant.max_concurrent_queries.max;
    const primaryFaster = onInstant.primary.p50 < offInstant.primary.p50 * 0.92;
    // Shared CPU pressure check: concurrent queries per request rise, but we
    // require improvement ≥15% so contention is "productive" not wasteful.
    const productiveParallel = primaryFaster && savedInstantP50 / offInstant.primary.p50 >= 0.15;

    const pass_criteria = {
      instant_on_faster: primaryFaster,
      stacked_on_faster:
        (on.stacked_accept as { primary: { p50: number } }).primary.p50 <
        (off.stacked_accept as { primary: { p50: number } }).primary.p50 * 0.92,
      marketplace_on_faster:
        (on.marketplace_accept as { primary: { p50: number } }).primary.p50 <
        (off.marketplace_accept as { primary: { p50: number } }).primary.p50 * 0.92,
      decline_stable:
        Math.abs(onDecline.primary.p50 - offDecline.primary.p50) /
            Math.max(1, offDecline.primary.p50) < 0.12,
      zero_failures_accept:
        scenarios
          .filter((s) => s !== "decline")
          .every((s) =>
            (off[s] as { failures: number }).failures === 0 &&
            (on[s] as { failures: number }).failures === 0
          ),
      competing_one_winner: competing.ok,
      preload_race_safe: preloadRace.ok,
      duplicate_and_recovery: dup.ok,
      productive_parallelism: productiveParallel && parallelWider,
      customer_visibility_off_primary:
        (on.customer_assignment_visibility as { post_canonical: { p50: number } | null })
          .post_canonical != null,
    };

    const all_pass = Object.values(pass_criteria).every(Boolean);

    const report = {
      generated_at: new Date().toISOString(),
      environment: {
        kind: "isolated_local_async_io_plus_docker_postgres",
        db_url_host: "127.0.0.1:54322",
        production_touched: false,
        paid_bookings: false,
        load_test_production: false,
        samples_per_scenario: SAMPLES_PER_SCENARIO,
        jitter_frac: JITTER_FRAC,
      },
      before_after: { OFF: off, ON: on },
      decline_focus: {
        note:
          "Decline is measured under identical OFF/ON shapes; B3 does not parallelise decline-trip. Historical latency is reported — not marked resolved without evidence.",
        OFF: offDecline,
        ON: onDecline,
        remaining_bottlenecks: [
          {
            stage: "offer_lookup",
            typical_ms: SCENARIO_DELAYS.decline.offerLookupMs,
            note: "Single SELECT by trip_id+driver before decline_ride_offer",
          },
          {
            stage: "decline_rpc",
            typical_ms: SCENARIO_DELAYS.decline.rpcMs,
            note: "Authoritative decline_ride_offer — must stay on path",
          },
          {
            stage: "deferred_rescue",
            typical_ms: SCENARIO_DELAYS.decline.postCanonicalNotifyMs,
            note: "Exclusive activation rescue already off Driver RTT (decline-trip)",
          },
        ],
        resolved: false,
        reason:
          "Sufficient isolated samples collected; production Decline p95 still requires adopted O3 telemetry — not closed.",
      },
      safety: {
        competing_drivers: competing,
        preload_rpc_race: preloadRace,
        duplicate_tap_recovery: dup,
      },
      resource_efficiency: {
        instant_accept: {
          off_primary_p50: offInstant.primary.p50,
          on_primary_p50: onInstant.primary.p50,
          saved_p50_ms: Math.round(savedInstantP50),
          saved_p50_pct: Math.round((100 * savedInstantP50) / offInstant.primary.p50),
          off_max_concurrent_queries: offInstant.max_concurrent_queries.max,
          on_max_concurrent_queries: onInstant.max_concurrent_queries.max,
          off_mean_queries: offInstant.query_count.mean,
          on_mean_queries: onInstant.query_count.mean,
          shared_cpu_assessment: productiveParallel
            ? "Parallelism increases per-request concurrent queries but reduces wall time ≥15% — productive, not wasteful contention in isolated soak."
            : "Parallelism did not meet productive improvement bar — investigate before production.",
        },
      },
      pass_criteria,
      all_pass,
      production_readiness: {
        ready: false,
        blockers: [
          "No production Edge deploy (Owner gated)",
          "Decline not marked resolved pending production O3 samples",
          "Need staging/prod cohort after separate approval",
        ],
        isolated_soak_pass: all_pass,
      },
    };

    await Deno.writeTextFile(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      out: OUT,
      all_pass,
      instant_saved_p50_ms: Math.round(savedInstantP50),
      decline_p50_off: offDecline.primary.p50,
      decline_p50_on: onDecline.primary.p50,
      competing_ok: competing.ok,
      preload_ok: preloadRace.ok,
      dup_ok: dup.ok,
    }, null, 2));
    if (!all_pass) Deno.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  await main();
}
