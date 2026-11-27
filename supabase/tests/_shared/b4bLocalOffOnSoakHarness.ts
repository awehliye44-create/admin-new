/**
 * B4-B isolated OFF/ON soak — tip-read wall time + query count (no I/O).
 */
import {
  measureCompleteTripB4bWorkload,
  shouldParalleliseTipSetupReads,
} from "../../functions/_shared/completeTripB4bSSOT.ts";

export type B4bSoakResult = {
  all_pass: boolean;
  off: { wall_ms: number; query_count: number };
  on: { wall_ms: number; query_count: number };
  savings_ms: number;
  checks: Record<string, boolean>;
};

export function runB4bLocalOffOnSoak(): B4bSoakResult {
  // Representative healthy tip-setup when both reads fire (from O4 healthy sample tip_area≈64).
  const orderLookupMs = 80;
  const tipsEnabledMs = 64;
  const off = measureCompleteTripB4bWorkload({
    enabled: false,
    orderLookupMs,
    tipsEnabledMs,
    bothRequired: true,
  });
  const on = measureCompleteTripB4bWorkload({
    enabled: true,
    orderLookupMs,
    tipsEnabledMs,
    bothRequired: true,
  });
  const onlyArea = measureCompleteTripB4bWorkload({
    enabled: true,
    orderLookupMs: 0,
    tipsEnabledMs: 64,
    bothRequired: false,
  });

  const checks = {
    both_required_gate: shouldParalleliseTipSetupReads({
      needsOrderLookup: true,
      canReadTipsEnabled: true,
    }) === true,
    no_parallel_when_order_present: shouldParalleliseTipSetupReads({
      needsOrderLookup: false,
      canReadTipsEnabled: true,
    }) === false,
    query_count_unchanged: off.query_count === on.query_count && on.query_count === 2,
    wall_saves_min_of_pair: on.wall_ms === Math.max(orderLookupMs, tipsEnabledMs),
    sequential_is_sum: off.wall_ms === orderLookupMs + tipsEnabledMs,
    area_only_unchanged: onlyArea.wall_ms === 64 && onlyArea.query_count === 1,
  };

  return {
    all_pass: Object.values(checks).every(Boolean),
    off: { wall_ms: off.wall_ms, query_count: off.query_count },
    on: { wall_ms: on.wall_ms, query_count: on.query_count },
    savings_ms: off.wall_ms - on.wall_ms,
    checks,
  };
}

if (import.meta.main) {
  const result = runB4bLocalOffOnSoak();
  console.log(JSON.stringify(result, null, 2));
  if (!result.all_pass) Deno.exit(1);
}
