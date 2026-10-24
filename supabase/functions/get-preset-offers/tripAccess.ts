import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

/** Resolve identity from the validated JWT, never a request-supplied driver ID. */
export async function canReadPresetTrip(
  supabase: SupabaseClient,
  userId: string,
  tripId: string,
  customerId: string | null,
): Promise<boolean> {
  if (customerId) {
    const { data, error } = await supabase.from("customers").select("id")
      .eq("id", customerId).eq("user_id", userId).maybeSingle();
    if (error) throw error;
    if (data) return true;
  }
  const { data: roles, error: roleError } = await supabase.from("user_roles")
    .select("role").eq("user_id", userId);
  if (roleError) throw roleError;
  if ((roles ?? []).some((r) => r.role === "admin" || r.role === "super_admin")) return true;

  const { data: driver, error: driverError } = await supabase.from("drivers")
    .select("id").eq("user_id", userId).maybeSingle();
  if (driverError) throw driverError;
  if (!driver) return false;

  // ride_offers is the deployed incoming-offer table used by driver-fare-offer.
  const { data: offers, error: offerError } = await supabase.from("ride_offers")
    .select("id").eq("trip_id", tripId).eq("driver_id", driver.id)
    .eq("status", "pending").gt("expires_at", new Date().toISOString()).limit(1);
  if (offerError) throw offerError;
  return (offers ?? []).length > 0;
}