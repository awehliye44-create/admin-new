import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
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
