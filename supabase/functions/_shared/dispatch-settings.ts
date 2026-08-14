/**
 * Dispatch settings SSOT helpers — mirrors public.dispatch_settings column defaults
 * and progressive radius / wave / scoring logic shared with SQL functions.
 *
 * Radius keys in dispatch_settings are stored in kilometres; runtime uses metres.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/** Mirrors Postgres NOT NULL DEFAULT values on public.dispatch_settings (20260601100000). */
export const DISPATCH_SETTINGS_SCHEMA_DEFAULTS: Record<string, unknown> = {
  max_driver_find_time_minutes: 3,
  global_timeout_minutes: 15,
  search_radius_meters: 3000,
  search_radius_start_km: 3,
  search_radius_expand_km: 5,
  search_radius_max_km: 8,
  offer_expiry_seconds: 20,
  max_offers_per_request: 5,
  wave1_size: 3,
  wave2_size: 5,
  wave3_size: 10,
  wave1_offer_expiry_seconds: 40,
  wave2_offer_expiry_seconds: 45,
  wave3_offer_expiry_seconds: 50,
  accept_timeout_seconds: 12,
  cooldown_after_reject_seconds: 180,
  max_concurrent_offers_per_driver: 1,
  suppress_recent_offers_seconds: 60,
  batch_mode: "parallel",
  cascade_batch_size: 3,
  distance_penalty_per_km: 2.0,
  waiting_bonus_per_minute: 0.5,
  max_waiting_bonus_minutes: 20,
  fairness_idle_minutes: 20,
  fairness_boost_score: 10,
  priority_order: "nearest",
  shortlist_limit: 100,
  stacked_rides_enabled: false,
  max_stacked_rides: 1,
  stacked_search_radius_meters: 2000,
  stacked_min_trip_distance_km: 3,
  stacked_max_detour_minutes: 10,
  stacked_offer_window_minutes: 5,
  minimum_rating: 0,
  manual_emergency_dispatch_only: false,
};

export type DispatchSettingsSource = "service_area" | "global" | "schema_defaults";

export type ResolvedDispatchSettings = Record<string, unknown> & {
  _source: DispatchSettingsSource;
};

export function coercePositiveInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

export function coerceNonNegativeNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

export function mergeDispatchRow(
  row: Record<string, unknown> | null,
  defaults: Record<string, unknown> = DISPATCH_SETTINGS_SCHEMA_DEFAULTS,
): ResolvedDispatchSettings {
  const out: Record<string, unknown> = { ...defaults };
  if (row) {
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && v !== undefined) out[k] = v;
    }
  }
  return out as ResolvedDispatchSettings;
}

export function kmToMeters(km: unknown, fallbackKm: number): number {
  const n = coerceNonNegativeNumber(km, fallbackKm);
  return Math.round(n * 1000);
}

/**
 * Absolute broadcast sequence (1…N) maps onto the fixed 3-wave cycle:
 * seq 1→W1, 2→W2, 3→W3, 4→W1 (round 2), …
 */
export function waveIndexFromSequence(sequence: number): 1 | 2 | 3 {
  const s = Math.max(1, Math.floor(sequence));
  return (((s - 1) % 3) + 1) as 1 | 2 | 3;
}

/** 1-based dispatch round (= full W1→W2→W3 cycle index) from absolute sequence. */
export function dispatchRoundFromSequence(sequence: number): number {
  const s = Math.max(1, Math.floor(sequence));
  return Math.floor((s - 1) / 3) + 1;
}

/** Admin Max Dispatch Rounds = full 3-wave cycles (not individual waves). */
export function maxDispatchCycles(
  settings: Record<string, unknown>,
  tripMaxSequences?: number | null,
): number {
  const stampedSequences = coercePositiveInt(tripMaxSequences);
  if (stampedSequences != null) {
    // Trip stamp is max sequences (cycles × 3). Recover cycles for logging/UI.
    return Math.max(1, Math.ceil(stampedSequences / 3));
  }
  return coercePositiveInt(settings.max_dispatch_rounds) ?? 3;
}

/**
 * Max absolute sequences for a trip = Max Dispatch Rounds × 3.
 * Prefer trips.max_broadcast_rounds when already stamped at book.
 */
