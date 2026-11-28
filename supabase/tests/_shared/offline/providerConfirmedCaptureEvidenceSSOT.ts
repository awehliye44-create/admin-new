/** Offline test/audit-only helpers; not part of Edge uploads. */


/**
 * Required same-order authorisation total for a fare-increasing modification.
 * Route payable (new_fare) plus accumulated waiting, preferring the preview
 * new_customer_total when present.
 */
export function resolveModificationRequiredAuthorisationPence(args: {
  newFarePence: number;
  pickupWaitingChargePence?: number | null;
  stopWaitingChargePence?: number | null;
  /** Prefer after_route_snapshot.fare_preview.new_customer_total_pence. */
  newCustomerTotalPence?: number | null;
}): number {
  const route = Math.max(0, Math.round(Number(args.newFarePence) || 0));
  const waiting =
    Math.max(0, Math.round(Number(args.pickupWaitingChargePence) || 0)) +
    Math.max(0, Math.round(Number(args.stopWaitingChargePence) || 0));
  const preview = Math.max(0, Math.round(Number(args.newCustomerTotalPence) || 0));
  return Math.max(route + waiting, preview, route);
}

export * from "../../../functions/_shared/providerConfirmedCaptureEvidenceSSOT.ts";
