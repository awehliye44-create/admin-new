/**
 * Edge mirror of scheduled rides urgent-fallback gate.
 * Keep in sync with shared/scheduledRidesPolicySSOT.ts#shouldUseUrgentFallbackTrigger.
 *
 * Admin Two paths:
 * - No pre-confirmed driver → urgent fallback + response window → wave dispatch
 * - Confirmed driver → Commitment Policy only (never fixed urgent trigger)
 */
export function shouldUseUrgentFallbackTrigger(input: {
  confirmedDriverId?: string | null;
  enableScheduledToUrgentConversion?: boolean;
}): boolean {
  if (input.enableScheduledToUrgentConversion === false) return false;
  const id = input.confirmedDriverId;
  if (typeof id === "string" && id.trim().length > 0) return false;
  return true;
}
