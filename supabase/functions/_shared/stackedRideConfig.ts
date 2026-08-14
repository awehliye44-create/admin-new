/**
 * Stacked ride config â global_dispatch_settings SSOT.
 * Admin Auto-Dispatch Rules writes this table; auto-dispatch + scheduled-dispatch read it.
 *
 * SAFETY: stacked rides default OFF. Missing, split, or inconsistent config â OFF.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export const STACKED_RIDE_DISABLED_SAFE_GUARD = "STACKED_RIDE_DISABLED_SAFE_GUARD";
/** Hard cap enforced by auto-dispatch regardless of admin max_stacked_rides (1â3). */
export const STACKED_RIDES_EDGE_CAP = 2;

/** Effective concurrent stacked queue depth â min(admin config, edge cap). */
export function effectiveMaxStackedRides(configMax: number): number {
  const parsed = parsePositiveInt(configMax, DEFAULTS.maxStackedRides);
  return Math.min(parsed, STACKED_RIDES_EDGE_CAP);
}
export const STACKED_RIDE_ELIGIBILITY_CHECK = "STACKED_RIDE_ELIGIBILITY_CHECK";
export const STACKED_RIDE_BLOCKED_REASON = "STACKED_RIDE_BLOCKED_REASON";
export const STACKED_RIDE_ELIGIBLE = "STACKED_RIDE_ELIGIBLE";

export type StackedRideConfigSource = "global_dispatch_settings" | "schema_defaults";

export type StackedRideConfig = {
  source: StackedRideConfigSource;
  /** Effective enable â false when guard trips (missing/split/inconsistent). */
  operational: boolean;
  guardReason?: string;
  stackedRidesEnabled: boolean;
  maxStackedRides: number;
  stackedSearchRadiusMeters: number;
  stackedMinTripDistanceKm: number;
  stackedMaxDetourMinutes: number;
  stackedOfferWindowMinutes: number;
  stackedPriorityMode: "same_direction" | "nearest" | "highest_fare";
  allowAirportStacking: boolean;
  allowScheduledStacking: boolean;
  allowStackingDuringPickupWaiting: boolean;
  allowStackingDuringStopWaiting: boolean;
};

export type GlobalStackedSettingsRow = {
  stacked_rides_enabled?: boolean | null;
  max_stacked_rides?: number | null;
  stacked_search_radius_meters?: number | null;
  stacked_min_trip_distance_meters?: number | null;
  stacked_max_detour_minutes?: number | null;
  stacked_offer_window_minutes?: number | null;
  stacked_same_direction_only?: boolean | null;
  allow_airport_stacking?: boolean | null;
  allow_scheduled_stacking?: boolean | null;
  allow_stacking_during_pickup_waiting?: boolean | null;
  allow_stacking_during_stop_waiting?: boolean | null;
};

export type DeprecatedDispatchStackedRow = {
  stacked_rides_enabled?: boolean | null;
};

const DEFAULTS: Omit<StackedRideConfig, "source" | "operational" | "guardReason"> = {
  stackedRidesEnabled: false,
  maxStackedRides: 1,
  stackedSearchRadiusMeters: 2000,
  stackedMinTripDistanceKm: 3,
  stackedMaxDetourMinutes: 10,
  stackedOfferWindowMinutes: 5,
  stackedPriorityMode: "nearest",
  allowAirportStacking: false,
  allowScheduledStacking: false,
  allowStackingDuringPickupWaiting: false,
  allowStackingDuringStopWaiting: false,
};

