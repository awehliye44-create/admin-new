import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  securityHeaders,
  jsonHeaders,
  handleCORSPreflight,
  checkRateLimit,
  rateLimitResponse,
  getClientIP,
  successResponse,
  errorResponse,
  isValidUUID,
  validationErrorResponse,
} from "../_shared/security.ts";
import { towardsDestinationTripQualifies } from "../../../shared/towardsDestinationSSOT.ts";
import {
  gateStackedOfferAgainstScheduledCommitments,
  mapCommitmentPolicyFromDb,
  tripSignalsIndicateAirport,
} from "../_shared/scheduledRidesPolicy.ts";
import { computeDriverLocationState } from "../_shared/driverLocationState.ts";
import {
  computeDispatchScore,
  radiusMetersForDispatchRound,
  waveBatchSizeForRound,
  waveOfferExpirySecondsForRound,
} from "../_shared/dispatchAdminSsot.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import {
  DRIVER_NEW_RIDE_OFFER_BODY,
  DRIVER_NEW_RIDE_OFFER_TITLE,
} from "../_shared/negotiationPushCopy.ts";
import {
  evaluateRideOfferDriverEligibility,
  evaluateRideOfferPushGate,
  revokeRideOfferNonDriverFault,
} from "../_shared/rideOfferDriverEligibility.ts";

// Rate limit: 100 requests per minute
const RATE_LIMIT_CONFIG = { limit: 100, windowMs: 60000, keyPrefix: 'auto-dispatch' };

interface DispatchRequest {
  trip_id: string;
  service_area_id?: string;
  force_rebroadcast?: boolean;
  source?: string;
}

interface Driver {
  id: string;
  current_lat: number;
  current_lng: number;
  current_trip_id: string | null;
  distance_meters?: number;
  is_stacked?: boolean;
  online_since?: string | null;
  dispatch_score?: number;
  waiting_minutes?: number;
}

interface StackedDriver extends Driver {
  current_trip_dropoff_lat: number;
  current_trip_dropoff_lng: number;
  distance_from_current_dropoff?: number;
}

/**
 * Calculate distance between two coordinates using Haversine formula
 */
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Remaining minutes on the driver's active trip for full-queue feasibility. */
function estimateActiveRemainingMinutes(currentTrip: {
  status: string;
  started_at?: string | null;
  estimated_duration_minutes?: number | null;
}): number {
  const estimate = Number(currentTrip.estimated_duration_minutes);
  const fallback = Number.isFinite(estimate) && estimate > 0 ? estimate : 20;
  if (
    currentTrip.status === "in_progress" &&
    currentTrip.started_at &&
    Number.isFinite(estimate) &&
    estimate > 0
  ) {
    const remaining =
      (new Date(currentTrip.started_at).getTime() + estimate * 60_000 - Date.now()) /
      60_000;
    return Math.max(1, remaining);
  }
  return fallback;
}

/** Airport trip for stacking gate — charge signal and/or custom zone type. */
async function resolveIsAirportTripForStacking(
  supabase: any,
  trip: {
    airport_charge_pence?: number | null;
    pickup_zone_id?: string | null;
    dropoff_zone_id?: string | null;
  },
): Promise<boolean> {
  if (tripSignalsIndicateAirport({ airportChargePence: trip.airport_charge_pence })) {
    return true;
  }
  const zoneIds = [trip.pickup_zone_id, trip.dropoff_zone_id].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (zoneIds.length === 0) return false;
  const { data: zones } = await supabase
    .from("custom_zones")
    .select("id, zone_type")
    .in("id", zoneIds);
  return tripSignalsIndicateAirport({
    zoneTypes: (zones || []).map((z: { zone_type?: string | null }) => z.zone_type),
  });
}

// Compute offer pence for one preset entry
function computePresetFare(baseFarePence: number, preset: any, caps: any): number {
  let fare: number;
  if (preset.type === "PERCENT" || preset.percent != null) {
    fare = baseFarePence + Math.round(baseFarePence * (preset.percent ?? preset.value) / 100);
  } else {
    fare = baseFarePence + (preset.fixedPence ?? preset.value ?? 0);
  }
  if (caps?.maxIncreasePercent != null) {
    const maxByPct = baseFarePence + Math.round(baseFarePence * caps.maxIncreasePercent / 100);
    fare = Math.min(fare, maxByPct);
  }
  if (caps?.maxIncreaseFixedPence != null) {
    fare = Math.min(fare, baseFarePence + caps.maxIncreaseFixedPence);
  }
  if (caps?.minFinalFarePence != null) fare = Math.max(fare, caps.minFinalFarePence);
  if (caps?.maxFinalFarePence != null) fare = Math.min(fare, caps.maxFinalFarePence);
  return fare;
}

async function resolveEffectiveVehicleTypeId(
  supabase: any,
  trip: { id: string; vehicle_type_id?: string | null; vehicle_type?: string | null }
): Promise<string | null> {
  if (trip.vehicle_type_id) return trip.vehicle_type_id;

  const legacySlug = (trip.vehicle_type || "economy").trim();
  if (!legacySlug) return null;

  const { data: vehicleType } = await supabase
    .from("vehicle_types")
    .select("id")
    .eq("slug", legacySlug)
    .maybeSingle();

  if (!vehicleType?.id) return null;

  await supabase
    .from("trips")
    .update({ vehicle_type_id: vehicleType.id, updated_at: new Date().toISOString() })
    .eq("id", trip.id)
    .is("vehicle_type_id", null);

  return vehicleType.id as string;
}

