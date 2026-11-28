/**
 * B4-B — Parallel tip_order (payment_sessions) ∥ tips_enabled (service_areas) reads.
 *
 * Default OFF (`COMPLETE_TRIP_B4B` unset/0). When ON and both reads are required,
 * start them together; fail-closed rules unchanged. Never writes money state.
 *
 * Compatible with B4-A RETURNING tip verify (orthogonal stage).
 */

export const COMPLETE_TRIP_B4B_FLAG = "COMPLETE_TRIP_B4B";

function readCompleteTripB4bFlagFromEnv(): string | undefined {
  try {
    if (typeof Deno === "undefined") return undefined;
    return Deno.env.get(COMPLETE_TRIP_B4B_FLAG) ?? undefined;
  } catch {
    return undefined;
  }
}

export function isCompleteTripB4bEnabled(
  raw: string | undefined | null = readCompleteTripB4bFlagFromEnv(),
): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** True when both independent tip setup reads would run on this request. */
export function shouldParalleliseTipSetupReads(args: {
  needsOrderLookup: boolean;
  canReadTipsEnabled: boolean;
}): boolean {
  return Boolean(args.needsOrderLookup && args.canReadTipsEnabled);
}