export function maxBroadcastSequences(
  settings: Record<string, unknown>,
  tripMaxSequences?: number | null,
): number {
  const stamped = coercePositiveInt(tripMaxSequences);
  if (stamped != null) return stamped;
  return maxDispatchCycles(settings, null) * 3;
}

/** @deprecated Prefer maxBroadcastSequences — kept as alias for call sites. */
export function maxBroadcastRounds(
  settings: Record<string, unknown>,
  tripMaxRounds?: number | null,
): number {
  return maxBroadcastSequences(settings, tripMaxRounds);
}

/** Progressive radius within a 3-wave cycle (wave index, not absolute sequence). */
export function effectiveRadiusMeters(
  settings: Record<string, unknown>,
  sequenceOrWave: number,
): number {
  const startKm = coerceNonNegativeNumber(
    settings.search_radius_start_km,
    coerceNonNegativeNumber(settings.search_radius_meters, 3000) / 1000,
  );
  const expandKm = coerceNonNegativeNumber(settings.search_radius_expand_km, 5);
  const maxKm = coerceNonNegativeNumber(
    settings.search_radius_max_km,
    Math.max(startKm, startKm + expandKm),
  );
  const startM = Math.round(startKm * 1000);
  const expandM = Math.round(expandKm * 1000);
  const maxM = Math.round(maxKm * 1000);
  // Treat values > 3 as absolute sequences so Round 2 Wave 1 restarts at start radius.
  const wave = sequenceOrWave >= 1 && sequenceOrWave <= 3
    ? Math.floor(sequenceOrWave)
    : waveIndexFromSequence(sequenceOrWave);
  return Math.min(startM + (wave - 1) * expandM, maxM);
}

/** Rounds (waves within a cycle) needed to reach max radius, at least 1. */
export function roundsNeededForMaxRadius(settings: Record<string, unknown>): number {
  const startM = effectiveRadiusMeters(settings, 1);
  const maxM = effectiveRadiusMeters(settings, 3);
  const expandKm = coerceNonNegativeNumber(settings.search_radius_expand_km, 5);
  const expandM = Math.round(expandKm * 1000);
  if (expandM <= 0 || maxM <= startM) return 1;
  return Math.min(3, Math.ceil((maxM - startM) / expandM) + 1);
}

export function waveDriverCapForRound(settings: Record<string, unknown>, sequence: number): number {
  const wave = waveIndexFromSequence(sequence);
  const key = wave === 1 ? "wave1_size" : wave === 2 ? "wave2_size" : "wave3_size";
  return (
    coercePositiveInt(settings[key]) ??
    coercePositiveInt(settings.max_offers_per_request) ??
    3
  );
}

/** Configured wave commission reduction (percentage points), uncapped by floor. */
export function waveCommissionReductionPercent(
  settings: Record<string, unknown>,
  sequence: number,
): number {
  const wave = waveIndexFromSequence(sequence);
  const key = wave === 1
    ? "wave1_commission_reduction_percent"
    : wave === 2
    ? "wave2_commission_reduction_percent"
    : "wave3_commission_reduction_percent";
  return coerceNonNegativeNumber(settings[key], 0);
}

export function baseDriverCommissionPercent(settings: Record<string, unknown>): number {
  return Math.min(100, coerceNonNegativeNumber(settings.base_driver_commission_percent, 15));
}

/**
 * effective = max(0, base − max(wave_reduction, floor_reduction)).
 * Floor enforces monotonic incentive across repeated rounds.
 */
export function resolveWaveCommission(params: {
  settings: Record<string, unknown>;
  sequence: number;
  floorReductionPercent?: number | null;
}): {
  basePercent: number;
  reductionPercent: number;
  effectivePercent: number;
  wave: 1 | 2 | 3;
  dispatchRound: number;
} {
  const wave = waveIndexFromSequence(params.sequence);
  const dispatchRound = dispatchRoundFromSequence(params.sequence);
  const basePercent = baseDriverCommissionPercent(params.settings);
  const configuredReduction = waveCommissionReductionPercent(params.settings, params.sequence);
  const floor = coerceNonNegativeNumber(params.floorReductionPercent, 0);
  const reductionPercent = Math.min(basePercent, Math.max(configuredReduction, floor));
  const effectivePercent = Math.max(0, basePercent - reductionPercent);
  return { basePercent, reductionPercent, effectivePercent, wave, dispatchRound };
}

