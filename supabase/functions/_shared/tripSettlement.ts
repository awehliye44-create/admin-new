/**
 * Trip settlement — SINGLE SOURCE OF TRUTH for commission / driver net / platform revenue.
 *
 * All settlement writers (trip complete, negotiation accept, admin fare edit, provider
 * webhook recovery, capture) must use calculateTripSettlement().
 *
 * Formula v2 / Slice 4 (waiting commissionable):
 *   commissionable = final_fare − airport_charge
 *   (waiting / stop waiting / commissionable extras stay inside final_fare)
 *   Non-commissionable ONLY: airport charges + driver tips
 *   tips are usually outside final_fare and added to driver_total only
 *
 * Explicit component API + golden fixtures: shared/canonicalSettlementSSOT.ts
 * Identity: captured = driver_net + gross_commission + airport + tips
 * Provider fee reduces ONECAB net only (never driver_net).
 */

export const SETTLEMENT_FORMULA_VERSION = "2";

/** Sanity ceiling for commission % (wave/base rates may exceed legacy 15% tier caps). */
export const MAX_COMMISSION_PERCENT = 100;

export type TripSettlementInput = {
  /** Customer trip fare including waiting and commissionable extras; tips usually excluded. */
  final_fare_pence: number;
  airport_charge_pence?: number;
  /**
   * @deprecated v2 — pass-through is commissionable when inside final_fare.
   * Kept for call-site compat; ignored for commissionable math.
   */
  other_pass_through_charges_pence?: number;
  tips_pence?: number;
  driver_tier_commission_percent: number;
  provider_fee_pence?: number;
};

export type TripSettlementResult = {
  final_fare_pence: number;
  commissionable_fare_pence: number;
  commission_pence: number;
  driver_net_pence: number;
  driver_total_earnings_pence: number;
  airport_charge_pence: number;
  other_pass_through_charges_pence: number;
  tips_pence: number;
  provider_fee_pence: number;
  platform_gross_revenue_pence: number;
  platform_net_revenue_pence: number;
  tier_percent_used: number;
  formula_version: string;
};

export type TripSettlementTripRow = {
  final_fare_pence?: number | null;
  capture_amount_pence?: number | null;
  final_customer_fare_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  waiting_charge_pence?: number | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  /** Preferred: snapshotted at offer accept (wave commission). */
  accepted_commission_percent?: number | null;
  driver_tier_commission_percent?: number | null;
  commission_pct?: number | null;
  driver_net_pence?: number | null;
  provider_fee_pence?: number | null;
};

