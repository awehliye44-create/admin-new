/**
 * Trusted tip for finalize-trip-and-capture.
 * Body tip is only authoritative for submit_customer_trip_tip.
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
  return Math.max(
    0,
    Math.round(
      Number(args.trip.tip_amount_pence ?? args.trip.tip_pence ?? 0) || 0,
    ),
  );
}
