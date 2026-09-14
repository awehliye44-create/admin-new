/**
 * Display breakdown for admin-get-trip-payment-state.
 *
 * Pages must render these fields. They must not invent customer payable or
 * outstanding by adding fare + tip + airport on top of a total the SSOT
 * already returned.
 *
 * Does not change how payable or outstanding are calculated. Callers pass
 * the payment-state totals through.
 */

function nonNegPence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function hasFinitePence(value: unknown): boolean {
  return value != null && value !== '' && Number.isFinite(Number(value));
}

export type PaymentStateMoneyBreakdownInput = {
  /** Ride fare stamp. Never the customer payable total. */
  farePence?: number | null;
  /** Tip already inside customer payable. Display only — never added again. */
  tipPence?: number | null;
  /** Airport / pass-through already inside customer payable. Display only. */
  airportChargePence?: number | null;
  /** Other non-commissionable pass-through already inside customer payable. */
  otherPassThroughPence?: number | null;
  /** Payment-state customer payable. Used as-is. Never fare + tip. */
  customerPayablePence?: number | null;
  verifiedCapturedPence?: number | null;
  verifiedRefundedPence?: number | null;
  /** Payment-state outstanding. Preferred over payable − captured. */
  outstandingShortfallPence?: number | null;
  /** trips.outstanding_balance_pence. Guard only — never a charge amount. */
  storedOutstandingBalancePence?: number | null;
  commissionableFarePence?: number | null;
};

export type PaymentStateMoneyBreakdown = {
  fare_pence: number;
  tip_pence: number;
  airport_charge_pence: number;
  non_commissionable_total_pence: number;
  customer_payable_pence: number;
  verified_captured_pence: number;
  verified_refunded_pence: number;
  verified_net_charged_pence: number;
  outstanding_shortfall_pence: number;
  commissionable_fare_pence: number;
  show_recapture: boolean;
};

/**
 * Recapture is allowed only from payment-state outstanding.
 * A locally recomputed shortfall is ignored even if it is positive.
 */
export function recaptureAllowedFromSsotOutstanding(
  ssotOutstandingPence: number | null | undefined,
  _locallyRecomputedShortfallPence?: number | null,
): boolean {
  if (!hasFinitePence(ssotOutstandingPence)) return false;
  return nonNegPence(ssotOutstandingPence) > 0;
}

export function buildPaymentStateMoneyBreakdown(
  input: PaymentStateMoneyBreakdownInput,
): PaymentStateMoneyBreakdown {
  const farePence = nonNegPence(input.farePence);
  const tipPence = nonNegPence(input.tipPence);
  const airportChargePence = nonNegPence(input.airportChargePence);
  const otherPassThroughPence = nonNegPence(input.otherPassThroughPence);
  const customerPayablePence = nonNegPence(input.customerPayablePence);
  const verifiedCapturedPence = nonNegPence(input.verifiedCapturedPence);
  const verifiedRefundedPence = nonNegPence(input.verifiedRefundedPence);
  const verifiedNetChargedPence = Math.max(0, verifiedCapturedPence - verifiedRefundedPence);

  const outstandingShortfallPence = hasFinitePence(input.outstandingShortfallPence)
    ? nonNegPence(input.outstandingShortfallPence)
    : (hasFinitePence(input.customerPayablePence) && hasFinitePence(input.verifiedCapturedPence)
      ? Math.max(0, customerPayablePence - verifiedNetChargedPence)
      : 0);

  const storedIsZero = hasFinitePence(input.storedOutstandingBalancePence)
    && nonNegPence(input.storedOutstandingBalancePence) === 0;
  const showRecapture = recaptureAllowedFromSsotOutstanding(outstandingShortfallPence)
    && !(storedIsZero && outstandingShortfallPence === 0);

  const commissionableFarePence = hasFinitePence(input.commissionableFarePence)
    ? nonNegPence(input.commissionableFarePence)
    : farePence;

  return {
    fare_pence: farePence,
    tip_pence: tipPence,
    airport_charge_pence: airportChargePence,
    non_commissionable_total_pence: tipPence + airportChargePence + otherPassThroughPence,
    customer_payable_pence: customerPayablePence,
    verified_captured_pence: verifiedCapturedPence,
    verified_refunded_pence: verifiedRefundedPence,
    verified_net_charged_pence: verifiedNetChargedPence,
    outstanding_shortfall_pence: outstandingShortfallPence,
    commissionable_fare_pence: commissionableFarePence,
    show_recapture: showRecapture,
  };
}
