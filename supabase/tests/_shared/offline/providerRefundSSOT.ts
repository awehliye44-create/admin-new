/** Offline test/audit-only helpers; not part of Edge uploads. */
import { applyRefundToTripAmounts } from "../../../functions/_shared/providerRefundSSOT.ts";


/** Driver reversal delta for one refund event (cumulative after minus cumulative before). */
export function computeRefundEventDriverReversalDelta(args: {
  capturedPence: number;
  priorRefundedPence: number;
  cumulativeRefundedPence: number;
  commissionPence: number;
  driverNetPence: number;
}): number {
  const prior = applyRefundToTripAmounts({
    capturedPence: args.capturedPence,
    refundPence: args.priorRefundedPence,
    commissionPence: args.commissionPence,
    driverNetPence: args.driverNetPence,
  });
  const after = applyRefundToTripAmounts({
    capturedPence: args.capturedPence,
    refundPence: args.cumulativeRefundedPence,
    commissionPence: args.commissionPence,
    driverNetPence: args.driverNetPence,
  });
  return Math.max(0, after.driver_reversal_pence - prior.driver_reversal_pence);
}


export function refundDebitDescriptionForProviderRefund(
  providerRefundId: string,
  source: string,
): string {
  return `provider refund reversal (${providerRefundId}) — ${source}`;
}

export * from "../../../functions/_shared/providerRefundSSOT.ts";
