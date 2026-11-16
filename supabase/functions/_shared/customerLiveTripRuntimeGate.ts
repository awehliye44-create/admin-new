/**
 * Live Trip remote fanout may only target native builds that embed the
 * ActivityKit / Android Live Updates modules.
 *
 * Compatible trains (Customer):
 * - Android versionCode >= 46 (app_version shaped `1.0.6(46)` or capability)
 * - iOS buildNumber >= 23 (app_version shaped `1.0.6(23)` or capability)
 *
 * Unknown / missing native build: fail closed for start/update fanout so
 * pre-1.0.6 fleets are not targeted. Terminal/end fanout may still proceed.
 */

export const LIVE_TRIP_MIN_ANDROID_VERSION_CODE = 46;
export const LIVE_TRIP_MIN_IOS_BUILD_NUMBER = 23;
export const LIVE_TRIP_CLIENT_CAPABILITY = "live_trip_lock_screen_v1";

export type LiveTripRuntimeHints = {
  platform?: string | null;
  appVersion?: string | null;
  runtimeVersion?: string | null;
  clientCapabilities?: readonly string[] | null;
};

/** Parse trailing `(N)` native build from `1.0.6(46)` / `exposdk:…(23)`. */
export function parseNativeBuildInParens(
  raw: string | null | undefined,
): number | null {
  if (typeof raw !== "string") return null;
  const m = /\((\d+)\)\s*$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function hasLiveTripClientCapability(
  caps: readonly string[] | null | undefined,
): boolean {
  if (!Array.isArray(caps)) return false;
  return caps.some((c) => String(c).trim() === LIVE_TRIP_CLIENT_CAPABILITY);
}

/**
 * Store train that first embeds Live Trip modules (`1.0.6` / versionCode 46 /
 * iOS build 23). Bare `1.0.6` (no parenthetical) is treated as compatible so
 * devices bound before app_version labels included native build still receive
 * fanout; `1.0.5` and below stay excluded.
 */
export function isReleasedLiveTripAppTrain(
  appVersion: string | null | undefined,
): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(appVersion ?? "").trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (major > 1) return true;
  if (major === 1 && minor > 0) return true;
  return major === 1 && minor === 0 && patch >= 6;
}

/**
 * Whether this device may receive Live Trip start/update fanout.
 * Ends are not gated here — callers may still end for cleanup.
 */
export function isCustomerLiveTripRuntimeCompatible(
  hints: LiveTripRuntimeHints,
): boolean {
  if (hasLiveTripClientCapability(hints.clientCapabilities)) return true;

  const platform = String(hints.platform ?? "").trim().toLowerCase();
  const nativeBuild =
    parseNativeBuildInParens(hints.appVersion) ??
    parseNativeBuildInParens(hints.runtimeVersion);

  if (platform === "android") {
    if (nativeBuild != null) {
      return nativeBuild >= LIVE_TRIP_MIN_ANDROID_VERSION_CODE;
    }
    return isReleasedLiveTripAppTrain(hints.appVersion);
  }
  if (platform === "ios") {
    if (nativeBuild != null) {
      return nativeBuild >= LIVE_TRIP_MIN_IOS_BUILD_NUMBER;
    }
    return isReleasedLiveTripAppTrain(hints.appVersion);
  }
  return false;
}
