/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Admin HELD release actions — Assign / Make Available / Broadcast Now|At.
 * One pending action per trip. T−urgent convert must clear pending first.
 *
 * Make Available in Scheduled Jobs ≠ Broadcast:
 * - Make Available → publish for advance PRE-CONFIRMATION (Scheduled Jobs list)
 * - Broadcast → open NRO / auto-dispatch path now (or At via pending_release)
 */

import {
  buildScheduledUrgentConversionPatch,
  resolveConversionBroadcastEnabled,
} from "../../../functions/_shared/scheduledDispatchConfig.ts";
import { clearPendingReleasePatch } from "../../../functions/_shared/scheduledAdminReleaseSSOT.ts";


/** Assign Now — pre-confirm driver; leave trip scheduled (not live). */
export function buildAssignNowPatch(input: {
  driverId: string;
  nowIso: string;
}): Record<string, unknown> {
  return {
    confirmed_driver_id: input.driverId,
    scheduled_status: "driver_assigned",
    scheduled_accepted_at: input.nowIso,
    // Keep list-only trip status — do not flip into live searching/en_route.
    status: "scheduled",
    // Never stamp live driver_id on pre-confirm — activation NRO Accept does that.
    driver_id: null,
    ...clearPendingReleasePatch(),
  };
}

export * from "../../../functions/_shared/scheduledAdminReleaseSSOT.ts";
