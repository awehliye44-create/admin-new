import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateTripSettlement } from "./tripSettlement.ts";

/**
 * Commission tier resolution + settlement via tripSettlement SSOT.
 */

export async function getDriverCommissionPct(
  supabase: SupabaseClient,
  driverId: string,
): Promise<number> {
  const { data: driver } = await supabase
    .from('drivers')
    .select('category_id')
    .eq('id', driverId)
    .single();

  if (driver?.category_id) {
    const { data: category } = await supabase
      .from('driver_categories')
      .select('commission_pct')
      .eq('id', driver.category_id)
      .single();

    if (category?.commission_pct != null) {
      return category.commission_pct;
    }
  }

  const { data: bronze } = await supabase
    .from('driver_categories')
    .select('commission_pct')
    .ilike('name', 'bronze')
    .limit(1)
    .maybeSingle();

  if (bronze?.commission_pct != null) {
    return bronze.commission_pct;
  }

  const { data: lowestTier } = await supabase
    .from('driver_categories')
    .select('commission_pct')
    .order('category_priority', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lowestTier?.commission_pct != null) {
    return lowestTier.commission_pct;
  }

  throw new Error('No driver categories found in database — cannot determine commission rate');
}

export interface CommissionResult {
  commission_pct: number;
  commission_pence: number;
  driver_net_pence: number;
  driver_total_earnings_pence: number;
  commissionable_fare_pence: number;
}

export type CalculateCommissionOptions = {
  airport_charge_pence?: number;
  other_pass_through_charges_pence?: number;
  tips_pence?: number;
};

/**
 * Settlement via calculateTripSettlement SSOT.
 * @param finalFarePence Customer final fare in pence (tip excluded).
 */
export async function calculateCommission(
  supabase: SupabaseClient,
  driverId: string,
  finalFarePence: number,
  options?: CalculateCommissionOptions,
): Promise<CommissionResult> {
  const commission_pct = await getDriverCommissionPct(supabase, driverId);
  const settlement = calculateTripSettlement({
    final_fare_pence: finalFarePence,
    airport_charge_pence: options?.airport_charge_pence ?? 0,
    other_pass_through_charges_pence: options?.other_pass_through_charges_pence ?? 0,
    tips_pence: options?.tips_pence ?? 0,
    driver_tier_commission_percent: commission_pct,
  });

  return {
    commission_pct: settlement.tier_percent_used,
    commission_pence: settlement.commission_pence,
    driver_net_pence: settlement.driver_net_pence,
    driver_total_earnings_pence: settlement.driver_total_earnings_pence,
    commissionable_fare_pence: settlement.commissionable_fare_pence,
  };
}
