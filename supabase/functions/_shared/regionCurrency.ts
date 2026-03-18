/**
 * Region Currency Resolution — Edge Function Shared Utility
 *
 * Region is the SINGLE SOURCE OF TRUTH for currency_code and distance_unit.
 * All financial writes MUST resolve currency from Region.
 * No hardcoded GBP fallbacks are permitted.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface RegionCurrencyResult {
  currency_code: string;
  distance_unit: string;
  region_id: string;
  region_name: string;
}

/**
 * Resolve currency from a trip's service_area → region chain.
 * Throws if Region or currency cannot be resolved.
 */
export async function resolveCurrencyFromTrip(
  supabase: SupabaseClient,
  tripId: string
): Promise<RegionCurrencyResult> {
  const { data: trip, error } = await supabase
    .from("trips")
    .select("service_area_id, service_area:service_areas!trips_service_area_id_fkey(region_id, region:regions(id, name, currency_code, distance_unit))")
    .eq("id", tripId)
    .single();

  if (error || !trip) {
    throw new Error(`REGION_CURRENCY_UNRESOLVABLE: Cannot find trip ${tripId}`);
  }

  const sa = trip.service_area as any;
  const region = sa?.region;

  if (!region?.currency_code) {
    throw new Error(
      `REGION_CURRENCY_UNRESOLVABLE: Trip ${tripId} → service_area ${trip.service_area_id} has no Region with currency_code configured. Configure currency on the Region.`
    );
  }

  return {
    currency_code: region.currency_code,
    distance_unit: region.distance_unit || "mile",
    region_id: region.id,
    region_name: region.name,
  };
}

/**
 * Resolve currency from a driver's region chain.
 * Drivers have a region_id directly.
 * Throws if Region or currency cannot be resolved.
 */
export async function resolveCurrencyFromDriver(
  supabase: SupabaseClient,
  driverId: string
): Promise<RegionCurrencyResult> {
  const { data: driver, error } = await supabase
    .from("drivers")
    .select("region_id, region:regions(id, name, currency_code, distance_unit)")
    .eq("id", driverId)
    .single();

  if (error || !driver) {
    throw new Error(`REGION_CURRENCY_UNRESOLVABLE: Cannot find driver ${driverId}`);
  }

  const region = driver.region as any;

  if (!region?.currency_code) {
    throw new Error(
      `REGION_CURRENCY_UNRESOLVABLE: Driver ${driverId} → region ${driver.region_id} has no currency_code configured. Configure currency on the Region.`
    );
  }

  return {
    currency_code: region.currency_code,
    distance_unit: region.distance_unit || "mile",
    region_id: region.id,
    region_name: region.name,
  };
}

/**
 * Resolve currency from a service_area_id → region chain.
 * Throws if Region or currency cannot be resolved.
 */
export async function resolveCurrencyFromServiceArea(
  supabase: SupabaseClient,
  serviceAreaId: string
): Promise<RegionCurrencyResult> {
  const { data: sa, error } = await supabase
    .from("service_areas")
    .select("region_id, region:regions(id, name, currency_code, distance_unit)")
    .eq("id", serviceAreaId)
    .single();

  if (error || !sa) {
    throw new Error(`REGION_CURRENCY_UNRESOLVABLE: Cannot find service_area ${serviceAreaId}`);
  }

  const region = sa.region as any;

  if (!region?.currency_code) {
    throw new Error(
      `REGION_CURRENCY_UNRESOLVABLE: Service area ${serviceAreaId} → region ${sa.region_id} has no currency_code configured. Configure currency on the Region.`
    );
  }

  return {
    currency_code: region.currency_code,
    distance_unit: region.distance_unit || "mile",
    region_id: region.id,
    region_name: region.name,
  };
}
