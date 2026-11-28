/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Shared pre-activation scheduled assignment release (Bug #22 + compliance).
 *
 * When a confirmed driver drops before JIT activation and before the unclaimed
 * urgent conversion deadline, reopen Requested marketplace — Make Available
 * shaped — never stamp Finding/instant (`offered` / `searching` / convert).
 */

import {
  buildMakeAvailableScheduledJobsPatch,
  buildBroadcastNowPatch,
} from "../../../functions/_shared/scheduledAdminReleaseSSOT.ts";

import { shouldUseUrgentRescueForComplianceRelease } from "../../../functions/_shared/scheduledJourneyComplianceSSOT.ts";
import { ScheduledPreActivationReleaseKind, shouldUrgentConvertOnPreActivationRelease } from "../../../functions/_shared/scheduledPreActivationReleaseSSOT.ts";


export function resolvePreActivationReleaseKind(input: {
  scheduledAtIso: string;
  nowMs?: number;
  urgentTriggerMinutesBeforePickup?: number;
  broadcastEnabled?: boolean | null;
}): ScheduledPreActivationReleaseKind {
  const urgent = shouldUrgentConvertOnPreActivationRelease({
    scheduledAtIso: input.scheduledAtIso,
    nowMs: input.nowMs,
    urgentTriggerMinutesBeforePickup: input.urgentTriggerMinutesBeforePickup,
  });
  if (urgent && input.broadcastEnabled !== false) return "urgent_convert";
  return "marketplace_reopen";
}

export * from "../../../functions/_shared/scheduledPreActivationReleaseSSOT.ts";
