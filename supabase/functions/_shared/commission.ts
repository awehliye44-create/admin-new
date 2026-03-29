import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  LOCKED MODULE — Commission Calculation                        ║
 * ║                                                                ║
 * ║  This is the SINGLE source of truth for commission logic.      ║
 * ║  Protected by: src/test/commission.test.ts (12 tests)          ║
 * ║                                                                ║
 * ║  Rules:                                                        ║
 * ║  1. Commission % comes ONLY from driver_categories table       ║
 * ║  2. Bronze tier is the fallback for unassigned drivers          ║
 * ║  3. Formula: round(gross * pct / 100)                          ║
 * ║  4. commission + driver_net = gross (conservation law)          ║
 * ║  5. driver_ledger is the financial source of truth              ║
 * ║     (NOT the trips table or driver_wallet_ledger)               ║
 * ║                                                                ║
 * ║  DO NOT hardcode rates. DO NOT bypass this module.             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Get the commission percentage for a driver.
 *
 * 1. If the driver has a category_id → use that category's commission_pct.
 * 2. If category_id is NULL → fall back to the Bronze tier commission.
 *
 * Commission always comes from the driver_categories table — never hardcoded.
 */
export async function getDriverCommissionPct(
  supabase: SupabaseClient,
  driverId: string,
): Promise<number> {
  // 1. Check driver's assigned category
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

  // 2. Fallback: use Bronze tier commission (lowest priority tier)
  const { data: bronze } = await supabase
    .from('driver_categories')
    .select('commission_pct')
    .ilike('name', 'bronze')
    .limit(1)
    .maybeSingle();

  if (bronze?.commission_pct != null) {
    return bronze.commission_pct;
  }

  // 3. Ultimate fallback: use the tier with the highest priority number (lowest rank)
  const { data: lowestTier } = await supabase
    .from('driver_categories')
    .select('commission_pct')
    .order('category_priority', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lowestTier?.commission_pct != null) {
    return lowestTier.commission_pct;
  }

  // Should never reach here if driver_categories table has data
  throw new Error('No driver categories found in database — cannot determine commission rate');
}

/**
 * Commission calculation result.
 */
export interface CommissionResult {
  commission_pct: number;
  commission_pence: number;
  driver_net_pence: number;
}

/**
 * Calculate commission from a gross fare using the driver's tier rate.
 *
 * Formula:
 *   commission_pence = round(gross_fare_pence * commission_pct / 100)
 *   driver_net_pence = gross_fare_pence - commission_pence
 *
 * @param supabase  Supabase client (service role)
 * @param driverId  Driver UUID
 * @param grossFarePence  The commissionable gross fare in pence (tip excluded)
 */
export async function calculateCommission(
  supabase: SupabaseClient,
  driverId: string,
  grossFarePence: number,
): Promise<CommissionResult> {
  const commission_pct = await getDriverCommissionPct(supabase, driverId);
  const commission_pence = Math.round(grossFarePence * commission_pct / 100);
  const driver_net_pence = grossFarePence - commission_pence;

  return { commission_pct, commission_pence, driver_net_pence };
}
