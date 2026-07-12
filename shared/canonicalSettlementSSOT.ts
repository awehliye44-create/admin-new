/**
 * Canonical settlement engine (Slice 4) — single formula for all writers.
 *
 * Commissionable:
 *   ride_fare + pickup_waiting + stop_waiting + other_commissionable_extras
 * Non-commissionable only:
 *   airport_charge + tip
 *
 * driver_net (ride portion / wallet TRIP_EARNING base) =
 *   commissionable − onecab_gross_commission
 *
 * driver_total =
 *   driver_net + airport + tip
 *
 * onecab_net =
 *   onecab_gross − provider_processing_fee   (fee unknown → null, never invent £0)
 *
 * Identity:
 *   customer_captured =
 *     driver_net + onecab_gross + airport + tip
 *
 * Waiting stays inside commissionable. Provider fee never reduces driver net.
 * No page may re-implement this formula in React.
 */

export const SETTLEMENT_FORMULA_VERSION = "2";
export const CANONICAL_SETTLEMENT_FORMULA_VERSION = SETTLEMENT_FORMULA_VERSION;
export const MAX_COMMISSION_PERCENT = 15;

export type CanonicalSettlementComponents = {
  ride_fare_pence: number;
  pickup_waiting_charge_pence?: number;
  stop_waiting_charge_pence?: number;
  other_commissionable_extras_pence?: number;
  airport_charge_pence?: number;
  tip_pence?: number;
  commission_percent: number;
  /** Provider-confirmed fee only. Unknown → omit/null (never invent £0). */
  provider_processing_fee_pence?: number | null;
  fee_confirmed?: boolean;
};

export type CanonicalSettlementResult = {
  formula_version: string;
  ride_fare_pence: number;
  pickup_waiting_charge_pence: number;
  stop_waiting_charge_pence: number;
  other_commissionable_extras_pence: number;
  commissionable_fare_pence: number;
  airport_charge_pence: number;
  tip_pence: number;
  non_commissionable_pence: number;
  total_customer_charge_pence: number;
  onecab_gross_commission_pence: number;
  /** Ride-portion driver net (excludes airport + tip). */
  driver_net_pence: number;
  /** Driver total including airport + tip. */
  driver_total_earnings_pence: number;
  provider_processing_fee_pence: number | null;
  /** Null when fee not confirmed — never invent net = gross. */
  onecab_net_commission_pence: number | null;
  commission_percent: number;
  capture_identity_balanced: boolean;
  capture_identity_variance_pence: number;
};

function nonNeg(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

export function capTierCommissionPercent(percent: number): number {
  const n = Number(percent);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_COMMISSION_PERCENT, n);
}

/**
 * Settlement identity (pence):
 * captured = driver_net + gross_commission + airport + tips
 */
export function assertSettlementCaptureIdentity(args: {
  captured_pence: number;
  driver_net_pence: number;
  commission_pence: number;
  airport_charge_pence: number;
  tips_pence: number;
}): { balanced: boolean; variance_pence: number } {
  const rhs =
    Math.max(0, args.driver_net_pence)
    + Math.max(0, args.commission_pence)
    + Math.max(0, args.airport_charge_pence)
    + Math.max(0, args.tips_pence);
  const variance = Math.max(0, args.captured_pence) - rhs;
  return { balanced: variance === 0, variance_pence: variance };
}

export function commissionableFromComponents(args: {
  ride_fare_pence: number;
  pickup_waiting_charge_pence?: number;
  stop_waiting_charge_pence?: number;
  other_commissionable_extras_pence?: number;
}): number {
  return (
    nonNeg(args.ride_fare_pence)
    + nonNeg(args.pickup_waiting_charge_pence)
    + nonNeg(args.stop_waiting_charge_pence)
    + nonNeg(args.other_commissionable_extras_pence)
  );
}

/**
 * Commissionable from captured customer money (FR consume helper).
 * v2: do NOT strip pass-through — it is commissionable when inside capture.
 */
export function commissionableFromCapturedPence(args: {
  capturedPence: number;
  tipPence?: number;
  airportPence?: number;
  refundedPence?: number;
}): number {
  return Math.max(
    0,
    nonNeg(args.capturedPence)
      - nonNeg(args.tipPence)
      - nonNeg(args.airportPence)
      - nonNeg(args.refundedPence),
  );
}

/**
 * Canonical settlement from explicit components (Slice 4 contract).
 */
