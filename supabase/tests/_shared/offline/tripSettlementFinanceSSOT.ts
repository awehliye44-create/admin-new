/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Settlement finance SSOT — customer paid / cash collected / driver net display.
 * Driver Net: TRIP_EARNING_NET ledger first, trips.driver_net_pence second — never fare − commission.
 */

import {
  computeDriverProviderTransferAmountPence,
} from "../../../functions/_shared/cardCaptureRecoveryTransferSSOT.ts";


/** Captured amount for audit — payments.captured_amount_pence primary, trips.capture_amount_pence fallback. */
export function getTripCapturedPenceForAudit(args: {
  paymentCapturedPence?: number | null;
  tripCaptureAmountPence?: number | null;
}): number | null {
  // Finance isolation rule: never invent customer capture from trips.capture_amount_pence.
  // Only Payment Sessions capture evidence may populate "captured" for audit.
  if (args.paymentCapturedPence != null && args.paymentCapturedPence > 0) {
    return args.paymentCapturedPence;
  }
  return null;
}

export * from "../../../functions/_shared/tripSettlementFinanceSSOT.ts";