/**
 * Offer lifetime must never exceed remaining trip TTL.
 * Returns seconds (>= 1 when any TTL remains; 0 when trip already expired).
 */
export function effectiveOfferExpirySeconds(params: {
  settings: Record<string, unknown>;
  sequence: number;
  remainingTripTtlSeconds: number;
}): number {
  const waveSec = waveOfferExpirySeconds(params.settings, params.sequence);
  const remaining = Math.max(0, Math.floor(params.remainingTripTtlSeconds));
  if (remaining <= 0) return 0;
  return Math.max(1, Math.min(waveSec, remaining));
}

/** Driver accept-button countdown (dispatch_settings.accept_timeout_seconds). */
export function acceptOfferTimeoutSeconds(settings: Record<string, unknown>): number {
  return coercePositiveInt(settings.accept_timeout_seconds) ?? 12;
}

/** Towards-destination dropoff match radius — reuses progressive start radius (km→m SSOT). */
export function destinationMatchRadiusMeters(settings: Record<string, unknown>): number {
  return effectiveRadiusMeters(settings, 1);
}

/** Fields embedded on ride_offers.offer_snapshot for driver countdown SSOT. */
export function dispatchOfferSnapshotFields(
  settings: Record<string, unknown>,
  round = 1,
): Record<string, unknown> {
  const acceptSec = acceptOfferTimeoutSeconds(settings);
  const waveSec = waveOfferExpirySeconds(settings, round);
  return {
    acceptTimeoutSeconds: acceptSec,
    waveOfferExpirySeconds: waveSec,
    broadcastRound: round,
  };
}

export function waveOfferExpirySeconds(settings: Record<string, unknown>, sequence: number): number {
  const wave = waveIndexFromSequence(sequence);
  const wkey = wave === 1
    ? "wave1_offer_expiry_seconds"
    : wave === 2
    ? "wave2_offer_expiry_seconds"
    : "wave3_offer_expiry_seconds";
  return (
    coercePositiveInt(settings[wkey]) ??
    coercePositiveInt(settings.offer_expiry_seconds) ??
    20
  );
}

export function customerSearchWindowMs(settings: Record<string, unknown>): number {
  const minutes =
    coercePositiveInt(settings.max_driver_find_time_minutes) ??
    coercePositiveInt(settings.global_timeout_minutes) ??
    3;
  return minutes * 60 * 1000;
}

/** @deprecated Use customerSearchWindowMs(loadDispatchSettings(...)) — rematch uses admin max search time. */
export const DRIVER_CANCEL_REMATCH_SEARCH_WINDOW_MS =
  customerSearchWindowMs(DISPATCH_SETTINGS_SCHEMA_DEFAULTS);

/** Driver-cancel rematch search window — same SSOT as initial booking (max_driver_find_time_minutes). */
export function driverCancelRematchSearchExpiresAtIso(
  settings: Record<string, unknown>,
  fromMs: number = Date.now(),
): string {
  return customerSearchExpiresAtIso(settings, fromMs);
}

export function customerSearchExpiresAtIso(
  settings: Record<string, unknown>,
  fromMs: number = Date.now(),
): string {
  return new Date(fromMs + customerSearchWindowMs(settings)).toISOString();
}

export type DispatchScoreDriver = {
  /** From service_area_driver_tiers.category_priority for trip.service_area_id + driver tier. */
  category_priority?: number | null;
  dispatch_quality?: "healthy" | "degraded" | string | null;
  display_rating?: number | null;
  rating?: number | null;
  acceptance_rate?: number | null;
  last_trip_end_at?: string | null;
  online_since?: string | null;
  last_seen_at?: string | null;
};

/** Resolve distance penalty km factor from dispatch_settings or global overlay (per_meter → per_km). */
export function resolveDistancePenaltyPerKm(settings: Record<string, unknown>): number {
  const perKm = settings.distance_penalty_per_km;
  if (perKm !== null && perKm !== undefined) {
    return coerceNonNegativeNumber(perKm, 2);
  }
  const perMeter = settings.distance_penalty_per_meter;
  if (perMeter !== null && perMeter !== undefined) {
    return coerceNonNegativeNumber(perMeter, 0.002) * 1000;
  }
  return 2;
}