export function calculateCanonicalSettlement(
  input: CanonicalSettlementComponents,
): CanonicalSettlementResult {
  const ride = nonNeg(input.ride_fare_pence);
  const pickupWaiting = nonNeg(input.pickup_waiting_charge_pence);
  const stopWaiting = nonNeg(input.stop_waiting_charge_pence);
  const otherExtras = nonNeg(input.other_commissionable_extras_pence);
  const airport = nonNeg(input.airport_charge_pence);
  const tip = nonNeg(input.tip_pence);
  const tier = capTierCommissionPercent(input.commission_percent);

  const commissionable = commissionableFromComponents({
    ride_fare_pence: ride,
    pickup_waiting_charge_pence: pickupWaiting,
    stop_waiting_charge_pence: stopWaiting,
    other_commissionable_extras_pence: otherExtras,
  });

  const onecabGross = Math.round((commissionable * tier) / 100);
  const driverNet = Math.max(0, commissionable - onecabGross);
  const driverTotal = driverNet + airport + tip;

  const feeConfirmed = input.fee_confirmed === true
    || (
      input.provider_processing_fee_pence != null
      && Number.isFinite(Number(input.provider_processing_fee_pence))
      && Number(input.provider_processing_fee_pence) > 0
    );
  const fee = feeConfirmed
    ? Math.max(0, Math.round(Number(input.provider_processing_fee_pence)))
    : null;
  const onecabNet = fee != null ? Math.max(0, onecabGross - fee) : null;

  const totalCustomer = commissionable + airport + tip;
  const identity = assertSettlementCaptureIdentity({
    captured_pence: totalCustomer,
    driver_net_pence: driverNet,
    commission_pence: onecabGross,
    airport_charge_pence: airport,
    tips_pence: tip,
  });

  return {
    formula_version: SETTLEMENT_FORMULA_VERSION,
    ride_fare_pence: ride,
    pickup_waiting_charge_pence: pickupWaiting,
    stop_waiting_charge_pence: stopWaiting,
    other_commissionable_extras_pence: otherExtras,
    commissionable_fare_pence: commissionable,
    airport_charge_pence: airport,
    tip_pence: tip,
    non_commissionable_pence: airport + tip,
    total_customer_charge_pence: totalCustomer,
    onecab_gross_commission_pence: onecabGross,
    driver_net_pence: driverNet,
    driver_total_earnings_pence: driverTotal,
    provider_processing_fee_pence: fee,
    onecab_net_commission_pence: onecabNet,
    commission_percent: tier,
    capture_identity_balanced: identity.balanced,
    capture_identity_variance_pence: identity.variance_pence,
  };
}

/** Golden fixtures for accepted money truth (Slice 4 acceptance). */
export const CANONICAL_SETTLEMENT_GOLDEN_TRIPS = [
  {
    trip_code: "MK-260708-007",
    ride_fare_pence: 480,
    pickup_waiting_charge_pence: 0,
    stop_waiting_charge_pence: 0,
    airport_charge_pence: 0,
    tip_pence: 0,
    commission_percent: 15,
    provider_processing_fee_pence: 25,
    expected: {
      captured_pence: 480,
      commissionable_fare_pence: 480,
      onecab_gross_commission_pence: 72,
      driver_net_pence: 408,
      onecab_net_commission_pence: 47,
    },
  },
  {
    trip_code: "MK-260708-008",
    /** Base ride + waiting inside commissionable (680 + 18). */
    ride_fare_pence: 680,
    pickup_waiting_charge_pence: 18,
    stop_waiting_charge_pence: 0,
    airport_charge_pence: 0,
    tip_pence: 0,
    commission_percent: 15,
    provider_processing_fee_pence: 27,
    expected: {
      captured_pence: 698,
      commissionable_fare_pence: 698,
      onecab_gross_commission_pence: 105,
      driver_net_pence: 593,
      onecab_net_commission_pence: 78,
    },
  },
  {
    trip_code: "MK-260709-010",
    ride_fare_pence: 480,
    pickup_waiting_charge_pence: 0,
    stop_waiting_charge_pence: 0,
    airport_charge_pence: 0,
    tip_pence: 0,
    commission_percent: 15,
    provider_processing_fee_pence: 25,
    expected: {
      captured_pence: 480,
      commissionable_fare_pence: 480,
      onecab_gross_commission_pence: 72,
      driver_net_pence: 408,
      onecab_net_commission_pence: 47,
    },
  },
] as const;

export const CANONICAL_SETTLEMENT_GOLDEN_TOTALS = {
  captured_pence: 1658,
  onecab_gross_commission_pence: 249,
  provider_processing_fee_pence: 77,
  onecab_net_commission_pence: 172,
  driver_net_pence: 1409,
} as const;
