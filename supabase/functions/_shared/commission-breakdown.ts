/**
 * Driver commission breakdown — delegates to tripSettlement SSOT.
 *
 * Airport charge, other pass-through charges, and tips are never commissionable.
 */

import {
  calculateTripSettlement,
  capTierCommissionPercent,
  MAX_COMMISSION_PERCENT,
} from "./tripSettlement.ts";

export { MAX_COMMISSION_PERCENT, capTierCommissionPercent };

export type DriverCommissionInput = {
  /** Full amount the customer pays (after discounts, including tip). */
  totalCustomerFarePence: number;
  airportChargePence: number;
  otherPassThroughChargesPence: number;
  tipsPence: number;
  /** 0–100 from driver tier snapshot. */
  commissionPercent: number;
};

export type DriverCommissionBreakdown = {
  total_customer_fare_pence: number;
  airport_charge_pence: number;
  other_pass_through_charges_pence: number;
  tips_pence: number;
  commissionable_fare_pence: number;
  commission_percent: number;
  commission_pence: number;
  driver_net_pence: number;
  driver_total_earnings_pence: number;
};

export function extractAirportChargePence(
  fareBreakdown: Record<string, unknown> | null | undefined,
): number {
  if (!fareBreakdown || typeof fareBreakdown !== "object") return 0;
  const raw =
    fareBreakdown.airport_charge ??
    fareBreakdown.airportCharge ??
    null;
  if (raw == null) {
    const pickup = Number(fareBreakdown.airport_pickup_fee ?? fareBreakdown.airportPickupFee ?? 0);
    const dropoff = Number(fareBreakdown.airport_dropoff_fee ?? fareBreakdown.airportDropoffFee ?? 0);
    if (pickup > 0 || dropoff > 0) {
      return Math.round((pickup + dropoff) * 100);
    }
    return 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 100 ? Math.round(n) : Math.round(n * 100);
}

export function computeDriverCommissionBreakdown(
  input: DriverCommissionInput,
): DriverCommissionBreakdown {
  const tipsPence = Math.max(0, Math.round(input.tipsPence));
  const totalCustomerFarePence = Math.max(0, Math.round(input.totalCustomerFarePence));
  const finalFarePence = Math.max(0, totalCustomerFarePence - tipsPence);

  const settlement = calculateTripSettlement({
    final_fare_pence: finalFarePence,
    airport_charge_pence: input.airportChargePence,
    other_pass_through_charges_pence: input.otherPassThroughChargesPence,
    tips_pence: tipsPence,
    driver_tier_commission_percent: input.commissionPercent,
    stripe_fee_pence: 0,
  });

  return {
    total_customer_fare_pence: totalCustomerFarePence,
    airport_charge_pence: settlement.airport_charge_pence,
    other_pass_through_charges_pence: settlement.other_pass_through_charges_pence,
    tips_pence: settlement.tips_pence,
    commissionable_fare_pence: settlement.commissionable_fare_pence,
    commission_percent: settlement.tier_percent_used,
    commission_pence: settlement.commission_pence,
    driver_net_pence: settlement.driver_net_pence,
    driver_total_earnings_pence: settlement.driver_total_earnings_pence,
  };
}
