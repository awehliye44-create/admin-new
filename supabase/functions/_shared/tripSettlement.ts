/**
 * Trip settlement — SINGLE SOURCE OF TRUTH for commission / driver net / platform revenue.
 *
 * All settlement writers (trip complete, negotiation accept, admin fare edit, Stripe
 * webhook recovery, capture) must use calculateTripSettlement().
 */

export const SETTLEMENT_FORMULA_VERSION = "1";

export const MAX_COMMISSION_PERCENT = 15;

export type TripSettlementInput = {
  final_fare_pence: number;
  airport_charge_pence?: number;
  other_pass_through_charges_pence?: number;
  tips_pence?: number;
  driver_tier_commission_percent: number;
  stripe_fee_pence?: number;
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
  stripe_fee_pence: number;
  platform_gross_revenue_pence: number;
  platform_net_revenue_pence: number;
  tier_percent_used: number;
  formula_version: string;
};

export type TripSettlementTripRow = {
  final_fare_pence?: number | null;
  airport_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  driver_tier_commission_percent?: number | null;
  commission_pct?: number | null;
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
 * Canonical settlement formula owner.
 */
export function calculateTripSettlement(input: TripSettlementInput): TripSettlementResult {
  const finalFarePence = nonNegInt(input.final_fare_pence);
  const airportChargePence = nonNegInt(input.airport_charge_pence);
  const otherPassThroughChargesPence = nonNegInt(input.other_pass_through_charges_pence);
  const tipsPence = nonNegInt(input.tips_pence);
  const stripeFeePence = nonNegInt(input.stripe_fee_pence);
  const tierPercentUsed = capTierCommissionPercent(input.driver_tier_commission_percent);

  const commissionableFarePence = Math.max(
    0,
    finalFarePence - airportChargePence - otherPassThroughChargesPence,
  );

  const commissionPence = Math.round((commissionableFarePence * tierPercentUsed) / 100);
  const driverNetPence = Math.max(0, commissionableFarePence - commissionPence);
  const driverTotalEarningsPence =
    driverNetPence + airportChargePence + otherPassThroughChargesPence + tipsPence;

  const platformGrossRevenuePence = commissionPence;
  const platformNetRevenuePence = Math.max(0, commissionPence - stripeFeePence);

  return {
    final_fare_pence: finalFarePence,
    commissionable_fare_pence: commissionableFarePence,
    commission_pence: commissionPence,
    driver_net_pence: driverNetPence,
    driver_total_earnings_pence: driverTotalEarningsPence,
    airport_charge_pence: airportChargePence,
    other_pass_through_charges_pence: otherPassThroughChargesPence,
    tips_pence: tipsPence,
    stripe_fee_pence: stripeFeePence,
    platform_gross_revenue_pence: platformGrossRevenuePence,
    platform_net_revenue_pence: platformNetRevenuePence,
    tier_percent_used: tierPercentUsed,
    formula_version: SETTLEMENT_FORMULA_VERSION,
  };
}

/** Resolve tier % from a persisted trip row. */
export function resolveTripTierPercent(trip: TripSettlementTripRow): number {
  const pct = trip.driver_tier_commission_percent ?? trip.commission_pct ?? 0;
  return capTierCommissionPercent(pct);
}

/** Settlement from persisted trip fare columns (webhook recovery, backfill). */
export function calculateTripSettlementFromTripRow(
  trip: TripSettlementTripRow,
  stripeFeePence = 0,
): TripSettlementResult | null {
  const finalFarePence = nonNegInt(trip.final_fare_pence);
  if (finalFarePence <= 0) return null;

  return calculateTripSettlement({
    final_fare_pence: finalFarePence,
    airport_charge_pence: trip.airport_charge_pence ?? 0,
    other_pass_through_charges_pence: trip.other_pass_through_charges_pence ?? 0,
    tips_pence: trip.tip_pence ?? trip.tip_amount_pence ?? 0,
    driver_tier_commission_percent: resolveTripTierPercent(trip),
    stripe_fee_pence: stripeFeePence,
  });
}

/** DB columns to persist when settlement is finalized. */
export function tripSettlementDbColumns(
  settlement: TripSettlementResult,
): Record<string, number | string> {
  return {
    final_fare_pence: settlement.final_fare_pence,
    commissionable_fare_pence: settlement.commissionable_fare_pence,
    commission_pence: settlement.commission_pence,
    driver_net_pence: settlement.driver_net_pence,
    driver_net_before_tip_pence: settlement.driver_net_pence,
    driver_total_earnings_pence: settlement.driver_total_earnings_pence,
    airport_charge_pence: settlement.airport_charge_pence,
    other_pass_through_charges_pence: settlement.other_pass_through_charges_pence,
    tip_pence: settlement.tips_pence,
    tip_amount_pence: settlement.tips_pence,
    commission_pct: settlement.tier_percent_used,
    driver_tier_commission_percent: settlement.tier_percent_used,
    gross_fare_pence: settlement.commissionable_fare_pence,
    stripe_processing_fee_pence: settlement.stripe_fee_pence,
    stripe_fee_amount: settlement.stripe_fee_pence,
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
    stripe_fee_pence: settlement.stripe_fee_pence,
    tier_percent_used: settlement.tier_percent_used,
  };
}