function nonNegInt(value: unknown): number {
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
 * Resolve the fare base that must include waiting when present.
 * Prefer capture → final_fare → final_customer + waiting.
 */
export function resolveSettlementFinalFarePence(trip: TripSettlementTripRow): number {
  const capture = nonNegInt(trip.capture_amount_pence);
  const tips = nonNegInt(trip.tip_pence ?? trip.tip_amount_pence);
  // Capture may include tips — strip tips for fare settlement base when tips are separate.
  const captureFare = capture > 0 ? Math.max(0, capture - tips) : 0;
  const finalFare = nonNegInt(trip.final_fare_pence);
  const waiting =
    nonNegInt(trip.pickup_waiting_charge_pence)
    + nonNegInt(trip.stop_waiting_charge_pence)
    || nonNegInt(trip.total_waiting_charge_pence)
    || nonNegInt(trip.waiting_charge_pence);
  const customerPlusWaiting = nonNegInt(trip.final_customer_fare_pence) + waiting;
  return Math.max(captureFare, finalFare, customerPlusWaiting);
}

/**
 * Canonical settlement formula owner (v2).
 * Waiting must already be inside final_fare_pence (or resolved via resolveSettlementFinalFarePence).
 */
export function calculateTripSettlement(input: TripSettlementInput): TripSettlementResult {
  const finalFarePence = nonNegInt(input.final_fare_pence);
  const airportChargePence = nonNegInt(input.airport_charge_pence);
  // v2: pass-through is commissionable when present in final_fare — do not strip.
  const otherPassThroughChargesPence = 0;
  const tipsPence = nonNegInt(input.tips_pence);
  const providerFeePence = nonNegInt(input.provider_fee_pence);
  const tierPercentUsed = capTierCommissionPercent(input.driver_tier_commission_percent);

  // Non-commissionable ONLY: airport (tips sit outside final_fare).
  const commissionableFarePence = Math.max(0, finalFarePence - airportChargePence);

  const commissionPence = Math.round((commissionableFarePence * tierPercentUsed) / 100);
  const driverNetPence = Math.max(0, commissionableFarePence - commissionPence);
  const driverTotalEarningsPence = driverNetPence + airportChargePence + tipsPence;

  const platformGrossRevenuePence = commissionPence;
  const platformNetRevenuePence = Math.max(0, commissionPence - providerFeePence);

  return {
    final_fare_pence: finalFarePence,
    commissionable_fare_pence: commissionableFarePence,
    commission_pence: commissionPence,
    driver_net_pence: driverNetPence,
    driver_total_earnings_pence: driverTotalEarningsPence,
    airport_charge_pence: airportChargePence,
    other_pass_through_charges_pence: otherPassThroughChargesPence,
    tips_pence: tipsPence,
    provider_fee_pence: providerFeePence,
    platform_gross_revenue_pence: platformGrossRevenuePence,
    platform_net_revenue_pence: platformNetRevenuePence,
    tier_percent_used: tierPercentUsed,
    formula_version: SETTLEMENT_FORMULA_VERSION,
  };
}

/** Resolve commission % from a persisted trip row (accepted wave snapshot first). */
export function resolveTripTierPercent(trip: TripSettlementTripRow): number {
  const accepted = trip.accepted_commission_percent;
  if (accepted != null && Number.isFinite(Number(accepted))) {
    return capTierCommissionPercent(Number(accepted));
  }
  const pct = trip.driver_tier_commission_percent ?? trip.commission_pct ?? 0;
  return capTierCommissionPercent(pct);
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

/**
 * Build the trip row used for post-capture / completion settlement.
 * Waiting must remain inside the fare base (never settle from ride-only final_customer).
 */
export function buildSettlementTripRow(args: {
  trip: TripSettlementTripRow & { provider_fee_pence?: number | null };
  captureAmountPence?: number | null;
  tipPence?: number;
  finalFarePence?: number | null;
  pickupWaitingChargePence?: number | null;
  stopWaitingChargePence?: number | null;
}): TripSettlementTripRow {
  const tip = nonNegInt(args.tipPence ?? args.trip.tip_pence ?? args.trip.tip_amount_pence);
  return {
    ...args.trip,
    capture_amount_pence: args.captureAmountPence == null
      ? args.trip.capture_amount_pence
      : args.captureAmountPence,
    tip_pence: tip,
    tip_amount_pence: tip,
    final_fare_pence: args.finalFarePence == null
      ? args.trip.final_fare_pence
      : args.finalFarePence,
    pickup_waiting_charge_pence: args.pickupWaitingChargePence == null
      ? args.trip.pickup_waiting_charge_pence
      : args.pickupWaitingChargePence,
    stop_waiting_charge_pence: args.stopWaitingChargePence == null
      ? args.trip.stop_waiting_charge_pence
      : args.stopWaitingChargePence,
  };
}

/**
 * Card wallet TRIP_EARNING_NET = commissionable net + airport.
 * Tips stay on DRIVER_TIP_CREDIT. Provider fee never enters this amount.
 *
 * Also returns `settlement` so callers can persist the same stamp columns
 * (commissionable / commission / driver_net) that produced the wallet credit.
 */
export function resolveCapturedTripEarningNetPence(args: {
  trip: TripSettlementTripRow & { provider_fee_pence?: number | null };
  captureAmountPence: number;
  tipPence?: number;
}): {
  driverNetPence: number;
  commissionPct: number;
  tipPence: number;
  settlement: TripSettlementResult | null;
} {
  const row = buildSettlementTripRow({
    trip: args.trip,
    captureAmountPence: args.captureAmountPence,
    tipPence: args.tipPence,
  });
  const settlement = calculateTripSettlementFromTripRow(
    row,
    nonNegInt(args.trip.provider_fee_pence),
  );
  if (settlement) {
    return {
      driverNetPence: settlement.driver_net_pence + settlement.airport_charge_pence,
      commissionPct: settlement.tier_percent_used,
      tipPence: settlement.tips_pence,
      settlement,
    };
  }
  return {
    driverNetPence: nonNegInt(args.trip.driver_net_pence) + nonNegInt(args.trip.airport_charge_pence),
    commissionPct: resolveTripTierPercent(row),
    tipPence: nonNegInt(args.tipPence ?? args.trip.tip_pence ?? args.trip.tip_amount_pence),
    settlement: null,
  };
}

/** Settlement from persisted trip fare columns (webhook recovery, backfill, capture). */
export function calculateTripSettlementFromTripRow(
  trip: TripSettlementTripRow,
  providerFeePence = 0,
): TripSettlementResult | null {
  const finalFarePence = resolveSettlementFinalFarePence(trip);
  if (finalFarePence <= 0) return null;

  return calculateTripSettlement({
    final_fare_pence: finalFarePence,
    airport_charge_pence: trip.airport_charge_pence ?? 0,
    tips_pence: trip.tip_pence ?? trip.tip_amount_pence ?? 0,
    driver_tier_commission_percent: resolveTripTierPercent(trip),
    provider_fee_pence: providerFeePence,
  });
}

/** DB columns to persist when settlement is finalized. */
export function tripSettlementDbColumns(
  settlement: TripSettlementResult,
): Record<string, number | string | null> {
  return {
    final_fare_pence: settlement.final_fare_pence,
    commissionable_fare_pence: settlement.commissionable_fare_pence,
    commission_pence: settlement.commission_pence,
    driver_net_pence: settlement.driver_net_pence,
    driver_net_before_tip_pence: settlement.driver_net_pence,
    driver_total_earnings_pence: settlement.driver_total_earnings_pence,
    airport_charge_pence: settlement.airport_charge_pence,
    tip_pence: settlement.tips_pence,
    tip_amount_pence: settlement.tips_pence,
    commission_pct: settlement.tier_percent_used,
    driver_tier_commission_percent: settlement.tier_percent_used,
    gross_fare_pence: settlement.commissionable_fare_pence,
    provider_fee_pence: settlement.provider_fee_pence,
    provider_fee_amount: settlement.provider_fee_pence,
    onecab_net_pence: settlement.platform_net_revenue_pence,
    platform_gross_revenue_pence: settlement.platform_gross_revenue_pence,
    platform_net_revenue_pence: settlement.platform_net_revenue_pence,
    settlement_formula_version: settlement.formula_version,
  };
}

/** fare_snapshot_json settlement keys (never drop values when columns missing). */
export function tripSettlementSnapshotJson(
  settlement: TripSettlementResult,
): Record<string, number | string> {
  return {
    settlement_formula_version: settlement.formula_version,
    commissionable_fare_pence: settlement.commissionable_fare_pence,
    commission_pence: settlement.commission_pence,
    driver_net_pence: settlement.driver_net_pence,
    driver_total_earnings_pence: settlement.driver_total_earnings_pence,
    platform_gross_revenue_pence: settlement.platform_gross_revenue_pence,
    platform_net_revenue_pence: settlement.platform_net_revenue_pence,
    provider_fee_pence: settlement.provider_fee_pence,
    tier_percent_used: settlement.tier_percent_used,
  };
}
