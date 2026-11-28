/** Offline test/audit-only helpers; not part of Edge uploads. */
import { normalizePassengerOverlapTripStatus, PASSENGER_OVERLAP_TERMINAL_TRIP_STATUSES } from "../../../functions/_shared/passengerBookingOverlapLifecycleSSOT.ts";


/** Inverse — terminal lifecycle → immediately ineligible for overlap. */
export function isPassengerOverlapTerminalTripStatus(
  status: string | null | undefined,
): boolean {
  const s = normalizePassengerOverlapTripStatus(status);
  if (!s) return true;
  return PASSENGER_OVERLAP_TERMINAL_TRIP_STATUSES.has(s);
}

export * from "../../../functions/_shared/passengerBookingOverlapLifecycleSSOT.ts";
