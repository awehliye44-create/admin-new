/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Waiting-time geofence segment clock.
 *
 * Workflow buttons stay flexible. Money counts only while trusted driver GPS
 * is inside the relevant pickup/stop radius. Request-body coords cannot
 * override a trusted outside fix.
 */

import { computePickupWaitingChargePence } from "../../../functions/_shared/waitingAdminConfig.ts";
import { WaitingSegmentRow, sumSegmentSecondsAt } from "../../../functions/_shared/waitingSegmentClock.ts";


export function segmentDurationSeconds(
  startedAtIso: string,
  endedAtIso: string | null,
  nowMs: number,
): number {
  const start = Date.parse(startedAtIso);
  if (!Number.isFinite(start)) return 0;
  const end = endedAtIso ? Date.parse(endedAtIso) : nowMs;
  if (!Number.isFinite(end) || end < start) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}


export function sumSegmentSeconds(
  rows: WaitingSegmentRow[],
  nowMs: number,
  eligibleFromMs?: number | null,
): number {
  return sumSegmentSecondsAt(rows, nowMs, eligibleFromMs);
}

export * from "../../../functions/_shared/waitingSegmentClock.ts";
