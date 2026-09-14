/**
 * Trip History shortfall amounts from admin-get-trip-payment-state.
 *
 * customer_payable_pence is already the total due (fare + tip + airport +
 * other non-commissionable amounts). Never add tip_pence or airport again.
 * Recapture uses payment-state outstanding only.
 */
import {
  buildPaymentStateMoneyBreakdown,
  type PaymentStateMoneyBreakdown,
} from '../../shared/paymentStateMoneyBreakdownSSOT';

export type TripHistoryPaymentStateShortfallInput = {
  /** Total due from payment-state. Already includes tip and non-commissionable amounts. */
  customerPayablePence?: number | null;
  verifiedCapturedPence?: number | null;
  refundedPence?: number | null;
  /** Authoritative outstanding from admin-get-trip-payment-state.outstanding_pence. */
  paymentStateOutstandingPence?: number | null;
  /** trips.outstanding_balance_pence. Display guard only — never a charge amount. */
  storedOutstandingBalancePence?: number | null;
  farePence?: number | null;
  /**
   * Present on the trip row but already inside customerPayablePence.
   * Display only — never added to payable or outstanding.
   */
  tipPence?: number | null;
  airportChargePence?: number | null;
  otherPassThroughPence?: number | null;
  commissionableFarePence?: number | null;
};

export type TripHistoryPaymentStateShortfall = {
  customerPayablePence: number;
  verifiedCapturedPence: number;
  netCapturedPence: number;
  outstandingShortfallPence: number;
  showRecapture: boolean;
  breakdown: PaymentStateMoneyBreakdown;
};

/**
 * Use payment-state totals as-is. Recapture only when that outstanding is > 0,
 * and never when both stored outstanding and payment-state outstanding are 0.
 */
export function resolveTripHistoryShortfallFromPaymentState(
  input: TripHistoryPaymentStateShortfallInput,
): TripHistoryPaymentStateShortfall {
  const breakdown = buildPaymentStateMoneyBreakdown({
    farePence: input.farePence,
    tipPence: input.tipPence,
    airportChargePence: input.airportChargePence,
    otherPassThroughPence: input.otherPassThroughPence,
    commissionableFarePence: input.commissionableFarePence,
    customerPayablePence: input.customerPayablePence,
    verifiedCapturedPence: input.verifiedCapturedPence,
    verifiedRefundedPence: input.refundedPence,
    outstandingShortfallPence: input.paymentStateOutstandingPence,
    storedOutstandingBalancePence: input.storedOutstandingBalancePence,
  });

  return {
    customerPayablePence: breakdown.customer_payable_pence,
    verifiedCapturedPence: breakdown.verified_captured_pence,
    netCapturedPence: breakdown.verified_net_charged_pence,
    outstandingShortfallPence: breakdown.outstanding_shortfall_pence,
    showRecapture: breakdown.show_recapture,
    breakdown,
  };
}
