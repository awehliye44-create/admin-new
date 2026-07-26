/**
 * Dispatch settings SSOT helpers — mirrors public.dispatch_settings column defaults
 * and progressive radius / wave / scoring logic shared with SQL functions.
 *
 * Radius keys in dispatch_settings are stored in kilometres; runtime uses metres.
 */ /** Mirrors Postgres NOT NULL DEFAULT values on public.dispatch_settings (20260601100000). */ export const DISPATCH_SETTINGS_SCHEMA_DEFAULTS = {
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
  towards_destination_enabled: true,
  towards_destination_daily_limit: 3,
  towards_destination_duration_minutes: 60,
  towards_destination_matching_tolerance_meters: 3000,
  towards_destination_priority_weight: 12
};
export function coercePositiveInt(raw) {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}
export function coerceNonNegativeNumber(raw, fallback) {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}
export function mergeDispatchRow(row, defaults = DISPATCH_SETTINGS_SCHEMA_DEFAULTS) {
  const out = {
    ...defaults
  };
  if (row) {
    for (const [k, v] of Object.entries(row)){
      if (v !== null && v !== undefined) out[k] = v;
    }
  }
  return out;
}
export function kmToMeters(km, fallbackKm) {
  const n = coerceNonNegativeNumber(km, fallbackKm);
  return Math.round(n * 1000);
}
/** Progressive radius: min(start + (round-1)*expand, max). Round is 1-based. */ export function effectiveRadiusMeters(settings, round) {
  const startKm = coerceNonNegativeNumber(settings.search_radius_start_km, coerceNonNegativeNumber(settings.search_radius_meters, 3000) / 1000);
  const expandKm = coerceNonNegativeNumber(settings.search_radius_expand_km, 5);
  const maxKm = coerceNonNegativeNumber(settings.search_radius_max_km, Math.max(startKm, startKm + expandKm));
  const startM = Math.round(startKm * 1000);
  const expandM = Math.round(expandKm * 1000);
  const maxM = Math.round(maxKm * 1000);
  const r = Math.max(1, Math.floor(round));
  return Math.min(startM + (r - 1) * expandM, maxM);
}
/** Rounds needed to reach max radius, at least 1. */ export function roundsNeededForMaxRadius(settings) {
  const startM = effectiveRadiusMeters(settings, 1);
  const maxM = effectiveRadiusMeters(settings, 9999);
  const expandKm = coerceNonNegativeNumber(settings.search_radius_expand_km, 5);
  const expandM = Math.round(expandKm * 1000);
  if (expandM <= 0 || maxM <= startM) return 1;
  return Math.ceil((maxM - startM) / expandM) + 1;
}
export function maxBroadcastRounds(settings, tripMaxRounds) {
  const configured = coercePositiveInt(tripMaxRounds) ?? 3;
  return Math.max(configured, roundsNeededForMaxRadius(settings));
}
export function waveDriverCapForRound(settings, round) {
  const key = round === 1 ? "wave1_size" : round === 2 ? "wave2_size" : "wave3_size";
  return coercePositiveInt(settings[key]) ?? coercePositiveInt(settings.max_offers_per_request) ?? 3;
}
/** Driver accept-button countdown (dispatch_settings.accept_timeout_seconds). */ export function acceptOfferTimeoutSeconds(settings) {
  return coercePositiveInt(settings.accept_timeout_seconds) ?? 12;
}
/** Towards-destination dropoff match tolerance (metres). */ export function destinationMatchRadiusMeters(settings) {
  const configured = coercePositiveInt(settings.towards_destination_matching_tolerance_meters);
  if (configured != null) return configured;
  return effectiveRadiusMeters(settings, 1);
}
/**
 * Bounded score bonus when trip dropoff is near the driver's towards destination.
 * Returns 0 when inactive/expired/disabled/out of tolerance — never hard-excludes.
 */ export function towardsDestinationPriorityBonus(settings, dropoffLat, dropoffLng, preference, distanceMetersFn, nowMs = Date.now()) {
  if (settings.towards_destination_enabled === false) return 0;
  if (!preference) return 0;
  if (preference.active === false) return 0;
  if (preference.expires_at != null && Number.isFinite(Date.parse(preference.expires_at)) && Date.parse(preference.expires_at) <= nowMs) {
    return 0;
  }
  const lat = preference.lat;
  const lng = preference.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 0;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return 0;
  if (lat === 0 && lng === 0) return 0;
  if (!Number.isFinite(dropoffLat) || !Number.isFinite(dropoffLng)) return 0;
  const tolerance = destinationMatchRadiusMeters(settings);
  const dist = distanceMetersFn(dropoffLat, dropoffLng, lat, lng);
  if (!Number.isFinite(dist) || dist > tolerance) return 0;
  return Math.min(Math.max(coerceNonNegativeNumber(settings.towards_destination_priority_weight, 12), 0), 100);
}
/** Fields embedded on ride_offers.offer_snapshot for driver countdown SSOT. */ export function dispatchOfferSnapshotFields(settings, round = 1) {
  const acceptSec = acceptOfferTimeoutSeconds(settings);
  const waveSec = waveOfferExpirySeconds(settings, round);
  return {
    acceptTimeoutSeconds: acceptSec,
    waveOfferExpirySeconds: waveSec,
    broadcastRound: round
  };
}
export function waveOfferExpirySeconds(settings, round) {
  const wkey = round === 1 ? "wave1_offer_expiry_seconds" : round === 2 ? "wave2_offer_expiry_seconds" : "wave3_offer_expiry_seconds";
  return coercePositiveInt(settings[wkey]) ?? coercePositiveInt(settings.offer_expiry_seconds) ?? 20;
}
export function customerSearchWindowMs(settings) {
  const minutes = coercePositiveInt(settings.max_driver_find_time_minutes) ?? coercePositiveInt(settings.global_timeout_minutes) ?? 3;
  return minutes * 60 * 1000;
}
/** @deprecated Use customerSearchWindowMs(loadDispatchSettings(...)) — rematch uses admin max search time. */ export const DRIVER_CANCEL_REMATCH_SEARCH_WINDOW_MS = customerSearchWindowMs(DISPATCH_SETTINGS_SCHEMA_DEFAULTS);
/** Driver-cancel rematch search window — same SSOT as initial booking (max_driver_find_time_minutes). */ export function driverCancelRematchSearchExpiresAtIso(settings, fromMs = Date.now()) {
  return customerSearchExpiresAtIso(settings, fromMs);
}
export function customerSearchExpiresAtIso(settings, fromMs = Date.now()) {
  return new Date(fromMs + customerSearchWindowMs(settings)).toISOString();
}
/** Resolve distance penalty km factor from dispatch_settings or global overlay (per_meter → per_km). */ export function resolveDistancePenaltyPerKm(settings) {
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
export function extractDriverTierName(driver) {
  const cat = driver.driver_categories;
  if (Array.isArray(cat)) return cat[0]?.name ?? "Bronze";
  return cat?.name ?? "Bronze";
}
/** Load tier_name → category_priority for a service area (SSOT: service_area_driver_tiers). */ export async function loadServiceAreaTierPriorityMap(supabase, serviceAreaId) {
  const map = new Map();
  if (!serviceAreaId) return map;
  const { data, error } = await supabase.from("service_area_driver_tiers").select("tier_name, category_priority").eq("service_area_id", serviceAreaId).eq("is_active", true);
  if (error) {
    console.warn("[dispatch-settings] loadServiceAreaTierPriorityMap failed:", error.message);
    return map;
  }
  for (const row of data ?? []){
    if (row?.tier_name) {
      map.set(String(row.tier_name).toLowerCase(), coerceNonNegativeNumber(row.category_priority, 0));
    }
  }
  return map;
}
export function resolveDriverTierCategoryPriorityFromMap(tierPriorityMap, tierName) {
  const key = tierName.toLowerCase();
  if (tierPriorityMap.has(key)) return tierPriorityMap.get(key);
  if (tierPriorityMap.has("bronze")) {
    console.warn(`[dispatch-settings] tier "${tierName}" missing in service area map; using Bronze fallback`);
    return tierPriorityMap.get("bronze");
  }
  return 0;
}
export function attachDriverCategoryPriority(driver, tierPriorityMap) {
  const tierName = extractDriverTierName(driver);
  return {
    ...driver,
    category_priority: resolveDriverTierCategoryPriorityFromMap(tierPriorityMap, tierName)
  };
}
export function driverIdleMinutes(driver, nowMs) {
  const anchor = driver.last_trip_end_at ?? driver.online_since ?? driver.last_seen_at;
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
 */ export function computeDispatchScore(settings, driver, distanceMeters, nowMs = Date.now()) {
  const distanceKm = Math.max(0, distanceMeters) / 1000;
  const distancePenalty = distanceKm * resolveDistancePenaltyPerKm(settings);
  const idleMinutes = driverIdleMinutes(driver, nowMs);
  const maxWaitingBonus = coerceNonNegativeNumber(settings.max_waiting_bonus_minutes, 20);
  const waitingBonus = Math.min(idleMinutes, maxWaitingBonus) * coerceNonNegativeNumber(settings.waiting_bonus_per_minute, 0.5);
  const fairnessIdle = coerceNonNegativeNumber(settings.fairness_idle_minutes, 20);
  const fairnessBoost = idleMinutes >= fairnessIdle ? coerceNonNegativeNumber(settings.fairness_boost_score, 10) : 0;
  const categoryPriority = coerceNonNegativeNumber(driver.category_priority, 0);
  const degradedPenalty = driver.dispatch_quality === "degraded" ? coerceNonNegativeNumber(settings.degraded_driver_penalty, 100) : 0;
  const towardsBonus = coerceNonNegativeNumber(driver.towards_bonus, 0);
  return categoryPriority + waitingBonus + fairnessBoost + towardsBonus - distancePenalty - degradedPenalty;
}
export function compareDispatchCandidates(settings, a, b, nowMs = Date.now()) {
  const scoreA = computeDispatchScore(settings, a, a.distance_meters ?? 0, nowMs);
  const scoreB = computeDispatchScore(settings, b, b.distance_meters ?? 0, nowMs);
  if (scoreA !== scoreB) return scoreB - scoreA;
  return (a.distance_meters ?? 0) - (b.distance_meters ?? 0);
}
/** Admin Auto-Dispatch Rules (`global_dispatch_settings`) overlays per-service-area rows. */ const GLOBAL_DISPATCH_DIRECT_OVERLAY_FIELDS = [
  "max_driver_find_time_minutes",
  "wave1_offer_expiry_seconds",
  "wave2_offer_expiry_seconds",
  "wave3_offer_expiry_seconds",
  "wave1_size",
  "wave2_size",
  "wave3_size",
  "max_dispatch_rounds",
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
  "towards_destination_enabled",
  "towards_destination_daily_limit",
  "towards_destination_duration_minutes",
  "towards_destination_matching_tolerance_meters",
  "towards_destination_priority_weight"
];
/** Map global_dispatch_settings radius columns → dispatch_settings km/m SSOT keys. */ function overlayGlobalRadiusFields(merged, globalRow) {
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
export function overlayGlobalDispatchSettings(merged, globalRow) {
  if (!globalRow) return merged;
  for (const key of GLOBAL_DISPATCH_DIRECT_OVERLAY_FIELDS){
    const value = globalRow[key];
    if (value !== null && value !== undefined) {
      merged[key] = value;
    }
  }
  overlayGlobalRadiusFields(merged, globalRow);
  return merged;
}
async function loadGlobalDispatchSettingsRow(supabase) {
  const { data } = await supabase.from("global_dispatch_settings").select("*").eq("singleton", true).maybeSingle();
  return data ? data : null;
}
export async function loadDispatchSettings(supabase, serviceAreaId) {
  let settingsRow = null;
  let source = "schema_defaults";
  if (serviceAreaId) {
    const { data } = await supabase.from("dispatch_settings").select("*").eq("service_area_id", serviceAreaId).maybeSingle();
    if (data) {
      settingsRow = data;
      source = "service_area";
    }
  }
  if (!settingsRow) {
    const { data } = await supabase.from("dispatch_settings").select("*").is("service_area_id", null).maybeSingle();
    if (data) {
      settingsRow = data;
      source = "global";
    }
  }
  const globalRow = await loadGlobalDispatchSettingsRow(supabase);
  const merged = overlayGlobalDispatchSettings(mergeDispatchRow(settingsRow), globalRow);
  merged._source = source;
  return merged;
}
/** Home-map supply dots: use admin max search radius (metres). */ export function homeMapSupplyRadiusMeters(settings) {
  return effectiveRadiusMeters(settings, 9999);
}
