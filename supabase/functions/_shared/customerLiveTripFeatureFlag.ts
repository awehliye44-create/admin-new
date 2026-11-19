/**
 * Customer Live Trip presentation feature flag + platform readiness.
 * Default OFF until activation after native + backend release gates.
 *
 * Emergency disable: UPDATE customer_live_trip_settings SET enabled = false;
 * Or set secret CUSTOMER_LIVE_TRIP_ENABLED=false.
 *
 * Platform gates (independent):
 * - Android: CUSTOMER_LIVE_TRIP_ANDROID_ENABLED / settings.android_enabled (default on when global on)
 * - iOS: requires APNs Live Activity credentials + CUSTOMER_LIVE_TRIP_IOS_ENABLED /
 *   settings.ios_enabled (default off until APNs ready)
 */

import { liveActivityApnsConfigured } from "./customerLiveTripApns.ts";

export type CustomerLiveTripPlatformGates = {
  globalEnabled: boolean;
  androidEnabled: boolean;
  iosEnabled: boolean;
  apnsConfigured: boolean;
};

function envTriState(name: string): boolean | null {
  const env = Deno.env.get(name)?.trim().toLowerCase();
  if (env === "false" || env === "0" || env === "off") return false;
  if (env === "true" || env === "1" || env === "on") return true;
  return null;
}

// deno-lint-ignore no-explicit-any
export async function resolveCustomerLiveTripPlatformGates(
  admin: any,
): Promise<CustomerLiveTripPlatformGates> {
  const apnsConfigured = liveActivityApnsConfigured();
  const envGlobal = envTriState("CUSTOMER_LIVE_TRIP_ENABLED");
  const envAndroid = envTriState("CUSTOMER_LIVE_TRIP_ANDROID_ENABLED");
  const envIos = envTriState("CUSTOMER_LIVE_TRIP_IOS_ENABLED");

  let dbEnabled: boolean | null = null;
  let dbAndroid: boolean | null = null;
  let dbIos: boolean | null = null;
  try {
    const { data } = await admin
      .from("customer_live_trip_settings")
      .select("enabled, android_enabled, ios_enabled")
      .eq("id", true)
      .maybeSingle();
    if (data) {
      dbEnabled = data.enabled === true;
      if (typeof data.android_enabled === "boolean") dbAndroid = data.android_enabled;
      if (typeof data.ios_enabled === "boolean") dbIos = data.ios_enabled;
    }
  } catch {
    // Column may be absent pre-migration — fall through to env/defaults.
  }

  const globalEnabled = envGlobal ?? dbEnabled ?? false;
  const androidEnabled =
    globalEnabled && (envAndroid ?? dbAndroid ?? true);
  // iOS never activates without APNs credentials — keep Android independent.
  const iosEnabled =
    globalEnabled &&
    apnsConfigured &&
    (envIos ?? dbIos ?? apnsConfigured);

  return { globalEnabled, androidEnabled, iosEnabled, apnsConfigured };
}

// deno-lint-ignore no-explicit-any
