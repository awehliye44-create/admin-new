/** Offline test/audit-only helpers; not part of Edge uploads. */


/**
 * Isolated OFF/ON wall model for identical tip-read workloads (no I/O).
 * Sequential = sum; parallel = max(order, area).
 */
export function measureCompleteTripB4bWorkload(params: {
  enabled: boolean;
  orderLookupMs: number;
  tipsEnabledMs: number;
  /** When false, only the tips_enabled read runs (no parallel opportunity). */
  bothRequired: boolean;
}): { wall_ms: number; query_count: number; parallel: boolean } {
  if (!params.bothRequired) {
    return {
      wall_ms: Math.max(0, params.tipsEnabledMs),
      query_count: params.tipsEnabledMs > 0 ? 1 : 0,
      parallel: false,
    };
  }
  const o = Math.max(0, params.orderLookupMs);
  const a = Math.max(0, params.tipsEnabledMs);
  if (params.enabled) {
    return { wall_ms: Math.max(o, a), query_count: 2, parallel: true };
  }
  return { wall_ms: o + a, query_count: 2, parallel: false };
}

export * from "../../../functions/_shared/completeTripB4bSSOT.ts";
