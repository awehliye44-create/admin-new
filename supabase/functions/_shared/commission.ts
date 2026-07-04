import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Commission resolution — service_area_driver_tiers is SSOT for tier % per service area.
 * driver_categories remains the driver's tier identity (Bronze → Diamond).
 */

async function resolveTierName(
  supabase: SupabaseClient,
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
  supabase: SupabaseClient,
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

export async function getDriverCommissionPct(
  supabase: SupabaseClient,
  driverId: string,
  serviceAreaId: string | null | undefined,
): Promise<number> {
  if (!serviceAreaId) {
    throw new Error(
      `service_area_id required for tier commission resolution (driver ${driverId})`,
    );
  }

  const tierName = await resolveTierName(supabase, driverId);
  const commissionPct = await loadServiceAreaTierCommission(supabase, serviceAreaId, tierName);

  if (commissionPct == null) {
    throw new Error(
      `No tier commission configured for service area ${serviceAreaId}. Configure service_area_driver_tiers.`,
    );
  }

  return commissionPct;
}

export interface CommissionResult {
  commission_pct: number;
  commission_pence: number;
  driver_net_pence: number;
}

export async function calculateCommission(
  supabase: SupabaseClient,
  driverId: string,
  grossFarePence: number,
  serviceAreaId: string | null | undefined,
): Promise<CommissionResult> {
  const commission_pct = await getDriverCommissionPct(supabase, driverId, serviceAreaId);
  const commission_pence = Math.round(grossFarePence * commission_pct / 100);
  const driver_net_pence = grossFarePence - commission_pence;

  return { commission_pct, commission_pence, driver_net_pence };
}
