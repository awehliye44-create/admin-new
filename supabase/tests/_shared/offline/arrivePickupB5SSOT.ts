/** Offline test/audit-only helpers; not part of Edge uploads. */
import { shouldSkipPostWaitingTripSelect } from "../../../functions/_shared/arrivePickupB5SSOT.ts";


/** Isolated OFF/ON: count confirm SELECTs for identical Arrive outcomes. */
export function measureArrivePickupB5Workload(params: {
  enabled: boolean;
  cases: Array<{
    waitingStartedAt: string | null;
    tripWaitingStartedAt: string | null;
  }>;
}): { confirm_selects: number; skipped: number } {
  let confirm_selects = 0;
  let skipped = 0;
  for (const c of params.cases) {
    if (
      shouldSkipPostWaitingTripSelect({
        b5Enabled: params.enabled,
        waitingStartedAt: c.waitingStartedAt,
        tripWaitingStartedAt: c.tripWaitingStartedAt,
      })
    ) {
      skipped += 1;
    } else {
      confirm_selects += 1;
    }
  }
  return { confirm_selects, skipped };
}

export * from "../../../functions/_shared/arrivePickupB5SSOT.ts";