// Check if current time is within any schedule window (supports cross-midnight)
function isWithinSchedule(timezone: string, windows: any[]): boolean {
  try {
    const now = new Date();
    const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const weekdayPart = parts.find(p => p.type === "weekday")?.value?.toUpperCase().slice(0, 3);
    const hourPart = parseInt(parts.find(p => p.type === "hour")?.value || "0");
    const minutePart = parseInt(parts.find(p => p.type === "minute")?.value || "0");
    const currentMinutes = hourPart * 60 + minutePart;
    const dayMap: Record<string, number> = {SUN:0,MON:1,TUE:2,WED:3,THU:4,FRI:5,SAT:6};
    const currentDayIdx = dayMap[weekdayPart ?? ""] ?? -1;
    const prevDayIdx = (currentDayIdx + 6) % 7;
    const prevDayName = dayNames[prevDayIdx];

    for (const w of windows) {
      const [startH, startM] = (w.start as string).split(":").map(Number);
      const [endH, endM] = (w.end as string).split(":").map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      const isCrossMidnight = endMinutes < startMinutes;
      if (!isCrossMidnight) {
        if (w.day === weekdayPart && currentMinutes >= startMinutes && currentMinutes < endMinutes) return true;
      } else {
        if (w.day === weekdayPart && currentMinutes >= startMinutes) return true;
        if (w.day === prevDayName && currentMinutes < endMinutes) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

Deno.serve(async (req) => {
  console.log("[auto-dispatch] Received request:", req.method);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Internal/cron callers: service-role key OR verified cron secret.
  const auth = await assertCronOrServiceRoleAuth(req);
  if (!auth.ok) return auth.response;

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.warn("[auto-dispatch] Rate limit exceeded for IP:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: DispatchRequest = await req.json();
    const { trip_id, force_rebroadcast = false, source = null } = body;

    console.log("[auto-dispatch] Processing trip:", trip_id, {
      force_rebroadcast,
      source,
    });

    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    // AUDIT HELPER â writes to public.dispatch_audit_log via secure RPC.
    // We collect promises in `auditPromises` and `await Promise.allSettled`
    // before returning so Deno does not abort them when the response ships.
    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const auditPromises: Array<Promise<unknown>> = [];
    const audit = (
      eventType: string,
      details: Record<string, unknown> = {},
      driverId: string | null = null,
      round: number | null = null,
    ) => {
      console.log(`[auto-dispatch][audit] ${eventType}`, { trip_id, driverId, round, ...details });
      auditPromises.push(
        Promise.resolve(
          supabase.rpc("log_dispatch_event", {
            p_trip_id: trip_id,
            p_event_type: eventType,
            p_round: round,
            p_driver_id: driverId,
            p_details: details,
          })
        ).then(({ error }: { error: unknown }) => {
          if (error) console.error("[auto-dispatch][audit] log_dispatch_event failed:", eventType, error);
        }),
      );
    };

    audit("trip_received", { force_rebroadcast });

    // Input validation
    const validationErrors: Record<string, string> = {};
    
    if (!trip_id) {
      validationErrors.trip_id = "trip_id is required";
    } else if (!isValidUUID(trip_id)) {
      validationErrors.trip_id = "trip_id must be a valid UUID";
    }

    if (body.service_area_id !== undefined && body.service_area_id !== null) {
      if (!isValidUUID(body.service_area_id)) {
        validationErrors.service_area_id = "service_area_id must be a valid UUID";
      }
    }

    if (Object.keys(validationErrors).length > 0) {
      return validationErrorResponse(validationErrors);
    }

    // 1. Fetch the trip
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("*")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      console.error("[auto-dispatch] Trip not found:", tripError);
      audit("dispatch_failed", { reason: "trip_not_found", error: tripError?.message ?? null });
      await Promise.allSettled(auditPromises);
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    audit("trip_loaded", {
      status: trip.status,
      dispatch_status: trip.dispatch_status,
      service_area_id: trip.service_area_id,
      vehicle_type_id: trip.vehicle_type_id,
      vehicle_type: trip.vehicle_type,
      pickup: { lat: trip.pickup_latitude, lng: trip.pickup_longitude },
      current_broadcast_round: trip.current_broadcast_round,
    });

    const effectiveVehicleTypeId = await resolveEffectiveVehicleTypeId(supabase, trip);
    audit("vehicle_type_selected", {
      effective_vehicle_type_id: effectiveVehicleTypeId,
      from_trip_vehicle_type_id: trip.vehicle_type_id,
      from_trip_vehicle_type_slug: trip.vehicle_type,
    });

    // Negotiation lock â a driver has initiated a preset fare negotiation.
    // Halt all wave expansion until negotiation completes (success â trip is taken;
    // failure â driver-fare-final / customer-fare-decision will release the owner
    // and reset dispatch_status before requesting a rebroadcast).
    if (trip.negotiation_owner_driver_id) {
      console.log("[auto-dispatch] Skipping trip â negotiation owner active:", trip.negotiation_owner_driver_id);
      return successResponse({
        success: false,
        error: "Trip negotiation in progress",
        trip_id,
        negotiation_owner_driver_id: trip.negotiation_owner_driver_id,
      });
    }

    // Check if trip is eligible for dispatch
    const eligibleStatuses = ["pending", "searching"];

    if (!eligibleStatuses.includes(trip.status) && !force_rebroadcast) {
      if (trip.status === "offered") {
        const nowIso = new Date().toISOString();
        const { data: activeOffers, error: activeOffersError } = await supabase
          .from("ride_offers")
          .select("id")
          .eq("trip_id", trip_id)
          .eq("status", "pending")
          .gt("expires_at", nowIso)
          .limit(1);

        if (activeOffersError) {
          console.error("[auto-dispatch] Failed checking active offers:", activeOffersError);
          return successResponse({
            success: false,
            error: "Failed to verify existing offers"
          });
        }

        if (activeOffers && activeOffers.length > 0) {
          console.log("[auto-dispatch] Trip already has active offers, skipping dispatch");
          return successResponse({
            success: true,
            trip_id,
            message: "Trip already offered"
          });
        }

        console.log("[auto-dispatch] Trip is offered but has no active offers, rebroadcasting");
      } else {
        console.log("[auto-dispatch] Trip not eligible for dispatch:", trip.status);
        return successResponse({
          success: false,
          error: "Trip not eligible for dispatch",
          status: trip.status
        });
      }
    }

    // 2. Get dispatch settings
    // Admin Auto-Dispatch Rules (global_dispatch_settings) is SSOT for
    // radius / waves / per-wave offer expiry / max rounds / presence age.
    // service-area dispatch_settings may override operational knobs only.
    const { data: adminDispatchSsot } = await supabase
      .from("global_dispatch_settings")
      .select("*")
      .eq("singleton", true)
      .maybeSingle();

    let settings = null;
    
    if (trip.service_area_id) {
      const { data: areaSettings } = await supabase
        .from("dispatch_settings")
        .select("*")
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();
      settings = areaSettings;
    }
    
    if (!settings) {
      const { data: globalSettings } = await supabase
        .from("dispatch_settings")
        .select("*")
        .is("service_area_id", null)
        .maybeSingle();
      settings = globalSettings;
    }

    if (!adminDispatchSsot) {
      console.error("[auto-dispatch] global_dispatch_settings singleton missing");
      return errorResponse(
        "DISPATCH_SSOT_MISSING",
        "Admin Auto-Dispatch Rules (global_dispatch_settings) not configured",
        500,
      );
    }

    // Idempotent rebroadcast: if pending offers already exist, do not open another wave.
    if (force_rebroadcast) {
      const { count: pendingExisting } = await supabase
        .from("ride_offers")
        .select("id", { count: "exact", head: true })
        .eq("trip_id", trip_id)
        .eq("status", "pending");
      if ((pendingExisting ?? 0) > 0) {
        console.log("[auto-dispatch] skip force_rebroadcast — pending offers already exist", {
          trip_id,
          pendingExisting,
          source,
        });
        return successResponse({
          success: true,
          trip_id,
          skipped: true,
          reason: "pending_offers_exist",
          offers_created: 0,
          source,
        });
      }
    }

    const dispatchSettings = {
      ...(settings || {}),
      // Admin panel SSOT wins for radius / waves / expiry / rounds / presence / scoring.
      wave1_size: adminDispatchSsot.wave1_size,
      wave2_size: adminDispatchSsot.wave2_size,
      wave3_size: adminDispatchSsot.wave3_size,
      wave1_offer_expiry_seconds: adminDispatchSsot.wave1_offer_expiry_seconds,
      wave2_offer_expiry_seconds: adminDispatchSsot.wave2_offer_expiry_seconds,
      wave3_offer_expiry_seconds: adminDispatchSsot.wave3_offer_expiry_seconds,
      max_broadcast_rounds: adminDispatchSsot.max_dispatch_rounds,
      max_dispatch_rounds: adminDispatchSsot.max_dispatch_rounds,
      presence_max_age_seconds: adminDispatchSsot.presence_max_age_seconds,
      start_radius_meters: adminDispatchSsot.start_radius_meters,
      expand_radius_meters: adminDispatchSsot.expand_radius_meters,
      max_radius_meters: adminDispatchSsot.max_radius_meters,
      distance_penalty_per_meter: adminDispatchSsot.distance_penalty_per_meter,
      waiting_bonus_per_minute: adminDispatchSsot.waiting_bonus_per_minute,
      max_waiting_bonus_minutes: adminDispatchSsot.max_waiting_bonus_minutes,
      fairness_boost_score: adminDispatchSsot.fairness_boost_score,
      fairness_idle_minutes: adminDispatchSsot.fairness_idle_minutes,
      degraded_driver_penalty: adminDispatchSsot.degraded_driver_penalty,
      stacked_rides_enabled:
        adminDispatchSsot.stacked_rides_enabled ??
        (settings as { stacked_rides_enabled?: boolean } | null)?.stacked_rides_enabled,
      stacked_search_radius_meters:
        adminDispatchSsot.stacked_search_radius_meters ??
        (settings as { stacked_search_radius_meters?: number } | null)?.stacked_search_radius_meters,
      max_stacked_rides:
        adminDispatchSsot.max_stacked_rides ??
        (settings as { max_stacked_rides?: number } | null)?.max_stacked_rides,
      batch_mode: (settings as { batch_mode?: string } | null)?.batch_mode || "parallel",
      cooldown_after_reject_seconds:
        (settings as { cooldown_after_reject_seconds?: number } | null)
          ?.cooldown_after_reject_seconds ?? 60,
      max_concurrent_offers_per_driver:
        (settings as { max_concurrent_offers_per_driver?: number } | null)
          ?.max_concurrent_offers_per_driver ?? 1,
    };

    const batchMode = dispatchSettings.batch_mode || "parallel";
    const cooldownSeconds = Number(dispatchSettings.cooldown_after_reject_seconds) || 60;
    const maxConcurrentOffers = Number(dispatchSettings.max_concurrent_offers_per_driver) || 1;
    // Admin Presence Max Age — used for heartbeat eligibility (no hard 180s override).
    const locationRecencySeconds = Number(dispatchSettings.presence_max_age_seconds);
    if (!(locationRecencySeconds > 0)) {
      return errorResponse(
        "DISPATCH_SSOT_INVALID",
        "presence_max_age_seconds missing from Admin Auto-Dispatch Rules",
        500,
      );
    }

    const startRadiusM = Number(dispatchSettings.start_radius_meters);
    const expandRadiusM = Number(dispatchSettings.expand_radius_meters);
    const maxRadiusM = Number(dispatchSettings.max_radius_meters);
    if (!(startRadiusM > 0) || !(expandRadiusM > 0) || !(maxRadiusM > 0)) {
      return errorResponse(
        "DISPATCH_SSOT_INVALID",
        "start/expand/max radius missing from Admin Auto-Dispatch Rules",
        500,
      );
    }

    // 3. Calculate broadcast round (moved up so we can use it for radius)
    const currentRound = (trip.current_broadcast_round || 0) + 1;
    const configuredMaxRounds =
      Number(dispatchSettings.max_dispatch_rounds) ||
      Number(trip.max_broadcast_rounds) ||
      0;
    if (!(configuredMaxRounds > 0)) {
      return errorResponse(
        "DISPATCH_SSOT_INVALID",
        "max_dispatch_rounds missing from Admin Auto-Dispatch Rules",
        500,
      );
    }
    const maxRounds = configuredMaxRounds;

    // Absolute Admin radii: start → expand → max (not additive increments).
    const effectiveRadiusM = radiusMetersForDispatchRound(currentRound, {
      startMeters: startRadiusM,
      expandMeters: expandRadiusM,
      maxMeters: maxRadiusM,
    });

    const waveOfferExpirySeconds = waveOfferExpirySecondsForRound(currentRound, {
      wave1: dispatchSettings.wave1_offer_expiry_seconds,
      wave2: dispatchSettings.wave2_offer_expiry_seconds,
      wave3: dispatchSettings.wave3_offer_expiry_seconds,
    });
    if (!(waveOfferExpirySeconds != null && waveOfferExpirySeconds > 0)) {
      return errorResponse(
        "DISPATCH_SSOT_INVALID",
        `wave${Math.min(currentRound, 3)}_offer_expiry_seconds missing from Admin Auto-Dispatch Rules`,
        500,
      );
    }

    console.log("[auto-dispatch] Using settings:", {
      trip_id,
      service_area_id: trip.service_area_id ?? null,
      gds_id: adminDispatchSsot.id ?? null,
      radiusThisRound: effectiveRadiusM,
      startRadius: startRadiusM,
      expandRadius: expandRadiusM,
      maxRadius: maxRadiusM,
      round: currentRound,
      maxRounds,
      waveOfferExpirySeconds,
      source,
      force_rebroadcast,
      batchMode,
      cooldownSeconds,
      presenceMaxAgeSeconds: locationRecencySeconds,
      stackedEnabled: dispatchSettings.stacked_rides_enabled,
      stackedRadius: dispatchSettings.stacked_search_radius_meters,
    });

    // (broadcast round already calculated above for radius expansion)

    if (currentRound > maxRounds) {
      console.log("[auto-dispatch] Max broadcast rounds reached:", currentRound);
      await supabase
        .from("trips")
        .update({ 
          dispatch_status: "expired",
          status: "expired",
          updated_at: new Date().toISOString()
        })
        .eq("id", trip_id);

      return errorResponse(
        "MAX_ROUNDS_EXCEEDED",
        "Max broadcast rounds exceeded",
        400,
        { round: currentRound, max_rounds: maxRounds }
      );
    }

    // 4. Find eligible drivers using presence-based dispatch
    //
    // HARD AVAILABILITY GUARDS — shared SSOT: rideOfferDriverEligibility.ts
    // (never trust client Online UI). Presence online + fresh heartbeat are HARD.
    // Backend presence.app_state must NEVER suppress an OS ride-offer push.
    //
    // DELIVERY RULE:
    //   • Active native push token => dispatchable even if realtime is degraded.
    //   • No push token => dispatchable ONLY with healthy foreground realtime.
    //
    // Every candidate — eligible OR rejected — is recorded via
    // log_dispatch_eligibility so ops can answer "why didn't driver X get this?".
    const pickupLat = trip.pickup_latitude || 0;
    const pickupLng = trip.pickup_longitude || 0;
    const nowIso = new Date().toISOString();
    // Admin Presence Max Age (global_dispatch_settings.presence_max_age_seconds).
    const heartbeatMaxAgeSeconds = locationRecencySeconds;
    const cooldownCutoff = new Date(Date.now() - cooldownSeconds * 1000).toISOString();

    // Helper: log an eligibility decision. Push the promise so it is awaited
    // before the function returns (Deno aborts unawaited promises on response).
    const logEligibility = (
      driverId: string,
      isEligible: boolean,
      reason: string,
      extra: Record<string, unknown> = {},
    ) => {
      console.log(
        `[auto-dispatch] eligibility driver=${driverId} eligible=${isEligible} reason=${reason} trip=${trip_id}`,
        extra,
      );
      auditPromises.push(
        Promise.resolve(
          supabase.rpc("log_dispatch_eligibility", {
            p_trip_id: trip_id,
            p_driver_id: driverId,
            p_is_eligible: isEligible,
            p_reject_reason: isEligible ? null : reason,
            p_context: { round: currentRound, ...extra },
          })
        ).then(({ error }: { error: unknown }) => {
          if (error) console.error("[auto-dispatch] log_dispatch_eligibility failed:", error);
        }),
      );
    };

    // Pull every online presence row â we apply hard gates explicitly afterwards
    // so we can log the EXACT reason each rejection happened.
    const { data: presenceDrivers, error: presenceError } = await supabase
      .from("driver_presence")
      .select(`
        driver_id,
        status,
        lat,
        lng,
        speed,
        last_heartbeat_at,
        last_gps_sample_at,
        push_token,
        app_state,
        socket_connected
      `)
      .eq("status", "online");

    // Pull driver rows with all hard-gate fields. We deliberately do NOT pre-
    // filter by status/approval here so every "almost eligible" candidate gets
    // a structured rejection row.
    const { data: allDrivers, error: driversError } = await supabase
      .from("drivers")
      .select(
        "id, current_lat, current_lng, current_trip_id, is_online, driver_online_intent, approval_status, driver_status, documents_approved, last_location_updated_at, last_gps_sample_at, speed, service_area_id, region_id, online_since",
      );

    const { data: pushTokenRows, error: pushTokensError } = await supabase
      .from("push_tokens")
      .select("driver_id, platform, updated_at, is_active")
      .eq("app_type", "driver")
      .eq("is_active", true);

    if (driversError || presenceError || pushTokensError) {
      console.error("[auto-dispatch] Error fetching drivers:", driversError || presenceError || pushTokensError);
      return errorResponse("DB_ERROR", "Failed to fetch drivers", 500);
    }

    const presenceMap = new Map((presenceDrivers || []).map(p => [p.driver_id, p]));
    const pushTokenMap = new Map<string, Array<{ platform: string; updated_at: string }>>();
    for (const row of pushTokenRows || []) {
      if (!row?.driver_id || !row?.platform) continue;
      const existing = pushTokenMap.get(row.driver_id) || [];
      existing.push({ platform: row.platform, updated_at: row.updated_at });
      pushTokenMap.set(row.driver_id, existing);
    }

    // Trip-level exclusions (cancel rematch, etc.)
    const tripExcludedDriverIds = new Set<string>(
      Array.isArray(trip.excluded_driver_ids)
        ? (trip.excluded_driver_ids as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
    );

    // ── Apply hard availability gates via shared SSOT ──
    const eligiblePresenceDrivers: Array<any> = [];

    for (const d of allDrivers || []) {
      const presence = presenceMap.get(d.id) ?? null;
      const registeredPushTokens = pushTokenMap.get(d.id) || [];
      const hasRegisteredPushToken = registeredPushTokens.length > 0;

      if (tripExcludedDriverIds.has(d.id)) {
        logEligibility(d.id, false, "driver_excluded");
        continue;
      }

      const gate = evaluateRideOfferDriverEligibility({
        driver: d,
        presence,
        hasActivePushToken: hasRegisteredPushToken,
        presenceMaxAgeSeconds: heartbeatMaxAgeSeconds,
        allowOnTrip: false,
        requireDeliveryChannel: true,
      });

      if (!gate.eligible) {
        const reason =
          gate.reason === "no_delivery_channel"
            ? "no_push_token_registered"
            : gate.reason;
        logEligibility(d.id, false, reason, {
          heartbeat_age_seconds: gate.heartbeatAgeSeconds,
          presence_status: presence?.status ?? null,
          socket_connected: presence?.socket_connected ?? null,
          // Observability only — never used to suppress OS push.
          presence_app_state: gate.presenceAppState,
          push_delivery_available: hasRegisteredPushToken,
        });
        continue;
      }

      const locationState = computeDriverLocationState({
        driverOnlineIntent: d.driver_online_intent ?? d.is_online,
        lastHeartbeatAt: presence?.last_heartbeat_at ?? null,
        lastGpsSampleAt: presence?.last_gps_sample_at ?? d.last_gps_sample_at ?? null,
        speed: presence?.speed ?? d.speed ?? null,
      });

      eligiblePresenceDrivers.push({
        ...d,
        current_lat: gate.resolvedLat,
        current_lng: gate.resolvedLng,
        push_token: presence?.push_token,
        has_registered_push_token: hasRegisteredPushToken,
        has_presence_push_token: !!presence?.push_token,
        app_state: presence?.app_state ?? null,
        is_foreground: presence?.app_state === "foreground",
        registered_push_platforms: registeredPushTokens.map((t) => t.platform),
        last_heartbeat_at: presence?.last_heartbeat_at ?? null,
        location_state: locationState,
        degraded: false,
        degraded_reasons: [],
        realtime_delivery_available: gate.realtimeDeliveryAvailable,
        push_delivery_available: hasRegisteredPushToken,
        effective_delivery_channel: gate.effectiveDeliveryChannel,
      });
    }

    console.log(
      "[auto-dispatch] Found",
      eligiblePresenceDrivers.length,
      "dispatchable drivers passing all hard gates (of",
      (allDrivers || []).length,
      "total drivers checked)",
    );

    // 5. Find stacked-eligible drivers
    let stackedDrivers: StackedDriver[] = [];
    
    const stackedMinTripDistanceKm = dispatchSettings.stacked_min_trip_distance_km || 3;
    const stackedMaxDetourMinutes = dispatchSettings.stacked_max_detour_minutes || 10;
    const stackedOfferWindowMinutes = dispatchSettings.stacked_offer_window_minutes || 5;
    
    if (dispatchSettings.stacked_rides_enabled) {
      console.log("[auto-dispatch] Stacked rides enabled, searching for busy drivers", {
        minTripDistanceKm: stackedMinTripDistanceKm,
        maxDetourMinutes: stackedMaxDetourMinutes,
        offerWindowMinutes: stackedOfferWindowMinutes,
      });

      // Global stacking / commitment policy (Admin SSOT) — SA dispatch_settings
      // only carries stacked_rides_enabled + radius/window knobs.
      const { data: globalStackingCfg } = await supabase
        .from("global_dispatch_settings")
        .select("*")
        .eq("singleton", true)
        .maybeSingle();
      const allowScheduledStacking = Boolean(
        globalStackingCfg?.allow_scheduled_stacking,
      );
      const allowAirportStacking = Boolean(
        globalStackingCfg?.allow_airport_stacking,
      );
      const allowPickupWaitingStacking = Boolean(
        globalStackingCfg?.allow_stacking_during_pickup_waiting,
      );
      const allowStopWaitingStacking = Boolean(
        globalStackingCfg?.allow_stacking_during_stop_waiting,
      );
      const commitmentPolicy = mapCommitmentPolicyFromDb(globalStackingCfg ?? null);
      const isAirportTrip = await resolveIsAirportTripForStacking(supabase, trip);

      // Check if the NEW trip meets minimum distance requirement
      const newTripDistanceKm = trip.estimated_distance_km || 0;
      if (newTripDistanceKm < stackedMinTripDistanceKm) {
        console.log("[auto-dispatch] New trip too short for stacking:", newTripDistanceKm, "km (min:", stackedMinTripDistanceKm, "km)");
      } else if (isAirportTrip && !allowAirportStacking) {
        console.log("[auto-dispatch] Airport trip blocked from stacking (allow_airport_stacking=false)");
      } else {
      
      // Build stacked driver pool (busy/on-trip drivers), then apply service-area checks
      const { data: busyDrivers, error: busyError } = await supabase
        .from("drivers")
        .select("id, current_lat, current_lng, current_trip_id, is_online, driver_online_intent, approval_status, service_area_id, region_id, last_gps_sample_at, speed")
        .eq("is_online", true)
        .eq("approval_status", "approved")
        .not("current_trip_id", "is", null);

      const busyDriverIds = (busyDrivers || []).map((d) => d.id);
      let stackedServiceAreaDriverIds = new Set<string>();

      // Stacked (Towards Destination) drivers are on an active trip, so their
      // driver_presence.status is typically "on_trip" — NOT covered by the
      // idle-path presenceMap above (queried with .eq("status","online")).
      // Fetch presence separately so the frozen check below has real data.
      const stackedPresenceMap = new Map<string, { last_heartbeat_at: string | null; last_gps_sample_at: string | null; speed: number | null }>();
      if (busyDriverIds.length > 0) {
        const { data: stackedPresenceRows } = await supabase
          .from("driver_presence")
          .select("driver_id, last_heartbeat_at, last_gps_sample_at, speed")
          .in("driver_id", busyDriverIds);
        for (const row of stackedPresenceRows || []) {
          stackedPresenceMap.set(row.driver_id, row);
        }
      }

      if (trip.service_area_id && busyDriverIds.length > 0) {
        const { data: mappedDrivers } = await supabase
          .from("driver_service_areas")
          .select("driver_id")
          .eq("service_area_id", trip.service_area_id)
          .in("driver_id", busyDriverIds);

        stackedServiceAreaDriverIds = new Set((mappedDrivers || []).map((row) => row.driver_id));
      }

      if (!busyError && busyDrivers && busyDrivers.length > 0) {
        console.log("[auto-dispatch] Found", busyDrivers.length, "busy drivers to check for stacking");

        const candidateJobMinutes = (() => {
          const fromTrip = Number(trip.estimated_duration_minutes);
          if (Number.isFinite(fromTrip) && fromTrip > 0) return fromTrip;
          // ~2 min/km urban fallback when duration is missing
          return Math.max(10, newTripDistanceKm * 2);
        })();

        for (const driver of busyDrivers) {
          // Push-token precheck (same hard gate as idle path): a stacked offer
          // must be deliverable via push since the driver is mid-trip with the
          // app likely backgrounded. No registered token → skip, next candidate.
          if (!pushTokenMap.has(driver.id)) {
            logEligibility(driver.id, false, "no_push_token_registered", { path: "stacked" });
            continue;
          }

          // ── HARD: frozen location (P0 fix, migration 20260910120000) ──────
          // Towards-Destination / stacked offers were not gated on this at all
          // prior to this fix — a driver whose GPS pipeline has stalled while
          // still on an active trip must not be offered a NEXT ride based on
          // an unverifiable position. Does not touch the active trip.
          const stackedPresence = stackedPresenceMap.get(driver.id);
          const stackedLocationState = computeDriverLocationState({
            driverOnlineIntent: driver.driver_online_intent ?? driver.is_online,
            lastHeartbeatAt: stackedPresence?.last_heartbeat_at ?? null,
            lastGpsSampleAt: stackedPresence?.last_gps_sample_at ?? driver.last_gps_sample_at ?? null,
            speed: stackedPresence?.speed ?? driver.speed ?? null,
          });
          if (stackedLocationState === "location_frozen") {
            logEligibility(driver.id, false, "location_frozen", {
              path: "stacked",
              last_heartbeat_at: stackedPresence?.last_heartbeat_at ?? null,
            });
            continue;
          }

          const { data: currentTrip } = await supabase
            .from("trips")
            .select("id, status, dropoff_latitude, dropoff_longitude, stacked_trip_id, started_at, estimated_duration_minutes, service_area_id, region_id")
            .eq("id", driver.current_trip_id)
            .single();

          if (!currentTrip) continue;

          const serviceAreaMatch = !trip.service_area_id ||
            driver.service_area_id === trip.service_area_id ||
            currentTrip.service_area_id === trip.service_area_id ||
            stackedServiceAreaDriverIds.has(driver.id);

          if (!serviceAreaMatch) {
            continue;
          }

          const regionMatch = !trip.region_id ||
            driver.region_id === trip.region_id ||
            currentTrip.region_id === trip.region_id;

          if (!regionMatch) {
            continue;
          }

          if (!["accepted", "arrived", "in_progress"].includes(currentTrip.status)) {
            continue;
          }

          // Pickup-waiting stacking requires explicit Admin flag.
          if (
            currentTrip.status === "arrived" &&
            !allowPickupWaitingStacking
          ) {
            logEligibility(driver.id, false, "pickup_waiting_stacking_blocked", {
              path: "stacked",
            });
            continue;
          }

          // Stop-waiting stacking requires explicit Admin flag.
          if (!allowStopWaitingStacking) {
            const { data: activeStopWait } = await supabase
              .from("trip_stop_waiting")
              .select("id")
              .eq("trip_id", currentTrip.id)
              .eq("driver_id", driver.id)
              .eq("status", "active")
              .limit(1)
              .maybeSingle();
            if (activeStopWait) {
              logEligibility(driver.id, false, "stop_waiting_stacking_blocked", {
                path: "stacked",
              });
              continue;
            }
          }

          if (currentTrip.stacked_trip_id) {
            continue;
          }

          // Offer window check: only offer stacked rides when current trip is nearing completion
          if (currentTrip.status === "in_progress" && currentTrip.started_at && currentTrip.estimated_duration_minutes) {
            const tripStartTime = new Date(currentTrip.started_at).getTime();
            const estimatedEndTime = tripStartTime + (currentTrip.estimated_duration_minutes * 60 * 1000);
            const minutesUntilEnd = (estimatedEndTime - Date.now()) / (60 * 1000);
            
            if (minutesUntilEnd > stackedOfferWindowMinutes) {
              console.log(`[auto-dispatch] Driver ${driver.id} trip not near completion (${Math.round(minutesUntilEnd)}min left, window: ${stackedOfferWindowMinutes}min)`);
              continue;
            }
          }

          const nowIso2 = new Date().toISOString();
          const { data: existingStackedOffers } = await supabase
            .from("ride_offers")
            .select("id")
            .eq("driver_id", driver.id)
            .eq("status", "pending")
            .eq("is_stacked", true)
            .gt("expires_at", nowIso2);

          if (existingStackedOffers && existingStackedOffers.length >= (dispatchSettings.max_stacked_rides || 1)) {
            continue;
          }

          // Fallback to driver's live location when trip dropoff is not yet persisted
          const dropoffLat = currentTrip.dropoff_latitude ?? driver.current_lat;
          const dropoffLng = currentTrip.dropoff_longitude ?? driver.current_lng;

          if (!dropoffLat || !dropoffLng) continue;

          const distanceFromDropoff = calculateDistance(dropoffLat, dropoffLng, pickupLat, pickupLng);

          if (distanceFromDropoff <= (dispatchSettings.stacked_search_radius_meters || 2000)) {
            // Max detour check: estimate detour time (assume 30 km/h urban speed)
            const detourMinutes = (distanceFromDropoff / 1000) * 2; // ~2 min per km
            if (detourMinutes > stackedMaxDetourMinutes) {
              console.log(`[auto-dispatch] Driver ${driver.id} detour too long: ${Math.round(detourMinutes)}min (max: ${stackedMaxDetourMinutes}min)`);
              continue;
            }

            // Full-queue feasibility vs later confirmed scheduled commitments.
            const { data: scheduledCommitments } = await supabase
              .from("trips")
              .select("id, scheduled_at, estimated_duration_minutes")
              .eq("confirmed_driver_id", driver.id)
              .eq("is_scheduled", true)
              .in("status", ["scheduled", "accepted", "arrived"])
              .not("scheduled_at", "is", null)
              .gte("scheduled_at", nowIso2)
              .order("scheduled_at", { ascending: true })
              .limit(10);

            const feasibility = gateStackedOfferAgainstScheduledCommitments({
              allowScheduledStacking,
              policy: commitmentPolicy,
              activeRemainingMinutes: estimateActiveRemainingMinutes(currentTrip),
              candidateDurationMinutes: detourMinutes + candidateJobMinutes,
              scheduledCommitments: (scheduledCommitments || []).map((row) => ({
                id: row.id,
                scheduledPickupAt: row.scheduled_at,
                estimatedJobMinutes: (() => {
                  const n = Number(row.estimated_duration_minutes);
                  return Number.isFinite(n) && n > 0 ? n : 30;
                })(),
              })),
              now: nowIso2,
            });

            if (!feasibility.allowed) {
              console.log(
                `[auto-dispatch] Driver ${driver.id} blocked by scheduled commitment gate: ${feasibility.reason}`,
              );
              logEligibility(driver.id, false, "scheduled_commitment_stacking_blocked", {
                path: "stacked",
                reason: feasibility.reason,
                delayed_commitment_id: feasibility.delayedCommitmentId ?? null,
              });
              continue;
            }

            stackedDrivers.push({
              ...driver,
              current_trip_dropoff_lat: dropoffLat,
              current_trip_dropoff_lng: dropoffLng,
              distance_from_current_dropoff: distanceFromDropoff,
              is_stacked: true,
            });
          }
        }
      }

      } // end min distance check

      console.log("[auto-dispatch] Found", stackedDrivers.length, "stacked-eligible drivers");
    }

    // 6. Filter and sort drivers
    const { data: existingOffers } = await supabase
      .from("ride_offers")
      .select("driver_id, status")
      .eq("trip_id", trip_id)
      .in("status", ["pending", "declined", "accepted"]);

    const excludedDriverIds = new Set((existingOffers || []).map(o => o.driver_id));

    // Voluntary decline cooldown ONLY — never expired/ack_timeout/delivery miss.
    // responded_at is reserved for driver responses (accept/decline), not misses.
    const { data: recentDeclines } = await supabase
      .from("ride_offers")
      .select("driver_id")
      .eq("trip_id", trip_id)
      .eq("status", "declined")
      .gt("responded_at", cooldownCutoff);
    
    const cooldownDriverIds = new Set((recentDeclines || []).map(o => o.driver_id));

    const { data: concurrentOffers } = await supabase
      .from("ride_offers")
      .select("driver_id")
      .eq("status", "pending")
      .gt("expires_at", nowIso);
    
    const offerCounts = new Map<string, number>();
    (concurrentOffers || []).forEach(o => {
      offerCounts.set(o.driver_id, (offerCounts.get(o.driver_id) || 0) + 1);
    });
    
    const maxedOutDriverIds = new Set(
      Array.from(offerCounts.entries())
        .filter(([_, count]) => count >= maxConcurrentOffers)
        .map(([driverId]) => driverId)
    );

    let disabledVehicleTypeDriverIds = new Set<string>();
    // For non-default vehicle types, only drivers with explicit is_enabled=true qualify
    let requiredVehicleTypeDriverIds: Set<string> | null = null;
    
    if (effectiveVehicleTypeId) {
      // Check if this is a default vehicle type (e.g. ONECAB/economy)
      const { data: vType } = await supabase
        .from("vehicle_types")
        .select("is_default")
        .eq("id", effectiveVehicleTypeId)
        .single();

      if (vType?.is_default) {
        // Default type: exclude only drivers who explicitly disabled it
        const { data: disabledCategories } = await supabase
          .from("driver_vehicle_categories")
          .select("driver_id")
          .eq("vehicle_type_id", effectiveVehicleTypeId)
          .eq("is_enabled", false);
        disabledVehicleTypeDriverIds = new Set((disabledCategories || []).map(c => c.driver_id));
      } else {
        // Non-default type (e.g. Pet-Friendly, XL): driver MUST have assignment with is_enabled=true
        const { data: enabledCategories } = await supabase
          .from("driver_vehicle_categories")
          .select("driver_id")
          .eq("vehicle_type_id", effectiveVehicleTypeId)
          .eq("is_enabled", true);
        requiredVehicleTypeDriverIds = new Set((enabledCategories || []).map(c => c.driver_id));
        console.log(`[auto-dispatch] Non-default vehicle type ${effectiveVehicleTypeId}: ${requiredVehicleTypeDriverIds.size} drivers have it enabled`);
      }
    }

    // 6a. Fetch driver settings (towards-destination + accept_cash + auto_accept + max_pickup_distance) for eligible + stacked drivers
    const eligibleDriverIds = eligiblePresenceDrivers.map(d => d.id);
    const stackedDriverIds = stackedDrivers.map(d => d.id);
    const allRelevantDriverIds = [...new Set([...eligibleDriverIds, ...stackedDriverIds])];

    // ââ Service-area eligibility (column OR junction-table) ââ
    // Single source of truth: a driver matches the trip's service area if EITHER
    //   â¢ drivers.service_area_id === trip.service_area_id, OR
    //   â¢ a row exists in driver_service_areas linking them
    // This prevents silent exclusion when only one source is populated.
    let serviceAreaMatchedDriverIds: Set<string> | null = null;
    const serviceAreaMatchSourceByDriverId = new Map<string, "direct" | "junction" | "both">();
    if (trip.service_area_id && eligibleDriverIds.length > 0) {
      const { data: mappedRows } = await supabase
        .from("driver_service_areas")
        .select("driver_id")
        .eq("service_area_id", trip.service_area_id)
        .in("driver_id", eligibleDriverIds);
      const mappedSet = new Set((mappedRows || []).map(r => r.driver_id));
      const matchedDriverIds: string[] = [];

      for (const d of eligiblePresenceDrivers) {
        const directMatch = (d as any).service_area_id === trip.service_area_id;
        const junctionMatch = mappedSet.has(d.id);

        if (!directMatch && !junctionMatch) continue;

        matchedDriverIds.push(d.id);
        serviceAreaMatchSourceByDriverId.set(
          d.id,
          directMatch && junctionMatch ? "both" : directMatch ? "direct" : "junction",
        );
      }

      serviceAreaMatchedDriverIds = new Set(matchedDriverIds);
      console.log(
        `[auto-dispatch] Service-area filter: ${serviceAreaMatchedDriverIds.size}/${eligibleDriverIds.length} drivers match service_area_id=${trip.service_area_id} (column or junction)`
      );
    }
    const { data: allDriverSettings } = await supabase
      .from("driver_settings")
      .select("driver_id, towards_destination_active, towards_destination_lat, towards_destination_lng, towards_destination_expires_at, accept_cash, auto_accept, max_pickup_distance_miles")
      .in("driver_id", allRelevantDriverIds.length > 0 ? allRelevantDriverIds : ["__none__"]);

    const nowMs = Date.now();
    const destinationMap = new Map(
      (allDriverSettings || [])
        .filter((ds) => {
          if (!ds.towards_destination_active || ds.towards_destination_lat == null || ds.towards_destination_lng == null) {
            return false;
          }
          if (ds.towards_destination_expires_at) {
            const exp = new Date(ds.towards_destination_expires_at).getTime();
            if (Number.isFinite(exp) && exp <= nowMs) return false;
          }
          return true;
        })
        .map((ds) => [ds.driver_id, { lat: ds.towards_destination_lat!, lng: ds.towards_destination_lng! }])
    );

    // Coords-only TD filter — never coerce missing pickup/dropoff to 0,0 (invalid_coords false-negative).
    const pickupLatForTd =
      typeof trip.pickup_latitude === "number" && Number.isFinite(trip.pickup_latitude)
        ? trip.pickup_latitude
        : null;
    const pickupLngForTd =
      typeof trip.pickup_longitude === "number" && Number.isFinite(trip.pickup_longitude)
        ? trip.pickup_longitude
        : null;
    const dropoffLat =
      typeof trip.dropoff_latitude === "number" && Number.isFinite(trip.dropoff_latitude)
        ? trip.dropoff_latitude
        : null;
    const dropoffLng =
      typeof trip.dropoff_longitude === "number" && Number.isFinite(trip.dropoff_longitude)
        ? trip.dropoff_longitude
        : null;

    // TD directional match config (SA override via resolve RPC; fallback to dispatch_settings / defaults)
    let tdMatchConfig = {
      matchingToleranceMeters: Number(dispatchSettings.towards_destination_matching_tolerance_meters ?? 200),
      minProgressMeters: Number(dispatchSettings.towards_destination_min_progress_meters ?? 100),
      maxPickupDetourMeters: Number(dispatchSettings.towards_destination_max_pickup_detour_meters ?? 8000),
    };
    try {
      const { data: tdCfg } = await supabase.rpc("towards_destination_resolve_config", {
        p_service_area_id: trip.service_area_id ?? null,
      });
      if (tdCfg && typeof tdCfg === "object") {
        const cfg = tdCfg as Record<string, unknown>;
        tdMatchConfig = {
          matchingToleranceMeters: Number(cfg.matching_tolerance_meters ?? tdMatchConfig.matchingToleranceMeters),
          minProgressMeters: Number(cfg.min_progress_meters ?? tdMatchConfig.minProgressMeters),
          maxPickupDetourMeters: Number(cfg.max_pickup_detour_meters ?? tdMatchConfig.maxPickupDetourMeters),
        };
      }
    } catch (e) {
      console.warn("[auto-dispatch] towards_destination_resolve_config failed; using dispatch_settings defaults", e);
    }

    const passesTowardsDestinationFilter = (driverId: string, driverLat: number, driverLng: number): boolean => {
      const dest = destinationMap.get(driverId);
      if (!dest) return true;
      if (
        pickupLatForTd == null ||
        pickupLngForTd == null ||
        dropoffLat == null ||
        dropoffLng == null
      ) {
        console.log(
          `[auto-dispatch] Skipping driver ${driverId} - towards destination requires trip pickup+dropoff coords`,
        );
        return false;
      }
      const result = towardsDestinationTripQualifies(
        {
          driverLat,
          driverLng,
          pickupLat: pickupLatForTd,
          pickupLng: pickupLngForTd,
          dropoffLat,
          dropoffLng,
          destLat: dest.lat,
          destLng: dest.lng,
        },
        tdMatchConfig,
      );
      if (!result.qualifies) {
        console.log(
          `[auto-dispatch] Skipping driver ${driverId} - towards destination no match (${result.reason}) progress=${result.progressMeters != null ? Math.round(result.progressMeters) : "n/a"}m`,
        );
        return false;
      }
      console.log(
        `[auto-dispatch] Driver ${driverId} towards destination MATCH - progress ${Math.round(result.progressMeters ?? 0)}m`,
      );
      return true;
    };


    // Build map of drivers with max_pickup_distance preference (in meters)
    const maxDistanceMap = new Map<string, number>(
      (allDriverSettings || [])
        .filter(ds => ds.max_pickup_distance_miles != null && ds.max_pickup_distance_miles > 0)
        .map(ds => [ds.driver_id, ds.max_pickup_distance_miles * 1609.34]) // Convert miles to meters
    );

    // Build set of drivers with auto_accept enabled
    const autoAcceptDriverIds = new Set(
      (allDriverSettings || [])
        .filter(ds => ds.auto_accept === true)
        .map(ds => ds.driver_id)
    );

    const isCashTrip = trip.payment_method === 'cash';
    const noCashDriverIds = new Set(
      (allDriverSettings || [])
        .filter(ds => ds.accept_cash === false)
        .map(ds => ds.driver_id)
    );

    // Commission-wallet eligibility (service-area payment mode) — same SQL gate
    // used by emergency dispatch_trip_offers.
    const walletIneligibleDriverIds = new Set<string>();
    const walletCheckIds = [
      ...new Set([
        ...eligiblePresenceDrivers.map((d: { id: string }) => d.id),
        ...stackedDrivers.map((d) => d.id),
      ]),
    ];
    for (const driverId of walletCheckIds) {
      const { data: walletOk, error: walletErr } = await supabase.rpc(
        "driver_passes_commission_wallet_dispatch_gate",
        { p_driver_id: driverId, p_trip_id: trip_id },
      );
      if (walletErr) {
        console.warn("[auto-dispatch] wallet gate RPC failed — excluding driver", driverId, walletErr);
        walletIneligibleDriverIds.add(driverId);
        logEligibility(driverId, false, "wallet_ineligible", { rpc_error: walletErr.message ?? String(walletErr) });
        continue;
      }
      if (walletOk === false) {
        walletIneligibleDriverIds.add(driverId);
        logEligibility(driverId, false, "wallet_ineligible");
      }
    }

    // Diagnostic + audit: log every secondary-filter rejection so ops can see
    // exactly why a hard-eligible driver still didn't receive this offer.
    for (const d of eligiblePresenceDrivers) {
      if (walletIneligibleDriverIds.has(d.id)) continue;
      if (serviceAreaMatchedDriverIds && !serviceAreaMatchedDriverIds.has(d.id)) {
        logEligibility(d.id, false, "service_area_mismatch", {
          trip_service_area_id: trip.service_area_id,
          driver_service_area_id: (d as any).service_area_id ?? null,
          service_area_match_source: null,
        });
        continue;
      }
      if (excludedDriverIds.has(d.id)) { logEligibility(d.id, false, "existing_offer_for_trip"); continue; }
      if (cooldownDriverIds.has(d.id)) { logEligibility(d.id, false, "cooldown_after_decline"); continue; }
      if (maxedOutDriverIds.has(d.id)) { logEligibility(d.id, false, "max_concurrent_offers", { max: maxConcurrentOffers }); continue; }
      if (disabledVehicleTypeDriverIds.has(d.id)) { logEligibility(d.id, false, "vehicle_type_disabled", { vehicle_type_id: effectiveVehicleTypeId }); continue; }
      if (requiredVehicleTypeDriverIds && !requiredVehicleTypeDriverIds.has(d.id)) { logEligibility(d.id, false, "missing_required_vehicle_category", { vehicle_type_id: effectiveVehicleTypeId }); continue; }
      if (isCashTrip && noCashDriverIds.has(d.id)) { logEligibility(d.id, false, "no_cash_preference"); continue; }
      if (!d.current_lat || !d.current_lng) { logEligibility(d.id, false, "no_location"); continue; }
      const dist = calculateDistance(pickupLat, pickupLng, d.current_lat!, d.current_lng!);
      if (dist > effectiveRadiusM) { logEligibility(d.id, false, "out_of_radius", { distance_meters: Math.round(dist), radius_meters: effectiveRadiusM }); continue; }
      const maxDist = maxDistanceMap.get(d.id);
      if (maxDist && dist > maxDist) { logEligibility(d.id, false, "exceeds_driver_max_pickup_distance", { distance_meters: Math.round(dist), max_meters: Math.round(maxDist) }); continue; }
      // Note: towards_destination filter is logged inside the .filter() chain below.
    }

    const eligibleIdleDrivers: Driver[] = eligiblePresenceDrivers
      .filter(d => !walletIneligibleDriverIds.has(d.id))
      .filter(d => !serviceAreaMatchedDriverIds || serviceAreaMatchedDriverIds.has(d.id))
      .filter(d => !excludedDriverIds.has(d.id))
      .filter(d => !cooldownDriverIds.has(d.id))
      .filter(d => !maxedOutDriverIds.has(d.id))
      .filter(d => !disabledVehicleTypeDriverIds.has(d.id))
      .filter(d => !requiredVehicleTypeDriverIds || requiredVehicleTypeDriverIds.has(d.id))
      .filter(d => !(isCashTrip && noCashDriverIds.has(d.id))) // Respect accept_cash preference
      .filter(d => d.current_lat && d.current_lng)
      .filter((d) => passesTowardsDestinationFilter(d.id, d.current_lat!, d.current_lng!))
      .map(d => {
        const distance_meters = calculateDistance(
          pickupLat,
          pickupLng,
          d.current_lat!,
          d.current_lng!,
        );
        const onlineSinceMs = d.online_since ? Date.parse(String(d.online_since)) : NaN;
        const waitingMinutes = Number.isFinite(onlineSinceMs)
          ? Math.max(0, (Date.now() - onlineSinceMs) / 60000)
          : 0;
        const dispatch_score = computeDispatchScore({
          distanceMeters: distance_meters,
          waitingMinutes,
          distancePenaltyPerMeter: Number(dispatchSettings.distance_penalty_per_meter) || 0,
          waitingBonusPerMinute: Number(dispatchSettings.waiting_bonus_per_minute) || 0,
          maxWaitingBonusMinutes: Number(dispatchSettings.max_waiting_bonus_minutes) || 0,
          fairnessBoostScore: Number(dispatchSettings.fairness_boost_score) || 0,
          fairnessIdleMinutes: Number(dispatchSettings.fairness_idle_minutes) || 0,
          categoryPriority: 0,
        });
        return {
          ...d,
          distance_meters,
          is_stacked: false,
          dispatch_score,
          waiting_minutes: waitingMinutes,
        };
      })
      .filter(d => d.distance_meters! <= effectiveRadiusM)
      .filter(d => {
        // Enforce driver's max_pickup_distance preference
        const maxDist = maxDistanceMap.get(d.id);
        if (maxDist && d.distance_meters! > maxDist) {
          console.log(`[auto-dispatch] Skipping driver ${d.id} - pickup ${Math.round(d.distance_meters!)}m exceeds their max ${Math.round(maxDist)}m`);
          return false;
        }
        return true;
      })
      // Higher Admin dispatch score first; distance tie-break.
      .sort((a, b) => {
        const scoreDelta = (b.dispatch_score ?? 0) - (a.dispatch_score ?? 0);
        if (scoreDelta !== 0) return scoreDelta;
        return a.distance_meters! - b.distance_meters!;
      });

    // Apply same-direction priority if configured
    const stackedPriorityMode = dispatchSettings.stacked_priority_mode || 'nearest';
    
    let filteredStackedDrivers: StackedDriver[] = stackedDrivers
      .filter(d => !walletIneligibleDriverIds.has(d.id))
      .filter(d => !excludedDriverIds.has(d.id))
      .filter(d => !cooldownDriverIds.has(d.id))
      .filter(d => !disabledVehicleTypeDriverIds.has(d.id))
      .filter(d => !requiredVehicleTypeDriverIds || requiredVehicleTypeDriverIds.has(d.id))
      .filter(d => !(isCashTrip && noCashDriverIds.has(d.id))) // Respect cash preference
      .filter((d) => {
        // Stacked: project from active trip dropoff as the driver's effective position
        const driverLat = d.current_trip_dropoff_lat ?? d.current_lat;
        const driverLng = d.current_trip_dropoff_lng ?? d.current_lng;
        if (driverLat == null || driverLng == null) return false;
        return passesTowardsDestinationFilter(d.id, driverLat, driverLng);
      });

    if (stackedPriorityMode === 'same_direction' && dropoffLat && dropoffLng) {
      // Score stacked drivers by how well the new trip aligns with their current route direction
      // A driver whose current dropoff â new pickup â new dropoff forms a roughly straight line scores higher
      const scored = filteredStackedDrivers.map(d => {
        // Vector from driver's current dropoff to new pickup
        const v1Lat = pickupLat - d.current_trip_dropoff_lat;
        const v1Lng = pickupLng - d.current_trip_dropoff_lng;
        // Vector from new pickup to new dropoff
        const v2Lat = dropoffLat - pickupLat;
        const v2Lng = dropoffLng - pickupLng;
        
        // Dot product for direction alignment (higher = more aligned)
        const dot = v1Lat * v2Lat + v1Lng * v2Lng;
        const mag1 = Math.sqrt(v1Lat * v1Lat + v1Lng * v1Lng);
        const mag2 = Math.sqrt(v2Lat * v2Lat + v2Lng * v2Lng);
        const alignment = (mag1 > 0 && mag2 > 0) ? dot / (mag1 * mag2) : 0;
        
        return { ...d, directionScore: alignment };
      });

      // Sort: same-direction first (highest alignment), then by distance
      scored.sort((a, b) => {
        // Prioritize drivers with positive alignment (same direction)
        if (a.directionScore > 0.3 && b.directionScore <= 0.3) return -1;
        if (b.directionScore > 0.3 && a.directionScore <= 0.3) return 1;
        // Among same-direction drivers, sort by distance
        return (a.distance_from_current_dropoff || 0) - (b.distance_from_current_dropoff || 0);
      });

      filteredStackedDrivers = scored;
      console.log("[auto-dispatch] Stacked drivers sorted by same-direction priority:", 
        scored.map(d => ({ id: d.id, alignment: (d as any).directionScore?.toFixed(2), dist: d.distance_from_current_dropoff }))
      );
    } else {
      filteredStackedDrivers.sort((a, b) => (a.distance_from_current_dropoff || 0) - (b.distance_from_current_dropoff || 0));
    }

    const eligibleStackedDrivers = filteredStackedDrivers;

    const configuredWaveBatchSize = waveBatchSizeForRound(currentRound, {
      wave1: dispatchSettings.wave1_size,
      wave2: dispatchSettings.wave2_size,
      wave3: dispatchSettings.wave3_size,
    });
    if (!(configuredWaveBatchSize != null && configuredWaveBatchSize > 0)) {
      return errorResponse(
        "DISPATCH_SSOT_INVALID",
        `wave${Math.min(currentRound, 3)}_size missing from Admin Auto-Dispatch Rules`,
        500,
      );
    }

    const batchSize = Math.max(
      1,
      batchMode === "parallel"
        ? configuredWaveBatchSize
        : configuredWaveBatchSize,
    );

    const combinedDrivers = [
      ...eligibleIdleDrivers.slice(0, batchSize),
      ...eligibleStackedDrivers.slice(0, Math.min(dispatchSettings.max_stacked_rides || 1, 2)),
    ];

    let uniqueDrivers = Array.from(new Map(combinedDrivers.map(d => [d.id, d])).values());

    console.log("[auto-dispatch] Batch mode:", batchMode, "| Batch size:", batchSize);
    console.log("[auto-dispatch] Eligible drivers after filtering:", uniqueDrivers.length);

    if (uniqueDrivers.length === 0) {
      console.log("[auto-dispatch] No eligible drivers found");

      if (currentRound >= maxRounds) {
        await supabase
          .from("trips")
          .update({ 
            dispatch_status: "expired",
            status: "expired",
            updated_at: new Date().toISOString()
          })
          .eq("id", trip_id);

        return successResponse({
          success: false,
          trip_id,
          error: "No drivers available and max rounds reached",
          offers_created: 0,
        });
      }

      await supabase
        .from("trips")
        .update({ 
          dispatch_status: "searching",
          status: "searching",
          current_broadcast_round: currentRound,
          updated_at: new Date().toISOString()
        })
        .eq("id", trip_id);

      return successResponse({
        success: true,
        trip_id,
        message: "No drivers available, waiting for next round",
        round: currentRound,
        offers_created: 0,
      });
    }

    // Hard rule 6: revalidate authoritative eligibility immediately before create.
    // Candidate selection may be seconds old; never insert for a driver who went
    // offline / stale between selection and offer creation.
    const driversToOffer: typeof uniqueDrivers = [];
    for (const driver of uniqueDrivers) {
      const { data: liveDriver } = await supabase
        .from("drivers")
        .select(
          "id, current_lat, current_lng, current_trip_id, is_online, driver_online_intent, approval_status, driver_status, documents_approved, last_gps_sample_at, speed",
        )
        .eq("id", driver.id)
        .maybeSingle();
      const { data: livePresence } = await supabase
        .from("driver_presence")
        .select(
          "status, lat, lng, last_heartbeat_at, last_gps_sample_at, speed, socket_connected, app_state, push_token",
        )
        .eq("driver_id", driver.id)
        .maybeSingle();
      const { count: liveTokenCount } = await supabase
        .from("push_tokens")
        .select("id", { count: "exact", head: true })
        .eq("driver_id", driver.id)
        .eq("app_type", "driver")
        .eq("is_active", true);

      const preCreate = evaluateRideOfferDriverEligibility({
        driver: liveDriver ?? { id: driver.id },
        presence: livePresence,
        hasActivePushToken: (liveTokenCount ?? 0) > 0,
        presenceMaxAgeSeconds: heartbeatMaxAgeSeconds,
        allowOnTrip: !!(driver as { is_stacked?: boolean }).is_stacked,
        requireDeliveryChannel: true,
      });

      if (!preCreate.eligible) {
        logEligibility(driver.id, false, `pre_create_${preCreate.reason}`, {
          stage: "before_offer_insert",
        });
        continue;
      }
      if (tripExcludedDriverIds.has(driver.id)) {
        logEligibility(driver.id, false, "pre_create_driver_excluded", {
          stage: "before_offer_insert",
        });
        continue;
      }
      const { data: walletOk } = await supabase.rpc(
        "driver_passes_commission_wallet_dispatch_gate",
        { p_driver_id: driver.id, p_trip_id: trip_id },
      );
      if (walletOk === false) {
        logEligibility(driver.id, false, "pre_create_wallet_ineligible", {
          stage: "before_offer_insert",
        });
        continue;
      }

      driversToOffer.push(driver);
    }

    if (driversToOffer.length === 0) {
      console.log("[auto-dispatch] All candidates failed pre-create revalidation");
      await supabase
        .from("trips")
        .update({
          dispatch_status: "searching",
          status: "searching",
          current_broadcast_round: currentRound,
          updated_at: new Date().toISOString(),
        })
        .eq("id", trip_id);
      return successResponse({
        success: true,
        trip_id,
        message: "No drivers passed pre-create eligibility revalidation",
        round: currentRound,
        offers_created: 0,
        source,
      });
    }

    // Replace wave list with only drivers that still pass live eligibility.
    uniqueDrivers = driversToOffer;

    // 7. Create offers for each driver — per-wave expiry from Admin Auto-Dispatch Rules.
    const offerExpirySeconds = waveOfferExpirySeconds;
    const expiresAt = new Date(Date.now() + offerExpirySeconds * 1000).toISOString();

    // 7a. Preset fare offers â built from admin panel config (see block below).
    let offerOptions: number[] | null = null;
    let offerSnapshot: any = null;

    // âââ PRESET GATE â ADMIN PANEL IS THE ONLY SOURCE OF TRUTH âââââââââââââ
    // Authority: `preset_offer_configs` (per service_area_id) + `preset_offers` rows.
    // Admin Panel â Services â Pricing & Fares â Offers & Payment â Preset Fare Offers.
    // No vehicle-pricing fallback. No dispatch_settings increment fallback.
    // If admin hasn't enabled it for this service area, drivers see the
    // standard fixed-fare card only â no chips.

    // âââ PRICING-PIPELINE EXCLUSIONS âââââââââââââââââââââââââââââââââââââââ
    // Preset Fare negotiation applies ONLY to normal instant standard rides.
    // Custom Zones / Corporate contracts / Scheduled / fare-locked
    // bookings have pricing controlled elsewhere and must bypass presets.
    const isScheduledRide =
      trip.is_scheduled === true ||
      trip.trip_type === "scheduled" ||
      trip.dispatch_mode === "scheduled";
    const isCustomZonePricing = !!(trip.pickup_zone_id || trip.dropoff_zone_id);
    const isCorporateContract = !!trip.corporate_account_id;
    const isFareLockedExternally = trip.fare_locked === true;
    const isStandardInstant =
      !isScheduledRide &&
      !isCustomZonePricing &&
      !isCorporateContract &&
      !isFareLockedExternally;

    const negotiationLockedNow =
      trip.negotiation_locked_until &&
      new Date(trip.negotiation_locked_until) > new Date();

    const canConsiderPresets =
      isStandardInstant && !negotiationLockedNow && !!trip.service_area_id;

    console.log("[auto-dispatch] Preset gate (admin-source):", {
      trip_id,
      service_area_id: trip.service_area_id,
      effectiveVehicleTypeId,
      isScheduledRide,
      isCustomZonePricing,
      isCorporateContract,
      isFareLockedExternally,
      isStandardInstant,
      negotiationLockedNow,
      canConsiderPresets,
    });

    if (canConsiderPresets) {
      // 1) Load the per-service-area config row.
      const { data: presetConfig, error: presetConfigErr } = await supabase
        .from("preset_offer_configs")
        .select(
          "id, is_enabled, price_mode, countdown_seconds, countdown_enabled, countdown_auto_select, countdown_auto_select_offer_id, default_selected_offer_id, schedule_enabled, schedule_days, schedule_start_time, schedule_end_time",
        )
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();

      if (presetConfigErr) {
        console.error("[auto-dispatch] preset_offer_configs read error:", presetConfigErr);
      }

      const adminEnabled = !!presetConfig?.is_enabled;

      // 2) Optional schedule window honoured exactly as admin configured.
      let withinSchedule = true;
      if (adminEnabled && presetConfig?.schedule_enabled) {
        const start = presetConfig.schedule_start_time ?? "00:00";
        const end = presetConfig.schedule_end_time ?? "23:59";
        const days: string[] = Array.isArray(presetConfig.schedule_days)
          ? presetConfig.schedule_days
          : [];
        withinSchedule = isWithinSchedule("Europe/London", [
          { days, start, end },
        ]);
      }

      if (adminEnabled && withinSchedule) {
        // 3) Load enabled offers in admin display order.
        const { data: adminOffers, error: offersErr } = await supabase
          .from("preset_offers")
          .select(
            "id, offer_key, label, fixed_amount_pence, multiplier, color, description, icon, display_order, is_active",
          )
          .eq("config_id", presetConfig!.id)
          .eq("is_active", true)
          .order("display_order", { ascending: true });

        if (offersErr) {
          console.error("[auto-dispatch] preset_offers read error:", offersErr);
        }

        const baseFarePence =
          trip.base_fare_pence || Math.round((trip.estimated_fare || 0) * 100);
        const priceMode = (presetConfig!.price_mode || "fixed").toLowerCase();
        const isMultiplierMode =
          priceMode === "multiplier" || priceMode === "percent";

        const richOptions = (adminOffers ?? []).map((o: any) => {
          const fixedPence = Number(o.fixed_amount_pence ?? 0);
          const multiplier = Number(o.multiplier ?? 1);
          const grossPence = isMultiplierMode
            ? Math.round(baseFarePence * multiplier)
            : baseFarePence + fixedPence;
          const configuredAmount = isMultiplierMode
            ? multiplier
            : fixedPence / 100;
          return {
            key: o.offer_key,
            label: o.label,
            description: o.description ?? null,
            icon: o.icon ?? null,
            configuredAmount,
            amount: grossPence / 100,
            amountPence: grossPence,
            grossFare: grossPence / 100,
            color: o.color,
          };
        });

        if (richOptions.length > 0) {
          offerOptions = [
            ...new Set(richOptions.map((o) => o.amountPence)),
          ] as number[];

          const countdownSeconds = presetConfig!.countdown_enabled === false
            ? waveOfferExpirySeconds
            : (presetConfig!.countdown_seconds ?? waveOfferExpirySeconds);

          offerSnapshot = {
            enabledForTrip: true,
            presetSource: "admin_preset_offer_configs",
            serviceAreaId: trip.service_area_id,
            baseFarePence,
            offerOptions,
            offerTimeoutSeconds: countdownSeconds,
            presetFareOffers: {
              enabled: true,
              priceMode: isMultiplierMode ? "multiplier" : "fixed_amount",
              countdownSeconds,
              defaultSelectedOfferKey: presetConfig!.default_selected_offer_id ?? null,
              autoSelectOnExpiry: !!presetConfig!.countdown_auto_select,
              autoSelectOfferKey: presetConfig!.countdown_auto_select_offer_id ?? null,
              options: richOptions,
            },
          };

          console.log("[auto-dispatch] presetFareOffers built from admin:", {
            service_area_id: trip.service_area_id,
            configId: presetConfig!.id,
            priceMode,
            baseFareGBP: baseFarePence / 100,
            configuredAmounts: richOptions.map((o) => o.configuredAmount),
            grossFaresGBP: richOptions.map((o) => o.grossFare),
            colors: richOptions.map((o) => o.color),
            countdownSeconds,
          });
        } else {
          console.log("[auto-dispatch] Admin has preset_offer_configs enabled but no active offers â skipping chips");
        }
      } else {
        console.log("[auto-dispatch] Preset chips skipped:", {
          adminEnabled,
          withinSchedule,
          scheduleEnabled: presetConfig?.schedule_enabled ?? false,
        });
      }
    }

    const offersToCreate = uniqueDrivers.map(driver => ({

      trip_id: trip_id,
      driver_id: driver.id,
      status: "pending",
      expires_at: expiresAt,
      offered_at: nowIso,
      broadcast_round: currentRound,
      is_stacked: driver.is_stacked || false,
      distance_meters: driver.distance_meters ? Math.round(driver.distance_meters) : null,
      created_at: nowIso,
      ...(offerOptions ? { offer_options: offerOptions, offer_snapshot: offerSnapshot } : {}),
    }));

    console.log("[auto-dispatch] offer_create_batch", {
      trip_id,
      service_area_id: trip.service_area_id ?? null,
      dispatch_round: currentRound,
      wave: Math.min(currentRound, 3),
      configured_expiry_seconds: offerExpirySeconds,
      expires_at: expiresAt,
      gds_id: adminDispatchSsot.id ?? null,
      source,
      driver_ids: uniqueDrivers.map((d) => d.id),
    });

    const { data: createdOffers, error: offerError } = await supabase
      .from("ride_offers")
      .insert(offersToCreate)
      .select();

    if (offerError) {
      // Unique (trip_id, driver_id, broadcast_round) → concurrent sweep already created this wave.
      const code = (offerError as { code?: string }).code;
      if (code === "23505") {
        console.log("[auto-dispatch] offer_insert_idempotent_skip", {
          trip_id,
          dispatch_round: currentRound,
          source,
          message: offerError.message,
        });
        return successResponse({
          success: true,
          trip_id,
          skipped: true,
          reason: "duplicate_wave_offers",
          round: currentRound,
          offers_created: 0,
          source,
        });
      }
      console.error("[auto-dispatch] Error creating offers:", offerError);
      return errorResponse("DB_ERROR", "Failed to create offers", 500);
    }

    // Audit: log every driver who actually received an offer, including the
    // delivery channel breakdown so ops can confirm web vs native delivery.
    for (const o of createdOffers || []) {
      const drv = uniqueDrivers.find(d => d.id === o.driver_id) as any;
      logEligibility(o.driver_id, true, "eligible", {
        offer_id: o.id,
        is_stacked: !!drv?.is_stacked,
        distance_meters: drv?.distance_meters ? Math.round(drv.distance_meters) : null,
        dispatch_score: drv?.dispatch_score ?? null,
        waiting_minutes: drv?.waiting_minutes ?? null,
        broadcast_round: currentRound,
        expires_at: expiresAt,
        configured_expiry_seconds: offerExpirySeconds,
        gds_id: adminDispatchSsot.id ?? null,
        source,
        service_area_match_source: serviceAreaMatchSourceByDriverId.get(o.driver_id) ?? null,
        trip_service_area_id: trip.service_area_id ?? null,
        driver_service_area_id: drv?.service_area_id ?? null,
        delivery: {
          realtime: !!drv?.realtime_delivery_available,
          push_attempted: !!drv?.has_registered_push_token,
          channel: drv?.effective_delivery_channel ?? null,
          app_state: drv?.app_state ?? null,
          registered_push_platforms: drv?.registered_push_platforms ?? [],
        },
      });
      console.log("[auto-dispatch] offer_created", {
        trip_id,
        offer_id: o.id,
        driver_id: o.driver_id,
        service_area_id: trip.service_area_id ?? null,
        dispatch_round: currentRound,
        wave: Math.min(currentRound, 3),
        configured_expiry_seconds: offerExpirySeconds,
        created_at: o.created_at ?? nowIso,
        expires_at: expiresAt,
        acknowledged_at: null,
        gds_id: adminDispatchSsot.id ?? null,
        source,
      });
    }

    // 8. SERVER-SIDE AUTO-ACCEPT: Check if nearest eligible driver has auto_accept enabled
    // This runs BEFORE updating trip status so only one driver can win the race.
    let autoAccepted = false;
    const nearestAutoAcceptOffer = (createdOffers || []).find(offer => {
      const driver = uniqueDrivers.find(d => d.id === offer.driver_id);
      if (!driver || driver.is_stacked) return false; // Don't auto-accept stacked offers
      return autoAcceptDriverIds.has(offer.driver_id);
    });

    if (nearestAutoAcceptOffer) {
      console.log("[auto-dispatch] AUTO-ACCEPT: Driver", nearestAutoAcceptOffer.driver_id, "has auto_accept enabled, accepting server-side");
      
      const { data: acceptResult, error: acceptError } = await supabase.rpc("accept_ride_offer", {
        p_offer_id: nearestAutoAcceptOffer.id,
        p_driver_id: nearestAutoAcceptOffer.driver_id,
      });

      if (acceptError) {
        console.error("[auto-dispatch] AUTO-ACCEPT RPC error:", acceptError);
      } else if (acceptResult?.success) {
        autoAccepted = true;
        console.log("[auto-dispatch] AUTO-ACCEPT: Success for trip", trip_id, "driver", nearestAutoAcceptOffer.driver_id);
        
        // Notify the driver via push notification
        try {
          await supabase.functions.invoke("send-driver-notification", {
            body: {
              driverId: nearestAutoAcceptOffer.driver_id,
              type: "RIDE_OFFER",
              title: "â Ride Auto-Accepted",
              body: `Ride from ${trip.pickup_address?.substring(0, 30) || 'nearby'} has been assigned to you`,
              data: {
                type: "ride_auto_accepted",
                offer_id: nearestAutoAcceptOffer.id,
                trip_id: trip_id,
              },
            },
          });
        } catch (notifErr) {
          console.error("[auto-dispatch] AUTO-ACCEPT notification error:", notifErr);
        }
      } else {
        console.log("[auto-dispatch] AUTO-ACCEPT: RPC returned failure:", acceptResult);
      }
    }

    // 9. Update trip status (only if not already auto-accepted)
    if (!autoAccepted) {
      await supabase
        .from("trips")
        .update({
          status: "offered",
          dispatch_status: "broadcasting",
          current_broadcast_round: currentRound,
          updated_at: new Date().toISOString(),
        })
        .eq("id", trip_id);
    }

    // 10. Send push notifications to remaining drivers (skip auto-accepted driver)
    // Flow: create offer → revalidate same driver → send only if still eligible.
    // Never suppress push because backend presence.app_state === 'foreground'.
    let revokedBeforePush = 0;
    for (const driver of uniqueDrivers as any[]) {
      try {
        const offer = (createdOffers || []).find(o => o.driver_id === driver.id);
        if (!offer) continue;
        
        // Skip the auto-accepted driver (already notified above) and skip revoked offers
        if (autoAccepted && offer.driver_id === nearestAutoAcceptOffer?.driver_id) continue;
        // If auto-accepted, other offers were revoked by accept_ride_offer RPC â don't notify
        if (autoAccepted) continue;

        // Push is native-only and best-effort. Web drivers receive the offer
        // exclusively via realtime â skip push invocation to avoid noise.
        const hasRegisteredToken = !!driver.has_registered_push_token;
        if (!hasRegisteredToken) {
          console.log(`[auto-dispatch] driver=${driver.id} channel=web push_skipped (no native token) â realtime delivery only`);
          continue;
        }

        // Revalidate authoritative eligibility immediately before push.
        const pushGate = await evaluateRideOfferPushGate(supabase, {
          driverId: driver.id,
          offerId: offer.id,
        });
        if (!pushGate.ok) {
          console.warn("[auto-dispatch] push_gate_skip", {
            trip_id,
            offer_id: offer.id,
            driver_id: driver.id,
            reason: pushGate.reason,
            revoke: pushGate.revoke,
          });
          if (pushGate.revoke) {
            const revoked = await revokeRideOfferNonDriverFault(supabase, {
              offerId: offer.id,
              reason: `ineligible_before_push:${pushGate.reason}`,
              deliveryPhase: "delivery_ineligible",
              extraTrace: {
                layer: "auto_dispatch_pre_push",
                gate_reason: pushGate.reason,
              },
            });
            if (revoked) revokedBeforePush += 1;
            logEligibility(driver.id, false, `push_revoked_${pushGate.reason}`, {
              offer_id: offer.id,
            });
          }
          continue;
        }

        const isStacked = driver.is_stacked || false;
        // Killed-state OS copy — approved static strings (no fare / pickup address).
        const notifTitle = DRIVER_NEW_RIDE_OFFER_TITLE;
        const notifBody = DRIVER_NEW_RIDE_OFFER_BODY;

        await supabase.functions.invoke("send-driver-notification", {
          body: {
            driverId: driver.id,
            type: "RIDE_OFFER",
            title: notifTitle,
            body: notifBody,
            data: {
              type: isStacked ? "stacked_ride_offer" : "ride_offer",
              offer_id: offer.id,
              trip_id: trip_id,
              expires_at: expiresAt,
              is_stacked: String(isStacked),
              queue_position: isStacked ? "1" : "0",
              pickupAddress: trip.pickup_address ?? '',
              dropoffAddress: trip.dropoff_address ?? '',
              // POST-DISCOUNT fare ONLY â drivers must see the same final
              // amount the customer pays. Order of preference:
              //   1. trip.fare              (post-discount major units)
              //   2. trip.final_fare_pence  (authoritative settled total)
              //   3. trip.gross_fare_pence  (post-discount engine total)
              //   4. trip.estimated_total_pence
              //   5. trip.estimated_fare    (pre-discount â last resort)
              fareAmount: trip.fare != null
                ? String(trip.fare)
                : trip.final_fare_pence != null
                  ? String(trip.final_fare_pence / 100)
                  : trip.gross_fare_pence != null
                    ? String(trip.gross_fare_pence / 100)
                    : trip.estimated_total_pence != null
                      ? String(trip.estimated_total_pence / 100)
                      : trip.estimated_fare != null
                        ? String(trip.estimated_fare)
                        : '',
              estimated_total_pence: trip.estimated_total_pence != null ? String(trip.estimated_total_pence) : '',
              gross_fare_pence: trip.gross_fare_pence != null ? String(trip.gross_fare_pence) : '',
              final_fare_pence: trip.final_fare_pence != null ? String(trip.final_fare_pence) : '',
              base_fare_pence: trip.base_fare_pence != null ? String(trip.base_fare_pence) : '',
              currencyCode: trip.currency_code ?? 'GBP',
            },
          },
        });

        // Fire-and-forget iOS background re-alert loop (10s, 20s, 30s within offer lifetime)
        const realertData: Record<string, string> = {
          type: isStacked ? "stacked_ride_offer" : "ride_offer",
          offer_id: offer.id,
          trip_id: trip_id,
          expires_at: expiresAt,
          is_stacked: String(isStacked),
          pickupAddress: trip.pickup_address ?? '',
          dropoffAddress: trip.dropoff_address ?? '',
          // POST-DISCOUNT fare â see fareAmount logic above for ordering rationale.
          fareAmount: trip.fare != null
            ? String(trip.fare)
            : trip.final_fare_pence != null
              ? String(trip.final_fare_pence / 100)
              : trip.gross_fare_pence != null
                ? String(trip.gross_fare_pence / 100)
                : trip.estimated_total_pence != null
                  ? String(trip.estimated_total_pence / 100)
                  : trip.estimated_fare != null
                    ? String(trip.estimated_fare)
                    : '',
          currencyCode: trip.currency_code ?? 'GBP',
        };
        fetch(`${supabaseUrl}/functions/v1/ios-offer-realert`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            offer_id: offer.id,
            driver_id: driver.id,
            trip_id: trip_id,
            title: notifTitle,
            body: notifBody,
            data: realertData,
          }),
        }).catch(e => console.warn("[auto-dispatch] ios-realert fire-and-forget error:", e));
      } catch (notifError) {
        console.error("[auto-dispatch] Failed to send notification to driver:", driver.id, notifError);
      }
    }

    // If every created offer was revoked before push, continue dispatch to
    // another eligible driver (same pattern as ack-timeout reassign).
    if (revokedBeforePush > 0 && (createdOffers?.length || 0) > 0) {
      const { count: pendingLeft } = await supabase
        .from("ride_offers")
        .select("id", { count: "exact", head: true })
        .eq("trip_id", trip_id)
        .eq("status", "pending");
      if ((pendingLeft ?? 0) === 0 && !autoAccepted) {
        console.log("[auto-dispatch] all offers revoked before push — scheduling redispatch", {
          trip_id,
          revokedBeforePush,
        });
        // Fire-and-forget to avoid recursion blocking this invocation.
        fetch(`${supabaseUrl}/functions/v1/auto-dispatch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            trip_id,
            force_rebroadcast: true,
            source: "pre_push_ineligible_reassign",
          }),
        }).catch((e) =>
          console.warn("[auto-dispatch] pre_push redispatch invoke failed:", e),
        );
      }
    }

    console.log("[auto-dispatch] Created", createdOffers?.length || 0, "offers for trip", trip_id, autoAccepted ? "(auto-accepted)" : "", `revoked_before_push=${revokedBeforePush}`);

    // ââ DISPATCH vs CUSTOMER-VISIBILITY AUDIT ââ
    // Customer "nearby drivers" is a VISUAL feature with stricter filters
    // (healthy presence only, freshness budget). Dispatch eligibility is the
    // backend operational truth. We log both counts so ops can verify that
    // dispatch still fires when customer_visible_drivers_count = 0 but
    // dispatch_eligible_count > 0.
    let customerVisibleCount: number | null = null;
    try {
      const { data: visibleRows } = await supabase.rpc("find_nearby_drivers", {
        p_lat: pickupLat,
        p_lng: pickupLng,
        p_radius_meters: effectiveRadiusM,
        p_limit: 80,
        p_stale_seconds: 600,
      });
      customerVisibleCount = Array.isArray(visibleRows) ? visibleRows.length : 0;
    } catch (e) {
      console.warn("[auto-dispatch] find_nearby_drivers audit call failed:", e);
    }

    audit("dispatch_summary", {
      customer_visible_drivers_count: customerVisibleCount,
      dispatch_candidate_count: eligiblePresenceDrivers.length,
      dispatch_degraded_count: eligiblePresenceDrivers.filter((d: any) => d.degraded).length,
      dispatch_eligible_count: uniqueDrivers.length,
      offer_created_count: createdOffers?.length || 0,
      effective_radius_meters: effectiveRadiusM,
      round: currentRound,
    }, null, currentRound);

    await Promise.allSettled(auditPromises);

    return successResponse({
      success: true,
      trip_id,
      round: currentRound,
      offers_created: createdOffers?.length || 0,
      auto_accepted: autoAccepted,
      auto_accepted_driver: autoAccepted ? nearestAutoAcceptOffer?.driver_id : null,
      dispatch_summary: {
        customer_visible_drivers_count: customerVisibleCount,
        dispatch_candidate_count: eligiblePresenceDrivers.length,
        dispatch_eligible_count: uniqueDrivers.length,
        offer_created_count: createdOffers?.length || 0,
      },
      drivers: uniqueDrivers.map(d => ({
        id: d.id,
        distance_meters: d.distance_meters,
        is_stacked: d.is_stacked,
        degraded: (d as any).degraded ?? false,
        degraded_reasons: (d as any).degraded_reasons ?? [],
      })),
    });

  } catch (error) {
    console.error("[auto-dispatch] Error:", error);
    return errorResponse("INTERNAL_ERROR", String(error), 500);
  }
});
