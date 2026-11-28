/**
 * B5 isolated OFF/ON soak — confirm-SELECT count + synthetic p50/p95/p99 wall model.
 */
import {
  measureArrivePickupB5Workload,
  shouldSkipPostWaitingTripSelect,
} from "./offline/arrivePickupB5SSOT.ts";

export type B5SoakResult = {
  all_pass: boolean;
  off: { confirm_selects: number; wall_p50: number; wall_p95: number; wall_p99: number };
  on: { confirm_selects: number; wall_p50: number; wall_p95: number; wall_p99: number };
  checks: Record<string, boolean>;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

/** Model: base Arrive 1400ms + optional confirm SELECT 120ms. */
function walls(enabled: boolean, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const hasStamp = i % 5 !== 0; // 80% have waiting stamp
    const skip = shouldSkipPostWaitingTripSelect({
      b5Enabled: enabled,
      waitingStartedAt: hasStamp ? `t-${i}` : null,
      tripWaitingStartedAt: null,
    });
    const base = 1400 + (i % 7) * 15;
    out.push(base + (skip ? 0 : 120));
  }
  return out.sort((a, b) => a - b);
}

export function runB5LocalOffOnSoak(): B5SoakResult {
  const cases = Array.from({ length: 100 }, (_, i) => ({
    waitingStartedAt: i % 5 === 0 ? null : `t-${i}`,
    tripWaitingStartedAt: null as string | null,
  }));
  const offW = measureArrivePickupB5Workload({ enabled: false, cases });
  const onW = measureArrivePickupB5Workload({ enabled: true, cases });
  const offWalls = walls(false, 100);
  const onWalls = walls(true, 100);

  const checks = {
    off_always_selects: offW.confirm_selects === 100,
    on_skips_proven: onW.skipped === 80 && onW.confirm_selects === 20,
    fail_closed_missing: shouldSkipPostWaitingTripSelect({
      b5Enabled: true,
      waitingStartedAt: null,
      tripWaitingStartedAt: null,
    }) === false,
    on_p50_improved: percentile(onWalls, 50) < percentile(offWalls, 50),
  };

  return {
    all_pass: Object.values(checks).every(Boolean),
    off: {
      confirm_selects: offW.confirm_selects,
      wall_p50: percentile(offWalls, 50),
      wall_p95: percentile(offWalls, 95),
      wall_p99: percentile(offWalls, 99),
    },
    on: {
      confirm_selects: onW.confirm_selects,
      wall_p50: percentile(onWalls, 50),
      wall_p95: percentile(onWalls, 95),
      wall_p99: percentile(onWalls, 99),
    },
    checks,
  };
}

if (import.meta.main) {
  const r = runB5LocalOffOnSoak();
  console.log(JSON.stringify(r, null, 2));
  if (!r.all_pass) Deno.exit(1);
}
