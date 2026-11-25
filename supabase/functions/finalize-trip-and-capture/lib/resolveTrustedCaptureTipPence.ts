/**
 * Trusted tip for finalize-trip-and-capture.
 * Body tip is only authoritative for submit_customer_trip_tip.
 * Deferred fare capture jobs (trip-capture-job) are always fare-only (tip 0) —
 * tip capture stays on submit-customer-trip-tip / tip-window expiry paths.
 * All other callers use tip already persisted on the trip row.
 */

export function resolveTrustedCaptureTipPence(args: {
  source: string;
  bodyTipPence: number;
  trip: Record<string, unknown>;
}): number {
  if (args.source === "submit_customer_trip_tip") {
    return Math.max(0, Math.round(Number(args.bodyTipPence) || 0));
  }
  // Fare-only deferred complete capture — never pull tip from the trip row.
  if (args.source === "trip-capture-job") {
    return 0;
  }
  return Math.max(
    0,
    Math.round(
      Number(args.trip.tip_amount_pence ?? args.trip.tip_pence ?? 0) || 0,
    ),
  );
}
