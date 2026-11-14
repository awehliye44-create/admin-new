/**
 * Customer Live Trip presentation feature flag.
 * Default OFF until activation after native + backend release gates.
 *
 * Emergency disable: UPDATE customer_live_trip_settings SET enabled = false;
 * Or set secret CUSTOMER_LIVE_TRIP_ENABLED=false.
 */

export const CUSTOMER_LIVE_TRIP_FEATURE_FLAG = "customer_live_trip_enabled";

// deno-lint-ignore no-explicit-any
export async function isCustomerLiveTripFeatureEnabled(admin: any): Promise<boolean> {
  const env = Deno.env.get("CUSTOMER_LIVE_TRIP_ENABLED")?.trim().toLowerCase();
  if (env === "false" || env === "0" || env === "off") return false;
  if (env === "true" || env === "1" || env === "on") return true;

  try {
    const { data } = await admin
      .from("customer_live_trip_settings")
      .select("enabled")
      .eq("id", true)
      .maybeSingle();
    return data?.enabled === true;
  } catch {
    return false;
  }
}
