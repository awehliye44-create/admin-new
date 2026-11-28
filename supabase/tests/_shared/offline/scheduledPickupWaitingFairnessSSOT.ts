/** Offline test/audit-only helpers; not part of Edge uploads. */
import { resolveScheduledPickupEligibleFromMs } from "../../../functions/_shared/scheduledPickupWaitingFairnessSSOT.ts";


/** True while now is strictly before the eligible pickup waiting floor. */
export function isBeforeScheduledPickupEligibleWindow(input: {
  nowMs: number;
  arrivedAtIso?: string | null;
  scheduledAtIso?: string | null;
  isScheduledOrigin?: boolean | null;
}): boolean {
  const fromMs = resolveScheduledPickupEligibleFromMs(input);
  if (fromMs == null || !Number.isFinite(input.nowMs)) return false;
  return input.nowMs < fromMs;
}

export * from "../../../functions/_shared/scheduledPickupWaitingFairnessSSOT.ts";
