import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

/**
 * Commission resolution — global_dispatch_settings.base_driver_commission_percent is SSOT
 * for live (pre-accept) resolution. Accepted trips must prefer trips.accepted_commission_percent.
 * Driver tiers no longer determine trip commission.
 */

export async function getDriverCommissionPct(
  supabase: SupabaseClient,
  _driverId: string,
  _serviceAreaId: string | null | undefined,
): Promise<number> {
  const { data, error } = await supabase
    .from("global_dispatch_settings")
    .select("base_driver_commission_percent")
    .eq("singleton", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load base driver commission: ${error.message}`);
  }

  const pct = Number(data?.base_driver_commission_percent);
  if (!Number.isFinite(pct)) {
    throw new Error("global_dispatch_settings.base_driver_commission_percent missing");
  }

  return Math.min(100, Math.max(0, pct));
}

export interface CommissionResult {
  commission_pct: number;
  commission_pence: number;
  driver_net_pence: number;
}

/**
 * @deprecated Slice 4 — prefer calculateTripSettlement / calculateCanonicalSettlement.
 * Gross-only helper kept for legacy call sites; does not strip airport.
 * Callers that know airport must use tripSettlement SSOT instead.
 */
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
