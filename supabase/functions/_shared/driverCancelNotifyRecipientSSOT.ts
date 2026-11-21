/**
 * #66 — Authoritative recipient for cancel-flavoured Driver "Trip cancelled" push.
 *
 * Live assignment only (`confirmed_driver_id` ?? `driver_id`).
 * Never `previous_driver_id`, historical offers, or rematch-released IDs.
 *
 * Rematch / driver-cancel-before-pickup writes the released driver onto
 * `previous_driver_id` + `cancelled_driver_ids` / `excluded_driver_ids` while
 * clearing live assignment. Admin/customer cancel while broadcasting must not
 * notify that released driver.
 */

export type CancelNotifyTripAssignment = {
  confirmed_driver_id?: string | null;
  driver_id?: string | null;
  previous_driver_id?: string | null;
  cancelled_driver_ids?: string[] | null;
  excluded_driver_ids?: string[] | null;
};

function asId(value: unknown): string | null {
  const id = String(value ?? "").trim();
  return id.length > 0 ? id : null;
}

function idListContains(
  list: string[] | null | undefined,
  driverId: string,
): boolean {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.some((entry) => asId(entry) === driverId);
}

/**
 * Current assignment identity for cancel notify — mirrors communication SSOT.
 * Explicitly ignores `previous_driver_id`.
 */
export function resolveCancelNotifyAssignedDriverId(
  trip: CancelNotifyTripAssignment,
): string | null {
  const confirmed = asId(trip.confirmed_driver_id);
  if (confirmed) return confirmed;
  return asId(trip.driver_id);
}

/**
 * Whether `driverId` may receive a cancel-flavoured Trip Cancelled push for
 * this trip. Used at enqueue (cancel Edges) and at send-time (queued retries).
 *
 * Allow when:
 * - Driver is the live assigned driver, OR
 * - Trip has no live assignment but `previous_driver_id` matches and the driver
 *   was NOT rematch-released (`cancelled_driver_ids` / `excluded_driver_ids`).
 *
 * The second branch covers delayed delivery after terminal cancel cleared /
 * preserved assignment onto `previous_driver_id` without a rematch release.
 */
export function isDriverEligibleForCancelTripNotify(
  trip: CancelNotifyTripAssignment,
  driverId: string | null | undefined,
): boolean {
  const target = asId(driverId);
  if (!target) return false;

  const live = resolveCancelNotifyAssignedDriverId(trip);
  if (live === target) return true;

  // Rematch-released / permanently excluded — never cancel-notify.
  if (
    idListContains(trip.cancelled_driver_ids, target) ||
    idListContains(trip.excluded_driver_ids, target)
  ) {
    return false;
  }

  // Delayed delivery after terminal clear: previous_driver_id may be the only
  // remaining identity, but only when the driver was not rematch-released.
  if (live == null && asId(trip.previous_driver_id) === target) {
    return true;
  }

  return false;
}