export function extractDriverTierName(driver: {
  driver_categories?: { name?: string } | { name?: string }[] | null;
}): string {
  const cat = driver.driver_categories;
  if (Array.isArray(cat)) return cat[0]?.name ?? "Bronze";
  return cat?.name ?? "Bronze";
}

/** Load tier_name → category_priority for a service area (SSOT: service_area_driver_tiers). */
export async function loadServiceAreaTierPriorityMap(
  supabase: SupabaseClient,
  serviceAreaId: string | null | undefined,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!serviceAreaId) return map;

  const { data, error } = await supabase
    .from("service_area_driver_tiers")
    .select("tier_name, category_priority")
    .eq("service_area_id", serviceAreaId)
    .eq("is_active", true);

  if (error) {
    console.warn("[dispatch-settings] loadServiceAreaTierPriorityMap failed:", error.message);
    return map;
  }

  for (const row of data ?? []) {
    if (row?.tier_name) {
      map.set(
        String(row.tier_name).toLowerCase(),
        coerceNonNegativeNumber(row.category_priority, 0),
      );
    }
  }
  return map;
}

export function resolveDriverTierCategoryPriorityFromMap(
  tierPriorityMap: Map<string, number>,
  tierName: string,
): number {
  const key = tierName.toLowerCase();
  if (tierPriorityMap.has(key)) return tierPriorityMap.get(key)!;
  if (tierPriorityMap.has("bronze")) {
    console.warn(
      `[dispatch-settings] tier "${tierName}" missing in service area map; using Bronze fallback`,
    );
    return tierPriorityMap.get("bronze")!;
  }
  return 0;
}

export function attachDriverCategoryPriority<T extends Record<string, unknown>>(
  driver: T,
  tierPriorityMap: Map<string, number>,
): T & { category_priority: number } {
  const tierName = extractDriverTierName(
    driver as Parameters<typeof extractDriverTierName>[0],
  );
  return {
    ...driver,
    category_priority: resolveDriverTierCategoryPriorityFromMap(tierPriorityMap, tierName),
  };
}

export function driverIdleMinutes(driver: DispatchScoreDriver, nowMs: number): number {
  const anchor =
    driver.last_trip_end_at ??
    driver.online_since ??
    driver.last_seen_at;
  if (!anchor) return 0;
  const t = new Date(anchor).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (nowMs - t) / 60000);
}

/**
 * Higher score = better candidate. Mirrors public.compute_dispatch_score SQL.
 *
 * score = category_priority + waiting_bonus + fairness_boost
 *         - distance_penalty - degraded_driver_penalty
 *
 * category_priority comes from service_area_driver_tiers (trip SA + driver tier).
 */
export function computeDispatchScore(
  settings: Record<string, unknown>,
  driver: DispatchScoreDriver,
  distanceMeters: number,
  nowMs: number = Date.now(),
): number {
  const distanceKm = Math.max(0, distanceMeters) / 1000;
  const distancePenalty = distanceKm * resolveDistancePenaltyPerKm(settings);
  const idleMinutes = driverIdleMinutes(driver, nowMs);
  const maxWaitingBonus = coerceNonNegativeNumber(settings.max_waiting_bonus_minutes, 20);
  const waitingBonus =
    Math.min(idleMinutes, maxWaitingBonus) *
    coerceNonNegativeNumber(settings.waiting_bonus_per_minute, 0.5);
  const fairnessIdle = coerceNonNegativeNumber(settings.fairness_idle_minutes, 20);
  const fairnessBoost =
    idleMinutes >= fairnessIdle
      ? coerceNonNegativeNumber(settings.fairness_boost_score, 10)
      : 0;

  const categoryPriority = coerceNonNegativeNumber(driver.category_priority, 0);
  const degradedPenalty =
    driver.dispatch_quality === "degraded"
      ? coerceNonNegativeNumber(settings.degraded_driver_penalty, 100)
      : 0;

  return categoryPriority + waitingBonus + fairnessBoost - distancePenalty - degradedPenalty;
}

