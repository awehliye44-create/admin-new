/** Offline test/audit-only helpers; not part of Edge uploads. */


/** Overview rollup: fare net + tip (+ airport when a separate allocation leg). */
export function sumFrAllocatedDriverEntitlementPence(args: {
  driver_fare_net_pence: number;
  driver_tips_pence: number;
  airport_charge_pence?: number;
}): number {
  return Math.max(0, Math.round(Number(args.driver_fare_net_pence ?? 0)))
    + Math.max(0, Math.round(Number(args.driver_tips_pence ?? 0)))
    + Math.max(0, Math.round(Number(args.airport_charge_pence ?? 0)));
}

export * from "../../../functions/_shared/frConsumeOnlySSOT.ts";
