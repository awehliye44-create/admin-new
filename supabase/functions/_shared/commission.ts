import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { calculateTripSettlement } from "./tripSettlement.ts";

/**
 * Driver tier resolution. Settlement math owned by tripSettlement SSOT.
 * Commission % comes from service_area_driver_tiers (service area + driver tier name).
 */

export interface CommissionResult {
  commissionPct: number;
  driverStripeAccountId: string | null;
}

export interface CommissionSplit {
  grossFarePence: number;
  commissionPct: number;
  commissionPence: number;
  driverNetPence: number;
  driverTotalEarningsPence: number;
  commissionableFarePence: number;
}

export type CommissionSplitOptions = {
  airport_charge_pence?: number;
  other_pass_through_charges_pence?: number;
  tips_pence?: number;
};

async function resolveTierName(
  supabase: any,
  driverId: string,
): Promise<string> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("category_id, driver_categories(name)")
    .eq("id", driverId)
    .single();

  const category = driver?.driver_categories as { name?: string } | null;
  return category?.name ?? "Bronze";
}

async function loadServiceAreaTierCommission(
  supabase: any,
  serviceAreaId: string,
  tierName: string,
): Promise<number | null> {
  const { data: saTier } = await supabase
    .from("service_area_driver_tiers")
    .select("commission_percent")
    .eq("service_area_id", serviceAreaId)
    .ilike("tier_name", tierName)
    .eq("is_active", true)
    .maybeSingle();

  if (saTier?.commission_percent != null) {
    return Number(saTier.commission_percent);
  }

  const { data: bronze } = await supabase
    .from("service_area_driver_tiers")
    .select("commission_percent")
    .eq("service_area_id", serviceAreaId)
    .ilike("tier_name", "bronze")
    .eq("is_active", true)
    .maybeSingle();

  if (bronze?.commission_percent != null) {
    console.warn(
      `[commission] Tier "${tierName}" not configured for service area ${serviceAreaId}; using Bronze fallback`,
    );
    return Number(bronze.commission_percent);
  }

  return null;
}

export async function getDriverCommission(
  supabase: any,
  driverId: string,
  serviceAreaId: string | null | undefined,
): Promise<CommissionResult> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("stripe_account_id")
    .eq("id", driverId)
    .single();

  const driverStripeAccountId = driver?.stripe_account_id || null;

  if (!serviceAreaId) {
    throw new Error(
      `[commission] service_area_id required for tier commission resolution (driver ${driverId})`,
    );
  }

  const tierName = await resolveTierName(supabase, driverId);
  const commissionPct = await loadServiceAreaTierCommission(supabase, serviceAreaId, tierName);

  if (commissionPct == null) {
    throw new Error(
      `No tier commission configured for service area ${serviceAreaId}. Configure service_area_driver_tiers.`,
    );
  }

  console.log(
    `[commission] Resolved: ${commissionPct}% for driver ${driverId} tier ${tierName} in SA ${serviceAreaId}`,
  );
  return { commissionPct, driverStripeAccountId };
}

/** Settlement split via calculateTripSettlement SSOT. */
export function calculateCommissionSplit(
  finalFarePence: number,
  commissionPct: number,
  options?: CommissionSplitOptions,
): CommissionSplit {
  const settlement = calculateTripSettlement({
    final_fare_pence: finalFarePence,
    airport_charge_pence: options?.airport_charge_pence ?? 0,
    other_pass_through_charges_pence: options?.other_pass_through_charges_pence ?? 0,
    tips_pence: options?.tips_pence ?? 0,
    driver_tier_commission_percent: commissionPct,
  });

  return {
    grossFarePence: finalFarePence,
    commissionPct: settlement.tier_percent_used,
    commissionPence: settlement.commission_pence,
    driverNetPence: settlement.driver_net_pence,
    driverTotalEarningsPence: settlement.driver_total_earnings_pence,
    commissionableFarePence: settlement.commissionable_fare_pence,
  };
}

export async function getDriverCommissionSplit(
  supabase: ReturnType<typeof createClient>,
  driverId: string,
  serviceAreaId: string | null | undefined,
  finalFarePence: number,
  options?: CommissionSplitOptions,
): Promise<CommissionSplit & { driverStripeAccountId: string | null }> {
  const { commissionPct, driverStripeAccountId } = await getDriverCommission(
    supabase,
    driverId,
    serviceAreaId,
  );
  const split = calculateCommissionSplit(finalFarePence, commissionPct, options);
  return { ...split, driverStripeAccountId };
}