export function compareDispatchCandidates(
  settings: Record<string, unknown>,
  a: DispatchScoreDriver & { distance_meters?: number; dispatch_quality?: string },
  b: DispatchScoreDriver & { distance_meters?: number; dispatch_quality?: string },
  nowMs: number = Date.now(),
): number {
  const scoreA = computeDispatchScore(settings, a, a.distance_meters ?? 0, nowMs);
  const scoreB = computeDispatchScore(settings, b, b.distance_meters ?? 0, nowMs);
  if (scoreA !== scoreB) return scoreB - scoreA;

  return (a.distance_meters ?? 0) - (b.distance_meters ?? 0);
}

/** Admin Auto-Dispatch Rules (`global_dispatch_settings`) overlays per-service-area rows. */
const GLOBAL_DISPATCH_DIRECT_OVERLAY_FIELDS = [
  "max_driver_find_time_minutes",
  "wave1_offer_expiry_seconds",
  "wave2_offer_expiry_seconds",
  "wave3_offer_expiry_seconds",
  "wave1_size",
  "wave2_size",
  "wave3_size",
  "max_dispatch_rounds",
  "base_driver_commission_percent",
  "wave1_commission_reduction_percent",
  "wave2_commission_reduction_percent",
  "wave3_commission_reduction_percent",
  "distance_penalty_per_meter",
  "waiting_bonus_per_minute",
  "max_waiting_bonus_minutes",
  "fairness_idle_minutes",
  "fairness_boost_score",
  "degraded_driver_penalty",
  "presence_max_age_seconds",
  "stacked_rides_enabled",
  "max_stacked_rides",
  "stacked_search_radius_meters",
  "driver_fare_display",
] as const;

/** Map global_dispatch_settings radius columns → dispatch_settings km/m SSOT keys. */
function overlayGlobalRadiusFields(
  merged: ResolvedDispatchSettings,
  globalRow: Record<string, unknown>,
): void {
  const startM = coercePositiveInt(globalRow.start_radius_meters);
  if (startM != null) {
    merged.search_radius_meters = startM;
    merged.search_radius_start_km = startM / 1000;
  }
  const expandM = coercePositiveInt(globalRow.expand_radius_meters);
  if (expandM != null) {
    merged.search_radius_expand_km = expandM / 1000;
  }
  const maxM = coercePositiveInt(globalRow.max_radius_meters);
  if (maxM != null) {
    merged.search_radius_max_km = maxM / 1000;
  }
}

export function overlayGlobalDispatchSettings(
  merged: ResolvedDispatchSettings,
  globalRow: Record<string, unknown> | null,
): ResolvedDispatchSettings {
  if (!globalRow) return merged;
  for (const key of GLOBAL_DISPATCH_DIRECT_OVERLAY_FIELDS) {
    const value = globalRow[key];
    if (value !== null && value !== undefined) {
      merged[key] = value;
    }
  }
  overlayGlobalRadiusFields(merged, globalRow);
  return merged;
}

async function loadGlobalDispatchSettingsRow(
  supabase: SupabaseClient,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from("global_dispatch_settings")
    .select("*")
    .eq("singleton", true)
    .maybeSingle();
  return data ? (data as Record<string, unknown>) : null;
}

export async function loadDispatchSettings(
  supabase: SupabaseClient,
  serviceAreaId: string | null | undefined,
): Promise<ResolvedDispatchSettings> {
  let settingsRow: Record<string, unknown> | null = null;
  let source: DispatchSettingsSource = "schema_defaults";

  if (serviceAreaId) {
    const { data } = await supabase
      .from("dispatch_settings")
      .select("*")
      .eq("service_area_id", serviceAreaId)
      .maybeSingle();
    if (data) {
      settingsRow = data as Record<string, unknown>;
      source = "service_area";
    }
  }

  if (!settingsRow) {
    const { data } = await supabase
      .from("dispatch_settings")
      .select("*")
      .is("service_area_id", null)
      .maybeSingle();
    if (data) {
      settingsRow = data as Record<string, unknown>;
      source = "global";
    }
  }

  const globalRow = await loadGlobalDispatchSettingsRow(supabase);
  const merged = overlayGlobalDispatchSettings(mergeDispatchRow(settingsRow), globalRow);
  merged._source = source;
  return merged;
}

/** Home-map supply dots: use admin max search radius (metres). */
export function homeMapSupplyRadiusMeters(settings: Record<string, unknown>): number {
  return effectiveRadiusMeters(settings, 9999);
}
