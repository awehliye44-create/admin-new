import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/** Resolve driver's primary service area (drivers.service_area_id, then junction). */
export async function resolveDriverServiceAreaId(
  supabase: SupabaseClient,
  driverId: string,
  serviceAreaId: string | null | undefined,
): Promise<string | null> {
  let resolved = serviceAreaId ?? null;

  if (!resolved) {
    const { data: driverRow } = await supabase
      .from("drivers")
      .select("service_area_id")
      .eq("id", driverId)
      .maybeSingle();
    resolved = (driverRow?.service_area_id as string | null) ?? null;
  }

  if (!resolved) {
    const { data: junction } = await supabase
      .from("driver_service_areas")
      .select("service_area_id")
      .eq("driver_id", driverId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    resolved = junction?.service_area_id ?? null;
  }

  return resolved;
}