function parseBool(raw: unknown, fallback: boolean): boolean {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeNumber(raw: unknown, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** @deprecated Ignored â stacked eligibility is radius-only; always nearest for sort metadata. */
function resolvePriorityMode(_sameDirectionOnly: boolean): StackedRideConfig["stackedPriorityMode"] {
  return "nearest";
}

/**
 * Resolve stacked config from global_dispatch_settings row (admin Auto-Dispatch Rules SSOT).
 * Legacy dispatch_settings.stacked_rides_enabled is ignored â admin only writes global_dispatch_settings.
 */
export function resolveStackedRideConfig(
  globalRow: GlobalStackedSettingsRow | null | undefined,
  _deprecatedDispatchRow?: DeprecatedDispatchStackedRow | null,
): StackedRideConfig {
  const source: StackedRideConfigSource = globalRow ? "global_dispatch_settings" : "schema_defaults";

  if (!globalRow) {
    return {
      source,
      operational: false,
      guardReason: "global_dispatch_settings_missing",
      ...DEFAULTS,
    };
  }

  const stackedRidesEnabled = parseBool(globalRow.stacked_rides_enabled, false);
  const minTripMeters = parseNonNegativeNumber(
    globalRow.stacked_min_trip_distance_meters,
    DEFAULTS.stackedMinTripDistanceKm * 1000,
  );

  let guardReason: string | undefined;
  let operational = stackedRidesEnabled;

  if (!stackedRidesEnabled) {
    guardReason = "stacked_rides_disabled";
    operational = false;
  }

  return {
    source,
    operational,
    guardReason,
    stackedRidesEnabled,
    maxStackedRides: effectiveMaxStackedRides(
      parsePositiveInt(globalRow.max_stacked_rides, DEFAULTS.maxStackedRides),
    ),
    stackedSearchRadiusMeters: parsePositiveInt(
      globalRow.stacked_search_radius_meters,
      DEFAULTS.stackedSearchRadiusMeters,
    ),
    stackedMinTripDistanceKm: minTripMeters / 1000,
    stackedMaxDetourMinutes: parsePositiveInt(
      globalRow.stacked_max_detour_minutes,
      DEFAULTS.stackedMaxDetourMinutes,
    ),
    stackedOfferWindowMinutes: parsePositiveInt(
      globalRow.stacked_offer_window_minutes,
      DEFAULTS.stackedOfferWindowMinutes,
    ),
    stackedPriorityMode: resolvePriorityMode(false),
    allowAirportStacking: parseBool(globalRow.allow_airport_stacking, false),
    allowScheduledStacking: parseBool(globalRow.allow_scheduled_stacking, false),
    allowStackingDuringPickupWaiting: parseBool(
      globalRow.allow_stacking_during_pickup_waiting,
      false,
    ),
    allowStackingDuringStopWaiting: parseBool(
      globalRow.allow_stacking_during_stop_waiting,
      false,
    ),
  };
}

const GLOBAL_STACKED_SELECT = [
  "stacked_rides_enabled",
  "max_stacked_rides",
  "stacked_search_radius_meters",
  "stacked_min_trip_distance_meters",
  "stacked_max_detour_minutes",
  "stacked_offer_window_minutes",
  "allow_airport_stacking",
  "allow_scheduled_stacking",
  "allow_stacking_during_pickup_waiting",
  "allow_stacking_during_stop_waiting",
].join(", ");

/**
 * In-memory cache for the stacked ride config row.
 * global_dispatch_settings is admin-only and rarely changes between requests.
 * Each Deno isolate caches for up to 60 s, saving one DB round-trip (~20-40 ms)
 * on every stacked accept in the hot path.
 */
let _stackedConfigCache: { config: StackedRideConfig; expiresAt: number } | null = null;
const STACKED_CONFIG_CACHE_TTL_MS = 60_000;

export async function loadStackedRideConfig(
  supabase: SupabaseClient,
  _serviceAreaId?: string | null,
): Promise<StackedRideConfig> {
  const now = Date.now();
  if (_stackedConfigCache != null && now < _stackedConfigCache.expiresAt) {
    return _stackedConfigCache.config;
  }

  const { data: globalRow } = await supabase
    .from("global_dispatch_settings")
    .select(GLOBAL_STACKED_SELECT)
    .eq("singleton", true)
    .maybeSingle();

  const config = resolveStackedRideConfig(globalRow as GlobalStackedSettingsRow | null);
  _stackedConfigCache = { config, expiresAt: now + STACKED_CONFIG_CACHE_TTL_MS };
  return config;
}

export function logStackedRideDisabledSafeGuard(
  context: Record<string, unknown>,
  config: StackedRideConfig,
): void {
  console.log(STACKED_RIDE_DISABLED_SAFE_GUARD, {
    operational: config.operational,
    guard_reason: config.guardReason ?? "unknown",
    source: config.source,
    stacked_rides_enabled: config.stackedRidesEnabled,
    ...context,
  });
}

export type StackedNewTripContext = {
  estimated_distance_km?: number | null;
  airport_charge_pence?: number | null;
  is_scheduled?: boolean | null;
  dispatch_mode?: string | null;
};

export type StackedCurrentTripContext = {
  id: string;
  status: string;
  stacked_trip_id?: string | null;
  started_at?: string | null;
  estimated_duration_minutes?: number | null;
  stop_waiting_status?: string | null;
  stop_waiting_started_at?: string | null;
  stop_waiting_paid_started_at?: string | null;
  grace_period_expired_at?: string | null;
  pickup_waiting_started_at?: string | null;
  pickup_paid_waiting_started_at?: string | null;
  arrived_at?: string | null;
};

export type StackedEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: string; details?: Record<string, unknown> };

/** Phase 2 â safe stacked driver eligibility (current trip + new trip policy). */
export function evaluateStackedDriverEligibility(input: {
  config: StackedRideConfig;
  newTrip: StackedNewTripContext;
  currentTrip: StackedCurrentTripContext;
  nowMs?: number;
}): StackedEligibilityResult {
  const { config, newTrip, currentTrip } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (!config.operational) {
    return { eligible: false, reason: "stacked_disabled_safe_guard" };
  }

  const newTripDistanceKm = newTrip.estimated_distance_km ?? 0;
  if (newTripDistanceKm < config.stackedMinTripDistanceKm) {
    return {
      eligible: false,
      reason: "stacked_new_trip_too_short",
      details: { distance_km: newTripDistanceKm, min_km: config.stackedMinTripDistanceKm },
    };
  }

  const isAirportTrip = (newTrip.airport_charge_pence ?? 0) > 0;
  if (isAirportTrip && !config.allowAirportStacking) {
    return { eligible: false, reason: "stacked_airport_blocked" };
  }

  const isScheduledTrip =
    newTrip.is_scheduled === true || newTrip.dispatch_mode === "scheduled";
  if (isScheduledTrip && !config.allowScheduledStacking) {
    return { eligible: false, reason: "stacked_scheduled_blocked" };
  }

  if (currentTrip.stacked_trip_id) {
    return {
      eligible: false,
      reason: "stacked_already_has_queued_trip",
      details: { stacked_trip_id: currentTrip.stacked_trip_id },
    };
  }

  const status = currentTrip.status;

  if (status === "accepted") {
    return { eligible: false, reason: "stacked_heading_to_pickup_blocked" };
  }

  if (status === "arrived" && !config.allowStackingDuringPickupWaiting) {
    return { eligible: false, reason: "stacked_pickup_waiting_blocked" };
  }

  if (status !== "in_progress" && status !== "arrived") {
    return {
      eligible: false,
      reason: "stacked_requires_in_progress_near_dropoff",
      details: { current_trip_status: status },
    };
  }

  const stopWaitingActive =
    !!currentTrip.stop_waiting_started_at ||
    !!currentTrip.stop_waiting_paid_started_at ||
    (currentTrip.stop_waiting_status != null &&
      currentTrip.stop_waiting_status !== "" &&
      currentTrip.stop_waiting_status !== "idle");
  if (stopWaitingActive && !config.allowStackingDuringStopWaiting) {
    return { eligible: false, reason: "stacked_stop_waiting_blocked" };
  }

  const tripAnchorIso =
    status === "in_progress"
      ? currentTrip.started_at
      : status === "arrived"
        ? currentTrip.arrived_at
        : null;

  if (!tripAnchorIso || !currentTrip.estimated_duration_minutes) {
    return { eligible: false, reason: "stacked_missing_trip_timing" };
  }

  const tripStartTime = new Date(tripAnchorIso).getTime();
  const estimatedEndTime =
    tripStartTime + currentTrip.estimated_duration_minutes * 60 * 1000;
  const minutesUntilEnd = (estimatedEndTime - nowMs) / (60 * 1000);

  if (minutesUntilEnd > config.stackedOfferWindowMinutes) {
    return {
      eligible: false,
      reason: "stacked_not_within_offer_window",
      details: {
        minutes_until_end: Math.round(minutesUntilEnd),
        offer_window_minutes: config.stackedOfferWindowMinutes,
      },
    };
  }

  return { eligible: true };
}

export function logStackedEligibilityCheck(
  driverId: string,
  tripId: string,
  result: StackedEligibilityResult,
  extra?: Record<string, unknown>,
): void {
  console.log(STACKED_RIDE_ELIGIBILITY_CHECK, {
    driver_id: driverId,
    trip_id: tripId,
    eligible: result.eligible,
    ...extra,
  });
  if (!result.eligible) {
    console.log(STACKED_RIDE_BLOCKED_REASON, {
      driver_id: driverId,
      trip_id: tripId,
      reason: result.reason,
      ...(result.details ?? {}),
      ...extra,
    });
  } else {
    console.log(STACKED_RIDE_ELIGIBLE, {
      driver_id: driverId,
      trip_id: tripId,
      ...extra,
    });
  }
}

export type StackedGateAuditInput = {
  gate: string;
  pass: boolean;
  reason?: string;
  config?: Pick<
    StackedRideConfig,
    | "source"
    | "stackedSearchRadiusMeters"
    | "stackedOfferWindowMinutes"
    | "maxStackedRides"
    | "stackedPriorityMode"
  >;
  driver_id?: string;
  trip_id?: string;
  current_trip_id?: string;
  distance_from_driver_meters?: number;
  distance_from_dropoff_meters?: number;
  direction_alignment?: number;
  offer_window_minutes?: number;
  minutes_until_end?: number;
  offer_type?: "stacked" | "normal";
};

/** Structured PASS/FAIL audit for stacked config gates (global_dispatch_settings SSOT). */
export function logStackedGateAudit(input: StackedGateAuditInput): void {
  console.log("STACKED_RIDE_GATE_AUDIT", {
    result: input.pass ? "PASS" : "FAIL",
    gate: input.gate,
    reason: input.reason ?? null,
    config_source: input.config?.source ?? null,
    search_radius_meters: input.config?.stackedSearchRadiusMeters ?? null,
    offer_window_minutes: input.config?.stackedOfferWindowMinutes ?? null,
    max_stacked_rides: input.config?.maxStackedRides ?? null,
    priority_mode: input.config?.stackedPriorityMode ?? null,
    driver_id: input.driver_id ?? null,
    trip_id: input.trip_id ?? null,
    current_trip_id: input.current_trip_id ?? null,
    distance_from_driver_meters: input.distance_from_driver_meters ?? null,
    distance_from_dropoff_meters: input.distance_from_dropoff_meters ?? null,
    direction_alignment: input.direction_alignment ?? null,
    minutes_until_end: input.minutes_until_end ?? null,
    offer_type: input.offer_type ?? null,
  });
}
