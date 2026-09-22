/**
 * Edge mirror of scheduled rides urgent-fallback gate.
 * Keep in sync with shared/scheduledRidesPolicySSOT.ts#shouldUseUrgentFallbackTrigger.
 *
 * - No pre-confirmed driver → urgent fallback + response window → wave dispatch
 * - Confirmed driver → Local/Long fixed T-minute activation NRO (never urgent convert)
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
