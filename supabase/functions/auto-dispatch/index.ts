import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireServiceRole } from "../_shared/edgeAuth.ts";
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
import { coercePositiveInt, realtimeFresh, REALTIME_FRESH_MAX_AGE_SECONDS } from "../_shared/dispatchGates.ts";
import {
  attachDriverCategoryPriority,
  compareDispatchCandidates,
  computeDispatchScore,
  destinationMatchRadiusMeters,
  dispatchOfferSnapshotFields,
  effectiveOfferExpirySeconds,
  effectiveRadiusMeters,
  extractDriverTierName,
  loadDispatchSettings,
  loadServiceAreaTierPriorityMap,
  maxBroadcastRounds,
  resolveWaveCommission,
  waveDriverCapForRound,
  waveOfferExpirySeconds,
} from "../_shared/dispatch-settings.ts";
import {
  enrichOfferSnapshotDriverNet,
} from "../_shared/driverOfferNetPreview.ts";
import {
  recordDispatchWaveSnapshot,
  type DispatchWaveSnapshotStage,
} from "../_shared/recordDispatchWaveSnapshot.ts";
import {
  buildPriorDispatchRecheckState,
  type PriorDriverDispatchRecheckState,
  canonicalizeDispatchRejectReason,
  classifyDispatchExclusion,
  computeDispatchRecheckAdminLabel,
  DISPATCHABLE_DEGRADED,
  evaluateDispatchableReadiness,
  isDispatchRecheckableReason,
} from "../_shared/dispatchEligibilityPolicy.ts";
import { reconcileTripServiceAreaFromPickup } from "../_shared/resolveTripServiceArea.ts";
import {
  pickupSummaryForRideOfferPush,
  RIDE_OFFER_IOS_ALERT_SOUND,
  tripReferenceForRideOfferPush,
} from "../_shared/rideOfferPushCopy.ts";
import {
  driverNetPenceFromOfferContext,
  rideOfferPushBodyDriverNet,
} from "../_shared/driverOfferPushCopy.ts";
import { DRIVER_NEW_RIDE_OFFER_TITLE } from "../_shared/negotiationPushCopy.ts";
import { deriveOfferOptionsPence } from "../_shared/presetOptionsCanonical.ts";
import {
  isScheduledTripIneligibleForPresetNegotiation,
  presetNegotiationSnapshotFields,
  presetNegotiationSourceIneligibility,
  resolvePresetNegotiation,
  stackedOfferNegotiationLockFields,
} from "../_shared/presetNegotiationEligibility.ts";
import { resolveNegotiationBaseFarePence } from "../_shared/negotiationBaseFare.ts";
import { tripFareFieldsForOfferSnapshot } from "../_shared/tripFareSnapshot.ts";
import {
  isCustomerSearchWindowActive,
  resolveCustomerSearchDeadlineMs,
  resolveDispatchBroadcastRound,
  shouldExpireTripAfterWavesExhausted,
  WAVE3_NO_ELIGIBLE_LOG_TOKEN,
} from "../_shared/dispatchSearchWindow.ts";
import { isScheduledInstantConversionPending } from "../_shared/scheduledHandoverHoldLock.ts";
import { expireTripWhenSearchExhaustedAndNotifyCustomer } from "../_shared/customerTripLifecycleNotify.ts";
import { finalizeRideAssignmentSideEffects } from "../_shared/rideAssignmentFinalize.ts";
import {
  blockedTerminalTripLogPayload,
  isTripTerminalForDispatch,
} from "../_shared/tripTerminalDispatch.ts";
import {
  evaluateStackedDriverEligibility,
  loadStackedRideConfig,
  logStackedEligibilityCheck,
  logStackedGateAudit,
  logStackedRideDisabledSafeGuard,
  type StackedRideConfig,
} from "../_shared/stackedRideConfig.ts";
import {
  evaluateStackedProximityRadiusGate,
} from "../_shared/stackedRideMatching.ts";
import { evaluateDriverDocumentState } from "../_shared/driverDocumentEligibility.ts";
import {
  loadActiveTripDriverIds,
  resolveDriverActiveTripId,
} from "../_shared/activeDriverTripGuard.ts";
import { STACKED_RIDE_STATES } from "../_shared/stackedRideState.ts";

declare const EdgeRuntime:
  | { waitUntil?: (promise: Promise<unknown>) => void }
  | undefined;

// Rate limit: 100 requests per minute
const RATE_LIMIT_CONFIG = { limit: 100, windowMs: 60000, keyPrefix: 'auto-dispatch' };

interface DispatchRequest {
  trip_id: string;
  service_area_id?: string;
  force_rebroadcast?: boolean;
  trigger_reason?: string;
  /** Phase 4 â why the next wave is running (e.g. offer_expired after expire-offers sweep). */
  reason_for_next_wave?: string | null;
  declined_driver_id?: string;
}

interface Driver {
  id: string;
  current_lat: number;
  current_lng: number;
  current_trip_id: string | null;
  distance_meters?: number;
  is_stacked?: boolean;
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

/** True if UTC timestamp >= cutoff iso (presence / drivers row freshness). */
function timestampAtOrAfterCutoff(ts: string | null | undefined, cutoffIso: string): boolean {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= new Date(cutoffIso).getTime();
}

/**
 * Idle dispatch freshness is shared with admin effective-online state.
 * Drivers must stay fresh on heartbeat, location, realtime posture, and
 * push-token registration before dispatch may consider them.
 */
function heartbeatFreshEnough(
  presence: { last_heartbeat_at?: string | null },
  driverRow: { last_seen_at?: string | null },
  cutoffIso: string,
): boolean {
  return (
    timestampAtOrAfterCutoff(presence.last_heartbeat_at ?? null, cutoffIso) ||
    timestampAtOrAfterCutoff(driverRow.last_seen_at ?? null, cutoffIso)
  );
}

function queueReminderRequest(promise: Promise<unknown>) {
  if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(promise);
    return;
  }
  void promise;
}

function locationFreshEnough(
  presence: { last_location_at?: string | null },
  driverRow: { last_location_updated_at?: string | null },
  cutoffIso: string,
): boolean {
  return (
    timestampAtOrAfterCutoff(presence.last_location_at ?? null, cutoffIso) ||
    timestampAtOrAfterCutoff(driverRow.last_location_updated_at ?? null, cutoffIso)
  );
}

/** Coordinates for proximity: presence lat/lng first, else mirrored drivers.current_lat/lng */
function coordsForDispatch(
  presence: { lat?: number | null; lng?: number | null },
  driverRow: { current_lat?: number | null; current_lng?: number | null },
): { lat: number; lng: number } | null {
  const pl = presence.lat;
  const pq = presence.lng;
  if (typeof pl === "number" && typeof pq === "number" && Number.isFinite(pl) && Number.isFinite(pq)) {
    return { lat: pl, lng: pq };
  }
  const dl = driverRow.current_lat;
  const dq = driverRow.current_lng;
  if (typeof dl === "number" && typeof dq === "number" && Number.isFinite(dl) && Number.isFinite(dq)) {
    return { lat: dl, lng: dq };
  }
  return null;
}

function secondsSinceIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 1000);
}

function isExplicitOfflineReason(reason: string | null | undefined): boolean {
  const normalized = String(reason ?? "").trim().toLowerCase();
  return [
    "manual_go_offline",
    "manual_logout",
    "logout",
    "session_invalid",
    "token_refresh_failed",
    "admin_force_offline",
    "active_device_takeover",
  ].includes(normalized);
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

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.warn("[auto-dispatch] Rate limit exceeded for IP:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  // Auth check
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = await requireServiceRole(req, supabaseKey);
  if (!auth.ok) {
    console.warn("[auto-dispatch] Unauthorized request blocked");
    return auth.response;
  }

  const auditPromises: Array<Promise<unknown>> = [];
  const flushAudits = () => Promise.allSettled(auditPromises);
  let auditTripId: string | null = null;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: DispatchRequest = await req.json();
    const { trip_id, force_rebroadcast = false, trigger_reason, declined_driver_id } = body;
    auditTripId = trip_id ?? null;
    const triggerReasonResolved =
      trigger_reason ?? (force_rebroadcast ? "force_rebroadcast" : "initial_dispatch");
    const reasonForNextWave =
      body.reason_for_next_wave ??
      (triggerReasonResolved === "offer_expired" ? "offer_expired" : null);

    console.log("[auto-dispatch] Processing trip:", trip_id, {
      trigger_reason: triggerReasonResolved,
      reason_for_next_wave: reasonForNextWave,
    });

    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    // AUDIT HELPER â writes to public.dispatch_audit_log via secure RPC.
    // We collect promises in `auditPromises` and flush before returning so
    // Deno does not abort eligibility/audit RPCs when the response ships.
    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

    audit("trip_received", {
      force_rebroadcast,
      trigger_reason: triggerReasonResolved,
      reason_for_next_wave: reasonForNextWave,
      declined_driver_id: declined_driver_id ?? null,
    });

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

    if (String(trip.payment_method ?? "").toLowerCase() === "cash" && !trip.cash_authorized_at) {
      audit("dispatch_failed", { reason: "historical_or_unauthorized_cash_trip" });
      await Promise.allSettled(auditPromises);
      return errorResponse(
        "CASH_TRIP_NOT_AUTHORIZED",
        "This cash trip was not authorized by the service-area cash policy.",
        409,
      );
    }

    audit("trip_loaded", {
      status: trip.status,
      dispatch_status: trip.dispatch_status,
      scheduled_status: trip.scheduled_status,
      service_area_id: trip.service_area_id,
      vehicle_type_id: trip.vehicle_type_id,
      vehicle_type: trip.vehicle_type,
      pickup: { lat: trip.pickup_latitude, lng: trip.pickup_longitude },
      current_broadcast_round: trip.current_broadcast_round,
    });

    if (isTripTerminalForDispatch(trip)) {
      const terminalPayload = blockedTerminalTripLogPayload(trip, triggerReasonResolved, {
        trip_id,
      });
      console.log("[auto-dispatch] blocked_terminal_trip", terminalPayload);
      audit("dispatch_aborted", {
        reason: "blocked_terminal_trip",
        ...terminalPayload,
      });
      await Promise.allSettled(auditPromises);
      return successResponse({
        success: false,
        error: "Trip is terminal; dispatch blocked",
        trip_id,
        dispatch_aborted: true,
        blocked_terminal_trip: true,
      });
    }

    let saReconcile: Awaited<ReturnType<typeof reconcileTripServiceAreaFromPickup>> = null;
    try {
      saReconcile = await reconcileTripServiceAreaFromPickup(supabase, trip);
    } catch (saErr) {
      audit("dispatch_failed", {
        reason: "service_area_reconcile_error",
        error: saErr instanceof Error ? saErr.message : String(saErr),
      });
      return errorResponse(
        "INTERNAL_ERROR",
        "Service area reconcile failed",
        500,
      );
    }
    if (saReconcile?.correction_applied && saReconcile.final_service_area_id) {
      trip.service_area_id = saReconcile.final_service_area_id;
      trip.service_area_code = saReconcile.final_service_area_code ?? trip.service_area_code;
      trip.region_id = saReconcile.region_id ?? trip.region_id;
      audit("service_area_corrected_from_pickup", {
        selected_service_area_id: saReconcile.selected_service_area_id,
        geofence_service_area_id: saReconcile.geofence_service_area_id,
        final_service_area_id: saReconcile.final_service_area_id,
        correction_applied: true,
      });
    } else if (saReconcile && !saReconcile.final_service_area_id) {
      audit("dispatch_failed", { reason: "pickup_outside_service_area" });
      await Promise.allSettled(auditPromises);
      return errorResponse(
        "PICKUP_OUTSIDE_SERVICE_AREA",
        "Pickup is outside active service areas.",
        400,
        saReconcile,
      );
    }

    let effectiveVehicleTypeId: string | null = null;
    try {
      effectiveVehicleTypeId = await resolveEffectiveVehicleTypeId(supabase, trip);
    } catch (vehicleTypeErr) {
      audit("dispatch_failed", {
        reason: "vehicle_type_resolve_error",
        error: vehicleTypeErr instanceof Error ? vehicleTypeErr.message : String(vehicleTypeErr),
      });
      return errorResponse("INTERNAL_ERROR", "Vehicle type resolve failed", 500);
    }
    audit("vehicle_type_selected", {
      effective_vehicle_type_id: effectiveVehicleTypeId,
      from_trip_vehicle_type_id: trip.vehicle_type_id,
      from_trip_vehicle_type_slug: trip.vehicle_type,
    });

    const abortDispatch = (
      reason: string,
      extra: Record<string, unknown> = {},
    ) => {
      audit("dispatch_aborted", {
        reason,
        trip_id,
        vehicle_type_id: effectiveVehicleTypeId ?? trip.vehicle_type_id ?? null,
        service_area_id: trip.service_area_id ?? null,
        current_round: trip.current_broadcast_round ?? 0,
        ...extra,
      });
    };

    if (!effectiveVehicleTypeId) {
      abortDispatch("VEHICLE_TYPE_MISSING", {
        from_trip_vehicle_type_id: trip.vehicle_type_id ?? null,
        from_trip_vehicle_type_slug: trip.vehicle_type ?? null,
      });
      return errorResponse(
        "VEHICLE_TYPE_MISSING",
        "Trip has no vehicle type; dispatch cannot continue",
        422,
        {
          trip_id,
          vehicle_type_id: trip.vehicle_type_id ?? null,
          service_area_id: trip.service_area_id ?? null,
        },
      );
    }

    trip.vehicle_type_id = effectiveVehicleTypeId;

    // Locked-driver / broadcast-disabled trips â never auto-dispatch.
    // Scan & Go retired (no trips.scan_go column).
    if (
      trip.dispatch_mode === "locked_driver"
      || (trip.dispatch_mode === "scan_and_go" && trip.dispatch_status === "locked")
      || trip.broadcast_enabled === false
    ) {
      console.log("[auto-dispatch] Skipping locked-driver trip:", trip_id);
      abortDispatch("LOCKED_DRIVER_TRIP");
      return successResponse({
        success: false,
        error: "Trip is locked to a specific driver",
        trip_id,
      });
    }

    // Negotiation lock â a driver has initiated a preset fare negotiation.
    // Halt all wave expansion until negotiation completes (success â trip is taken;
    // failure â driver-fare-final / customer-fare-decision will release the owner
    // and reset dispatch_status before requesting a rebroadcast).
    if (trip.negotiation_owner_driver_id) {
      console.log("[auto-dispatch] Skipping trip â negotiation owner active:", trip.negotiation_owner_driver_id);
      abortDispatch("NEGOTIATION_IN_PROGRESS", {
        negotiation_owner_driver_id: trip.negotiation_owner_driver_id,
      });
      return successResponse({
        success: false,
        error: "Trip negotiation in progress",
        trip_id,
        negotiation_owner_driver_id: trip.negotiation_owner_driver_id,
      });
    }

    // Check if trip is eligible for dispatch
    // 'stacked_rebroadcasting' = formerly-queued stacked trip being re-broadcast after driver failure
    // 'offered_stacked' = trip offered only to stacked (busy) drivers; eligible for re-broadcast
    const eligibleStatuses = ["pending", "searching", "searching_new_driver", "broadcasting", "offered", "stacked_rebroadcasting", "offered_stacked"];
    /** Phase 5: SQL trigger inserts ride_offers only for scan_go trips; normal bookings rely on this edge. */
    let enrichExistingOffersMode = false;

    if (force_rebroadcast) {
      enrichExistingOffersMode = false;
      audit("force_rebroadcast_wave", {
        trip_status: trip.status,
        current_broadcast_round: trip.current_broadcast_round ?? 0,
        trigger_reason: triggerReasonResolved,
        reason_for_next_wave: reasonForNextWave,
      });
      if (reasonForNextWave === "offer_expired") {
        audit("offer_expired", {
          prior_broadcast_round: trip.current_broadcast_round ?? 0,
          trigger_reason: triggerReasonResolved,
        });
        console.log("[auto-dispatch] offer_expired", {
          trip_id,
          reason_for_next_wave: reasonForNextWave,
          prior_broadcast_round: trip.current_broadcast_round ?? 0,
        });
      }
    }

    // ââ Active-offer guard ââââââââââââââââââââââââââââââââââââââââââââââââ
    // Legacy guard: if SQL wave-1 offers exist (scan_go / pre-Phase-5), enrich or skip duplicate round
    // edge function runs (called from create-ride). Without this guard,
    // auto-dispatch burns a new round on top of SQL round-1, accelerating
    // trip expiration â the root cause of "Trip is no longer available"
    // when drivers tap preset chips or Accept.
    if (!force_rebroadcast) {
      const nowIso = new Date().toISOString();
      const { data: activeOffers, error: activeOffersError } = await supabase
        .from("ride_offers")
        .select("id, offer_options")
        .eq("trip_id", trip_id)
        .eq("status", "pending")
        .gt("expires_at", nowIso);

      if (activeOffersError) {
        console.error("[auto-dispatch] Failed checking active offers:", activeOffersError);
        abortDispatch("ACTIVE_OFFERS_CHECK_FAILED", {
          error: activeOffersError.message ?? String(activeOffersError),
        });
        return successResponse({
          success: false,
          error: "Failed to verify existing offers"
        });
      }

      if (activeOffers && activeOffers.length > 0) {
        const needsPresetEnrichment = activeOffers.some(
          (o) => !o.offer_options || (Array.isArray(o.offer_options) && o.offer_options.length < 3),
        );
        if (!needsPresetEnrichment) {
          console.log("[auto-dispatch] Trip already has active offers with presets, skipping dispatch", {
            trip_id,
            active_offer_count: activeOffers.length,
            trip_status: trip.status,
          });
          abortDispatch("TRIP_ALREADY_OFFERED", {
            active_offer_count: activeOffers.length,
            trip_status: trip.status,
          });
          return successResponse({
            success: true,
            trip_id,
            message: "Trip already offered"
          });
        }
        enrichExistingOffersMode = true;
        console.log("[auto-dispatch] DRIVERS_REACHED_VIA_SQL_OFFERS", {
          trip_id,
          trip_number: (trip as { trip_number?: string | null }).trip_number ?? null,
          pending_offer_count: activeOffers.length,
          needs_preset_enrichment: true,
        });
      }
    }

    if (!eligibleStatuses.includes(trip.status) && !force_rebroadcast) {
      console.log("[auto-dispatch] Trip not eligible for dispatch:", trip.status);
      abortDispatch("TRIP_NOT_ELIGIBLE", { trip_status: trip.status });
      return successResponse({
        success: false,
        error: "Trip not eligible for dispatch",
        status: trip.status
      });
    }

    // 2. Get dispatch settings (service area row → global row → schema defaults)
    let dispatchSettings: Awaited<ReturnType<typeof loadDispatchSettings>>;
    let stackedRideConfig: StackedRideConfig;
    let tierPriorityMap: Map<string, number>;
    try {
      dispatchSettings = await loadDispatchSettings(supabase, trip.service_area_id);
      stackedRideConfig = await loadStackedRideConfig(supabase, trip.service_area_id);
      tierPriorityMap = await loadServiceAreaTierPriorityMap(supabase, trip.service_area_id);
      if (!stackedRideConfig.operational) {
        logStackedRideDisabledSafeGuard(
          { trip_id, service_area_id: trip.service_area_id ?? null },
          stackedRideConfig,
        );
      }
    } catch (settingsErr) {
      const settingsErrorMessage =
        settingsErr instanceof Error ? settingsErr.message : String(settingsErr);
      console.error("[auto-dispatch] dispatch_settings_load_error:", settingsErrorMessage, settingsErr);
      audit("dispatch_failed", {
        reason: "dispatch_settings_load_error",
        error: settingsErrorMessage,
        service_area_id: trip.service_area_id ?? null,
      });
      await flushAudits();
      return errorResponse(
        "INTERNAL_ERROR",
        "Failed to load dispatch settings",
        500,
        { trip_id, error: settingsErrorMessage },
      );
    }

    const settingsSource = dispatchSettings._source;
    audit("dispatch_settings_loaded", {
      settings_source: settingsSource,
      service_area_id: trip.service_area_id ?? null,
      tier_priority_tiers_loaded: tierPriorityMap.size,
    });

    const batchMode = dispatchSettings.batch_mode || 'parallel';
    const maxOffersPerRequest = coercePositiveInt(dispatchSettings.max_offers_per_request) ?? 5;
    const cooldownSeconds = coercePositiveInt(dispatchSettings.cooldown_after_reject_seconds) ?? 180;
    const maxConcurrentOffers = coercePositiveInt(dispatchSettings.max_concurrent_offers_per_driver) ?? 1;
    const suppressSeconds = coercePositiveInt(dispatchSettings.suppress_recent_offers_seconds) ?? 60;
    const locationRecencySeconds = 20;

    // ── PROGRESSIVE RADIUS + 3-WAVE CYCLE SEQUENCES ──
    // current_broadcast_round stores absolute sequence (1…max_dispatch_rounds×3).
    // Wave = ((seq-1)%3)+1; Round = floor((seq-1)/3)+1.
    const storedRound = trip.current_broadcast_round || 0;
    let searchWindowActive = true;
    let currentRound = storedRound + 1;
    let maxRounds = coercePositiveInt(trip.max_broadcast_rounds) ?? 9;
    let startRadiusM = 3000;
    let maxRadiusM = 8000;
    let expandPerRoundM = 0;
    let effectiveRadiusM = 3000;
    let waveCommission = {
      basePercent: 15,
      reductionPercent: 0,
      effectivePercent: 15,
      wave: 1 as 1 | 2 | 3,
      dispatchRound: 1,
    };
    let offerExpirySecondsResolved = 20;
    const shortlistLimit = coercePositiveInt(dispatchSettings.shortlist_limit) ?? 100;

    try {
      searchWindowActive = isCustomerSearchWindowActive(trip, dispatchSettings);
      maxRounds = maxBroadcastRounds(dispatchSettings, trip.max_broadcast_rounds);
      currentRound = resolveDispatchBroadcastRound({
        storedRound,
        maxRounds,
        forceRebroadcast: force_rebroadcast,
        searchWindowActive,
      });
      startRadiusM = effectiveRadiusMeters(dispatchSettings, 1);
      maxRadiusM = effectiveRadiusMeters(dispatchSettings, 3);
      expandPerRoundM = effectiveRadiusMeters(dispatchSettings, 2) - startRadiusM;
      effectiveRadiusM = effectiveRadiusMeters(dispatchSettings, currentRound);
      waveCommission = resolveWaveCommission({
        settings: dispatchSettings,
        sequence: currentRound,
        floorReductionPercent: (trip as { max_wave_commission_reduction_percent?: number | null })
          .max_wave_commission_reduction_percent ?? 0,
      });
      const deadlineMs = resolveCustomerSearchDeadlineMs(trip, dispatchSettings);
      const remainingTtlSec = deadlineMs == null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
      offerExpirySecondsResolved = effectiveOfferExpirySeconds({
        settings: dispatchSettings,
        sequence: currentRound,
        remainingTripTtlSeconds: remainingTtlSec,
      });
    } catch (roundErr) {
      const roundErrorMessage = roundErr instanceof Error ? roundErr.message : String(roundErr);
      console.error("[auto-dispatch] dispatch_round_resolve_error:", roundErrorMessage, roundErr);
      audit("dispatch_failed", {
        reason: "dispatch_round_resolve_error",
        error: roundErrorMessage,
        stored_round: storedRound,
        force_rebroadcast: force_rebroadcast,
      });
      await flushAudits();
      return errorResponse(
        "INTERNAL_ERROR",
        "Failed to resolve dispatch broadcast round",
        500,
        { trip_id, error: roundErrorMessage },
      );
    }

    console.log("[auto-dispatch] Using settings:", {
      radiusThisRound: effectiveRadiusM,
      startRadius: startRadiusM,
      expandPerRound: expandPerRoundM,
      maxRadius: maxRadiusM,
      sequence: currentRound,
      dispatch_wave: waveCommission.wave,
      dispatch_round: waveCommission.dispatchRound,
      maxSequences: maxRounds,
      expiry: offerExpirySecondsResolved,
      waveNExpiryThisRound: waveOfferExpirySeconds(dispatchSettings as Record<string, unknown>, currentRound),
      waveDriverCapThisRound: waveDriverCapForRound(dispatchSettings as Record<string, unknown>, currentRound),
      effective_commission_percent: waveCommission.effectivePercent,
      wave_commission_reduction_percent: waveCommission.reductionPercent,
      batchMode: batchMode,
      maxOffersPerRequest: maxOffersPerRequest,
      cooldownSeconds: cooldownSeconds,
      stackedEnabled: stackedRideConfig.operational,
      stackedConfigSource: stackedRideConfig.source,
      stackedGuardReason: stackedRideConfig.guardReason ?? null,
      stackedRadius: stackedRideConfig.stackedSearchRadiusMeters,
      settingsSource,
      wave1_size: dispatchSettings.wave1_size,
      wave2_size: dispatchSettings.wave2_size,
      wave3_size: dispatchSettings.wave3_size,
    });

    const resolveSnapshotSource = (
      extra: { source?: string | null; isStackedOffer?: boolean; metadata?: Record<string, unknown> } = {},
    ): string => {
      if (extra.source) return extra.source;
      if (extra.isStackedOffer || extra.metadata?.stacked_gate === true) {
        return "auto_dispatch_stacked";
      }
      return "auto_dispatch";
    };

    const queueSnapshot = (
      stage: DispatchWaveSnapshotStage,
      driverId: string | null = null,
      extra: {
        rideOfferId?: string | null;
        metadata?: Record<string, unknown>;
        source?: string | null;
        isStackedOffer?: boolean;
      } = {},
    ) => {
      recordDispatchWaveSnapshot(
        supabase,
        {
          tripId: trip_id,
          dispatchRound: currentRound,
          stage,
          driverId,
          source: resolveSnapshotSource(extra),
          rideOfferId: extra.rideOfferId ?? null,
          metadata: {
            trigger_reason: triggerReasonResolved,
            reason_for_next_wave: reasonForNextWave,
            ...(extra.metadata ?? {}),
          },
        },
        auditPromises,
      );
    };

    audit("dispatch_config_snapshot", {
      booking_id: trip_id,
      settings_source: settingsSource,
      batch_mode: batchMode,
      cascade_batch_size: dispatchSettings.cascade_batch_size,
      note:
        "Wave width uses wave1_size / wave2_size / wave3_size only; cascade_batch_size does not cap parallel offers. max_broadcast_rounds is max sequences (cycles×3).",
      wave1_size: dispatchSettings.wave1_size,
      wave2_size: dispatchSettings.wave2_size,
      wave3_size: dispatchSettings.wave3_size,
      wave1_offer_expiry_seconds: dispatchSettings.wave1_offer_expiry_seconds,
      wave2_offer_expiry_seconds: dispatchSettings.wave2_offer_expiry_seconds,
      wave3_offer_expiry_seconds: dispatchSettings.wave3_offer_expiry_seconds,
      offer_expiry_seconds_fallback: dispatchSettings.offer_expiry_seconds,
      accept_timeout_seconds: dispatchSettings.accept_timeout_seconds,
      radius_start_m: startRadiusM,
      radius_expand_m: expandPerRoundM,
      radius_max_m: maxRadiusM,
      radius_effective_this_round_m: effectiveRadiusM,
      max_offers_per_request: maxOffersPerRequest,
      broadcast_sequence: currentRound,
      dispatch_wave: waveCommission.wave,
      dispatch_round: waveCommission.dispatchRound,
      max_broadcast_sequences: maxRounds,
      wave_driver_cap_this_round: waveDriverCapForRound(dispatchSettings as Record<string, unknown>, currentRound),
      wave_offer_expiry_this_round_seconds: offerExpirySecondsResolved,
      base_commission_percent: waveCommission.basePercent,
      wave_commission_reduction_percent: waveCommission.reductionPercent,
      effective_commission_percent: waveCommission.effectivePercent,
    });

    // (broadcast sequence already calculated above for radius / wave economics)

    if (offerExpirySecondsResolved <= 0 || !searchWindowActive) {
      if (isScheduledInstantConversionPending(trip)) {
        abortDispatch("SCHEDULED_HANDOVER_PENDING", {
          sequence: currentRound,
          searching_expires_at: trip.searching_expires_at ?? null,
          dispatch_mode: trip.dispatch_mode ?? null,
          scheduled_status: trip.scheduled_status ?? null,
        });
        return successResponse({
          success: false,
          error: "Scheduled handover pending; instant search TTL not started",
          trip_id,
          dispatch_aborted: true,
          scheduled_handover_pending: true,
        });
      }
      await expireTripWhenSearchExhaustedAndNotifyCustomer(supabase, {
        tripId: trip_id,
        passengerId: (trip as { passenger_id?: string | null }).passenger_id ?? null,
      });
      abortDispatch("SEARCH_WINDOW_ENDED", {
        sequence: currentRound,
        searching_expires_at: trip.searching_expires_at ?? null,
      });
      return errorResponse(
        "SEARCH_WINDOW_ENDED",
        "Customer search window ended before next wave",
        400,
        { sequence: currentRound },
      );
    }

    if (currentRound > maxRounds) {
      console.log("[auto-dispatch] Max broadcast rounds reached:", currentRound);
      if (
        !isScheduledInstantConversionPending(trip) &&
        shouldExpireTripAfterWavesExhausted(trip, dispatchSettings)
      ) {
        await expireTripWhenSearchExhaustedAndNotifyCustomer(supabase, {
          tripId: trip_id,
          passengerId: (trip as { passenger_id?: string | null }).passenger_id ?? null,
        });
        abortDispatch("MAX_ROUNDS_EXCEEDED", { round: currentRound, max_rounds: maxRounds });
        return errorResponse(
          "MAX_ROUNDS_EXCEEDED",
          "Max broadcast rounds exceeded; customer search window ended",
          400,
          { round: currentRound, max_rounds: maxRounds },
        );
      }
      audit(WAVE3_NO_ELIGIBLE_LOG_TOKEN, {
        stored_round: storedRound,
        max_rounds: maxRounds,
        searching_expires_at: trip.searching_expires_at ?? null,
      });
      await supabase
        .from("trips")
        .update({
          dispatch_status: "broadcasting",
          status: trip.status === "searching_new_driver" ? "searching_new_driver" : "searching",
          updated_at: new Date().toISOString(),
        })
        .eq("id", trip_id);
      abortDispatch("WAVES_EXHAUSTED_WAITING", {
        round: maxRounds,
        searching_expires_at: trip.searching_expires_at ?? null,
      });
      return successResponse({
        success: true,
        trip_id,
        message: "Waves exhausted; waiting for customer search window",
        round: maxRounds,
        offers_created: 0,
        log_token: WAVE3_NO_ELIGIBLE_LOG_TOKEN,
      });
    }

    let uniqueDrivers: any[] = [];
    /** Hoisted: offer insert runs after driver-search block; must stay in scope for ride_offers INSERT. */
    let permanentlyExcludedDriverIds = new Set<string>(
      Array.isArray(trip.excluded_driver_ids)
        ? (trip.excluded_driver_ids as string[]).filter(Boolean)
        : [],
    );
    const serviceAreaMatchSourceByDriverId = new Map<string, "direct" | "junction" | "both">();
    let priorRecheckByDriver = new Map<string, PriorDriverDispatchRecheckState>();
    let logEligibility: (
      driverId: string,
      isEligible: boolean,
      reason: string,
      extra?: Record<string, unknown>,
    ) => void = () => {};
    let autoAcceptDriverIds = new Set<string>();
    let waveDriverCap = waveDriverCapForRound(
      dispatchSettings as Record<string, unknown>,
      currentRound,
    );
    // Hoisted for wave snapshot audit (populated inside driver search block)
    let candidateDriverCount = 0;
    /** Hoisted: offer insert uses this after the driver-search block closes. */
    let activeTripDriverIds = new Set<string>();
    let eligibleIdleDrivers: any[] = [];
    let driversForOffers: any[] = [];
    let exclusionReasonCounts = new Map<string, number>();
    let declinedFromPreviousWaves: string[] = [];
    let timedOutFromPreviousWaves: string[] = [];
    let previousWaveOutcomes: Array<{ driver_id: string; status: string; responded_at: string | null; broadcast_round: number | null }> = [];

    if (!enrichExistingOffersMode) {
    // 4. Find eligible drivers using presence-based dispatch. Do NOT use
    // passenger_map_nearby_drivers / find_nearby_drivers / driver_live_locations;
    // those are passenger-map markers only, not eligibility.
    //
    // HARD AVAILABILITY GUARDS â same freshness truth as admin effective-online.
    // If freshness degrades, we exclude immediately and log the exact reason so
    // no driver can stay ghost-online while dispatch no longer trusts them.
    //
    // A driver must satisfy ALL of the following or it is logged with
    // its exact reject reason and excluded from this dispatch round:
    //
    //   - drivers.approval_status = 'approved'        (not_approved)
    //   - drivers.driver_status = 'active'            (driver_status_not_active)
    //   - drivers.documents_approved = true           (documents_not_approved)
    //   - drivers.current_trip_id IS NULL             (busy_on_trip)
    //   - last_heartbeat_at within 45s                (stale_heartbeat)
    //   - last_location_at within 45s                 (stale_location)
    //   - driver_presence.lat/lng present             (no_location)
    //   - driver_presence.status = 'online'           (presence_not_online)
    //   - idle pool: delivery reachable = fresh realtime socket OR push_tokens row
    //     (no_socket_no_push when online but neither path works)
    // Realtime freshness uses realtimeFresh() with a 90s TTL on socket_connected +
    // last_socket_pong_at / last_realtime_seen_at.
    // Temporary health exclusions (stale heartbeat, degraded presence, etc.) are re-evaluated
    // on every broadcast round until the trip is assigned/cancelled/expired.
    //
    // NOTE: Stacked (on_trip) candidates use the same freshness + push-token gates
    // applied in the stacking loop.
    //
    // Every candidate driver â eligible OR rejected â is recorded in
    // public.dispatch_eligibility_log via the log_dispatch_eligibility RPC so
    // ops can answer "why didn't driver X get this booking?" in one query.
    const pickupLat = trip.pickup_latitude || 0;
    const pickupLng = trip.pickup_longitude || 0;
    const nowIso = new Date().toISOString();
    // Shared freshness TTLs.
    const heartbeatMaxAgeSeconds = 45;
    const locationMaxAgeSeconds = 45;
    const cooldownCutoff = new Date(Date.now() - cooldownSeconds * 1000).toISOString();
    const heartbeatCutoffIso = new Date(Date.now() - heartbeatMaxAgeSeconds * 1000).toISOString();
    const locationCutoffIso = new Date(Date.now() - locationMaxAgeSeconds * 1000).toISOString();
    const realtimeCutoffIso = new Date(Date.now() - REALTIME_FRESH_MAX_AGE_SECONDS * 1000).toISOString();

    const { data: priorEligibilityRows } = await supabase
      .from("dispatch_eligibility_log")
      .select("driver_id, is_eligible, reject_reason, context")
      .eq("trip_id", trip_id);

    priorRecheckByDriver = buildPriorDispatchRecheckState(
      priorEligibilityRows || [],
      currentRound,
    );

    // Helper: log an eligibility decision. Push the promise so it is awaited
    // before the function returns (Deno aborts unawaited promises on response).
    exclusionReasonCounts = new Map<string, number>();
    let temporaryExclusionCountThisWave = 0;
    let driversRecoveredEligibleThisWave = 0;

    logEligibility = (
      driverId: string,
      isEligible: boolean,
      reason: string,
      extra: Record<string, unknown> = {},
    ) => {
      const driverRow = (allDrivers || []).find((row) => row.id === driverId);
      const presenceRow = presenceMap.get(driverId);
      const canonical = isEligible
        ? null
        : canonicalizeDispatchRejectReason(reason, {
          driverOnlineIntent: (driverRow as { driver_online_intent?: boolean | null } | undefined)
            ?.driver_online_intent,
          appState: presenceRow?.app_state ?? null,
        });
      const exclusionClass = isEligible ? "none" : classifyDispatchExclusion(canonical);
      const recheckable = isDispatchRecheckableReason(canonical);
      const prior = priorRecheckByDriver.get(driverId);
      const adminLabel = computeDispatchRecheckAdminLabel({
        currentRound,
        isEligible,
        exclusionClass,
        prior,
        offerCreatedThisRun: extra.offer_created_after_recovery === true,
      });

      if (!isEligible && exclusionClass === "temporary") {
        temporaryExclusionCountThisWave += 1;
      }
      if (isEligible && prior?.hadTemporaryExclusion && !prior.hadEligible) {
        driversRecoveredEligibleThisWave += 1;
      }

      const rejectForLog = isEligible ? null : (canonical ?? reason);

      console.log(
        `[auto-dispatch] eligibility driver=${driverId} eligible=${isEligible} reason=${rejectForLog} trip=${trip_id}`,
        { admin_label: adminLabel, exclusion_class: exclusionClass, recheckable, ...extra },
      );
      if (!isEligible && rejectForLog === "stale_heartbeat") {
        console.warn(
          `[driver_excluded_due_to_stale_heartbeat] driver_id=${driverId} trip_id=${trip_id}`,
          extra,
        );
      }
      if (!isEligible) {
        exclusionReasonCounts.set(
          rejectForLog ?? reason,
          (exclusionReasonCounts.get(rejectForLog ?? reason) ?? 0) + 1,
        );
      }
      const stackedSnapshot = extra.stacked_gate === true;
      queueSnapshot("considered", driverId, {
        isStackedOffer: stackedSnapshot,
        metadata: {
          is_eligible: isEligible,
          reject_reason: rejectForLog,
          exclusion_class: exclusionClass,
          recheckable,
          ...extra,
        },
      });
      if (isEligible && !extra.offer_id) {
        queueSnapshot("eligible", driverId, {
          isStackedOffer: stackedSnapshot,
          metadata: {
            exclusion_class: exclusionClass,
            recheckable,
            ...extra,
          },
        });
      }
      auditPromises.push(
        Promise.resolve(
          supabase.rpc("log_dispatch_eligibility", {
            p_trip_id: trip_id,
            p_driver_id: driverId,
            p_is_eligible: isEligible,
            p_reject_reason: rejectForLog,
            p_context: {
              round: currentRound,
              canonical_reject_reason: canonical,
              exclusion_class: exclusionClass,
              recheckable,
              admin_label: adminLabel,
              recheck_policy: "wave_fresh_eligibility_v1",
              ...extra,
            },
          })
        ).then(({ error }: { error: unknown }) => {
          if (error) console.error("[auto-dispatch] log_dispatch_eligibility failed:", error);
        }),
      );
    };

    // All presence rows (do not filter by status â offline rows may still carry
    // fresh heartbeats; stale flags are evaluated + repaired below).
    const { data: presenceDrivers, error: presenceError } = await supabase
      .from("driver_presence")
      .select(`
        driver_id,
        status,
        lat,
        lng,
        last_heartbeat_at,
        last_location_at,
        unresolved_critical_tracking,
        push_token,
        app_state,
        offline_reason,
        socket_connected,
        last_socket_pong_at,
        last_realtime_seen_at,
        updated_at
      `);

    // Pull driver rows with all hard-gate fields. We deliberately do NOT pre-
    // filter by status/approval here so every "almost eligible" candidate gets
    // a structured rejection row.
    const { data: allDrivers, error: driversError } = await supabase
      .from("drivers")
      .select(
        "id, driver_code, current_lat, current_lng, current_trip_id, is_online, driver_online_intent, approval_status, driver_status, documents_approved, last_seen_at, last_location_updated_at, service_area_id, region_id, display_rating, rating, last_trip_end_at, online_since, category_id, driver_categories(name)",
      );

    const { data: pushTokenRows, error: pushTokensError } = await supabase
      .from("push_tokens")
      .select("driver_id, platform, updated_at")
      .eq("app_type", "driver");

    if (driversError || presenceError || pushTokensError) {
      console.error(
        "[auto-dispatch] Error fetching drivers:",
        driversError || presenceError || pushTokensError,
      );
      abortDispatch("DB_ERROR_FETCH_DRIVERS", {
        error: (driversError || presenceError || pushTokensError)?.message ?? null,
      });
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

    /** SSOT: drivers on active trips must never receive idle (non-stacked) offers. */
    activeTripDriverIds = await loadActiveTripDriverIds(supabase);

    // ââ Apply hard availability gates ââ
    const eligiblePresenceDrivers: Array<any> = [];
    candidateDriverCount = (allDrivers || []).length;

    for (const d of allDrivers || []) {
      if (d.driver_status !== "active") {
        logEligibility(d.id, false, "driver_status_not_active", { driver_status: d.driver_status });
        continue;
      }
      if (d.approval_status !== "approved") {
        logEligibility(d.id, false, "not_approved", { approval_status: d.approval_status });
        continue;
      }
      if (d.documents_approved !== true) {
        logEligibility(d.id, false, "documents_not_approved");
        continue;
      }
      const docCompliance = await evaluateDriverDocumentState(supabase, d.id);
      if (!docCompliance.allowed) {
        const docReject = docCompliance.document_state === "documents_expired"
          ? "documents_expired"
          : "documents_not_approved";
        logEligibility(d.id, false, docReject, {
          document_state: docCompliance.document_state,
          expired_documents: docCompliance.expired_documents,
        });
        continue;
      }
      const driverOnlineIntent =
        (d as { driver_online_intent?: boolean | null }).driver_online_intent === true;

      let presence = presenceMap.get(d.id);
      if (!presence) {
        logEligibility(d.id, false, "no_presence_row");
        continue;
      }

      const explicitOffline = isExplicitOfflineReason(
        (presence as { offline_reason?: string | null }).offline_reason ?? null,
      );
      const backendAvailabilityOnline = d.is_online === true || (driverOnlineIntent && !explicitOffline);

      if (explicitOffline) {
        logEligibility(d.id, false, (presence as { offline_reason?: string | null }).offline_reason ?? "driver_offline", {
          driver_online_intent: driverOnlineIntent,
          explicit_offline_reason: (presence as { offline_reason?: string | null }).offline_reason ?? null,
        });
        continue;
      }
      if (d.is_online !== true && !driverOnlineIntent) {
        logEligibility(d.id, false, "driver_offline", {
          driver_online_intent: (d as { driver_online_intent?: boolean | null }).driver_online_intent ?? null,
        });
        continue;
      }
      if (d.current_trip_id) {
        logEligibility(d.id, false, "busy_on_trip", { current_trip_id: d.current_trip_id });
        continue;
      }
      if (activeTripDriverIds.has(d.id)) {
        logEligibility(d.id, false, "busy_on_active_trip_assignment", {
          lifecycle: STACKED_RIDE_STATES.stacked_offer,
        });
        continue;
      }

      const heartbeatOkCombined = heartbeatFreshEnough(presence, d, heartbeatCutoffIso);
      const locationOkCombined = locationFreshEnough(presence, d, locationCutoffIso);
      const coordsPair = coordsForDispatch(presence, d);
      const registeredPushTokens = pushTokenMap.get(d.id) || [];
      const hasRegisteredPushToken = registeredPushTokens.length > 0;
      const hasPresencePushToken = !!presence.push_token;
      const hasRealtimeFresh = realtimeFresh(presence, realtimeCutoffIso);
      const isForeground = presence.app_state === "foreground";

      const healthIssuesRaw: string[] = [];
      if (!heartbeatOkCombined) healthIssuesRaw.push("stale_heartbeat");
      if (!locationOkCombined) healthIssuesRaw.push("stale_location");
      if (presence.status !== "online") healthIssuesRaw.push("presence_not_online");
      if (!hasRealtimeFresh) healthIssuesRaw.push("realtime_unhealthy");
      if (!hasRegisteredPushToken) healthIssuesRaw.push("no_registered_push_token");

      const readiness = evaluateDispatchableReadiness({
        healthIssuesRaw,
        driverOnlineIntent,
        isOnline: backendAvailabilityOnline,
        hasRegisteredPushToken,
        hasRealtimeFresh,
        hasCoords: !!coordsPair,
        appState: presence.app_state ?? null,
      });

      if (!readiness.eligible) {
        logEligibility(d.id, false, readiness.hardRejectReason ?? "unknown", {
          last_heartbeat_at: presence.last_heartbeat_at,
          last_seen_at_driver: d.last_seen_at ?? null,
          last_location_at: presence.last_location_at,
          last_location_updated_at_driver: d.last_location_updated_at ?? null,
          presence_status: presence.status,
          app_state: presence.app_state ?? null,
          driver_online_intent: driverOnlineIntent,
          has_registered_push_token: hasRegisteredPushToken,
          has_realtime_fresh: hasRealtimeFresh,
          socket_connected: presence.socket_connected ?? null,
          last_socket_pong_at: presence.last_socket_pong_at ?? null,
          health_issues_raw: healthIssuesRaw,
          max_age_seconds: heartbeatMaxAgeSeconds,
        });
        continue;
      }

      if (readiness.degraded) {
        logEligibility(d.id, true, DISPATCHABLE_DEGRADED, {
          dispatch_quality: "degraded",
          degraded_health_reasons: readiness.degradedHealthReasons,
          driver_online_intent: driverOnlineIntent,
          has_registered_push_token: hasRegisteredPushToken,
          last_heartbeat_at: presence.last_heartbeat_at,
          last_location_at: presence.last_location_at,
          presence_status: presence.status,
          app_state: presence.app_state ?? null,
        });
      } else {
        logEligibility(d.id, true, "eligible", {
          dispatch_quality: "healthy",
        });
      }

      eligiblePresenceDrivers.push(
        attachDriverCategoryPriority({
          ...d,
          current_lat: coordsPair!.lat,
          current_lng: coordsPair!.lng,
          push_token: presence.push_token,
          has_registered_push_token: hasRegisteredPushToken,
          has_presence_push_token: hasPresencePushToken,
          app_state: presence.app_state,
          is_foreground: isForeground,
          registered_push_platforms: registeredPushTokens.map((t) => t.platform),
          last_heartbeat_at: presence.last_heartbeat_at,
          socket_connected: presence.socket_connected,
          last_socket_pong_at: presence.last_socket_pong_at,
          last_realtime_seen_at: presence.last_realtime_seen_at,
          dispatch_quality: readiness.degraded ? "degraded" : "healthy",
          degraded_health_reasons: readiness.degradedHealthReasons,
        }, tierPriorityMap),
      );
    }

    console.log(
      "[auto-dispatch] Found",
      eligiblePresenceDrivers.length,
      "dispatchable drivers passing all hard gates (of",
      (allDrivers || []).length,
      "total drivers checked)",
    );

    // 5. Find stacked-eligible drivers
    //
    // Quality gates enforced (in order):
    //   1. New trip minimum distance (stacked_min_trip_distance_km)
    //   2. Driver online + approved
    //   3. Current trip in active status (accepted/arrived/in_progress)
    //   4. No existing stacked trip on current trip
    //   5. Service area + region match
    //   6. Offer window (trip nearing completion)
    //   7. Max concurrent stacked offers
    //   8. Pickup within radius of driver OR active dropoff (stacked_search_radius_meters)
    //   9. Max detour time (stacked_max_detour_minutes)
    //  10. Presence freshness (heartbeat, location, push token)
    //
    // Every rejection is logged to dispatch_eligibility_log for audit.
    let stackedDrivers: StackedDriver[] = [];

    const stackedMinTripDistanceKm = stackedRideConfig.stackedMinTripDistanceKm;
    const stackedMaxDetourMinutes = stackedRideConfig.stackedMaxDetourMinutes;
    const stackedOfferWindowMinutes = stackedRideConfig.stackedOfferWindowMinutes;
    const stackedSearchRadiusM = stackedRideConfig.stackedSearchRadiusMeters;
    const stackedMaxRides = stackedRideConfig.maxStackedRides;
    if (stackedRideConfig.operational) {
      console.log("[auto-dispatch] Stacked rides operational, searching for busy drivers", {
        minTripDistanceKm: stackedMinTripDistanceKm,
        maxDetourMinutes: stackedMaxDetourMinutes,
        offerWindowMinutes: stackedOfferWindowMinutes,
        searchRadiusM: stackedSearchRadiusM,
        maxRides: stackedMaxRides,
        matchingMode: "radius_only",
        configSource: stackedRideConfig.source,
      });

      // Build stacked driver pool (busy/on-trip drivers), then apply service-area checks
      const { data: busyDrivers, error: busyError } = await supabase
        .from("drivers")
        .select("id, current_lat, current_lng, current_trip_id, is_online, approval_status, service_area_id, region_id, last_seen_at, last_location_updated_at, category_id, driver_categories(name), last_trip_end_at, online_since, display_rating, rating")
        .eq("approval_status", "approved")
        .not("current_trip_id", "is", null);

      const busyDriverIds = (busyDrivers || []).map((d) => d.id);
      let stackedServiceAreaDriverIds = new Set<string>();

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

        for (const driver of busyDrivers) {
          // Gate 2: driver online
          if (driver.is_online !== true) {
            logEligibility(driver.id, false, "stacked_driver_offline", { stacked_gate: true });
            continue;
          }

          const { data: currentTrip } = await supabase
            .from("trips")
            .select("id, status, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude, stacked_trip_id, started_at, estimated_duration_minutes, service_area_id, region_id, stop_waiting_status, stop_waiting_started_at, stop_waiting_paid_started_at, grace_period_expired_at, pickup_waiting_started_at, pickup_paid_waiting_started_at, arrived_at")
            .eq("id", driver.current_trip_id)
            .single();

          if (!currentTrip) {
            logEligibility(driver.id, false, "stacked_no_current_trip", { stacked_gate: true, current_trip_id: driver.current_trip_id });
            continue;
          }

          // Committed queue depth — Admin max_stacked_rides SSOT (1–3).
          const { count: queuedStackedCount, error: queuedCountErr } = await supabase
            .from("trips")
            .select("id", { count: "exact", head: true })
            .eq("status", "queued")
            .or(`driver_id.eq.${driver.id},confirmed_driver_id.eq.${driver.id}`);

          if (queuedCountErr) {
            logEligibility(driver.id, false, "stacked_queue_count_failed", {
              stacked_gate: true,
              error: queuedCountErr.message,
            });
            continue;
          }

          const queuedCount = queuedStackedCount ?? 0;

          const phaseEligibility = evaluateStackedDriverEligibility({
            config: stackedRideConfig,
            newTrip: {
              estimated_distance_km: trip.estimated_distance_km,
              airport_charge_pence: trip.airport_charge_pence,
              is_scheduled: trip.is_scheduled,
              dispatch_mode: trip.dispatch_mode,
            },
            currentTrip,
            queuedCount,
          });
          logStackedEligibilityCheck(driver.id, trip_id, phaseEligibility, {
            current_trip_id: currentTrip.id,
            current_trip_status: currentTrip.status,
            queued_count: queuedCount,
            max_stacked_rides: stackedMaxRides,
          });
          if (!phaseEligibility.eligible) {
            logEligibility(driver.id, false, phaseEligibility.reason, {
              stacked_gate: true,
              ...(phaseEligibility.details ?? {}),
            });
            continue;
          }

          // Gate 5: service area + region
          const serviceAreaMatch = !trip.service_area_id ||
            driver.service_area_id === trip.service_area_id ||
            currentTrip.service_area_id === trip.service_area_id ||
            stackedServiceAreaDriverIds.has(driver.id);

          if (!serviceAreaMatch) {
            logEligibility(driver.id, false, "stacked_service_area_mismatch", {
              stacked_gate: true,
              trip_service_area_id: trip.service_area_id,
              driver_service_area_id: driver.service_area_id,
            });
            continue;
          }

          const regionMatch = !trip.region_id ||
            driver.region_id === trip.region_id ||
            currentTrip.region_id === trip.region_id;

          if (!regionMatch) {
            logEligibility(driver.id, false, "stacked_region_mismatch", {
              stacked_gate: true,
              trip_region_id: trip.region_id,
              driver_region_id: driver.region_id,
            });
            continue;
          }

          // Gate 6: max concurrent stacked offers
          const nowIso2 = new Date().toISOString();
          const { data: existingStackedOffers } = await supabase
            .from("ride_offers")
            .select("id")
            .eq("driver_id", driver.id)
            .eq("status", "pending")
            .eq("is_stacked", true)
            .gt("expires_at", nowIso2);

          if (existingStackedOffers && existingStackedOffers.length >= stackedMaxRides) {
            logEligibility(driver.id, false, "stacked_max_concurrent_reached", {
              stacked_gate: true,
              existing_stacked_offers: existingStackedOffers.length,
              max_stacked_rides: stackedMaxRides,
            });
            continue;
          }

          // Fallback to driver's live location when trip dropoff is not yet persisted
          const sDropoffLat = currentTrip.dropoff_latitude ?? driver.current_lat;
          const sDropoffLng = currentTrip.dropoff_longitude ?? driver.current_lng;

          if (!sDropoffLat || !sDropoffLng) {
            logEligibility(driver.id, false, "stacked_no_dropoff_location", { stacked_gate: true });
            continue;
          }

          const distanceFromDropoff = calculateDistance(sDropoffLat, sDropoffLng, pickupLat, pickupLng);

          // Gate 8: pickup distance from driver (admin SSOT â global_dispatch_settings.stacked_search_radius_meters)
          const driverLat = driver.current_lat;
          const driverLng = driver.current_lng;
          if (!driverLat || !driverLng) {
            logEligibility(driver.id, false, "stacked_stale_location", {
              stacked_gate: true,
              reason: "missing_driver_location_for_radius_gate",
            });
            continue;
          }

          const distanceFromDriver = calculateDistance(driverLat, driverLng, pickupLat, pickupLng);
          const stackedConfigAudit = {
            source: stackedRideConfig.source,
            stackedSearchRadiusMeters: stackedSearchRadiusM,
            stackedOfferWindowMinutes: stackedOfferWindowMinutes,
            maxStackedRides: stackedMaxRides,
            stackedPriorityMode: stackedRideConfig.stackedPriorityMode,
          };

          const radiusGate = evaluateStackedProximityRadiusGate({
            distanceFromDriverMeters: distanceFromDriver,
            distanceFromDropoffMeters: distanceFromDropoff,
            searchRadiusMeters: stackedSearchRadiusM,
          });
          if (!radiusGate.pass) {
            logEligibility(driver.id, false, radiusGate.reason, {
              stacked_gate: true,
              distance_from_driver_meters: radiusGate.distance_from_driver_meters,
              distance_from_dropoff_meters: radiusGate.distance_from_dropoff_meters,
              search_radius_meters: radiusGate.search_radius_meters,
              config_source: stackedRideConfig.source,
            });
            logStackedGateAudit({
              gate: "stacked_search_radius",
              pass: false,
              reason: radiusGate.reason,
              config: stackedConfigAudit,
              driver_id: driver.id,
              trip_id,
              current_trip_id: currentTrip.id,
              distance_from_driver_meters: radiusGate.distance_from_driver_meters,
              distance_from_dropoff_meters: radiusGate.distance_from_dropoff_meters,
              offer_type: "stacked",
            });
            continue;
          }

          // Gate 9: max detour (estimate: ~2 min per km at urban speed) â driver â new pickup
          const detourMinutes = (distanceFromDriver / 1000) * 2;
          if (detourMinutes > stackedMaxDetourMinutes) {
            logEligibility(driver.id, false, "stacked_detour_too_long", {
              stacked_gate: true,
              detour_minutes: Math.round(detourMinutes * 10) / 10,
              max_detour_minutes: stackedMaxDetourMinutes,
              distance_from_driver_meters: Math.round(distanceFromDriver),
            });
            logStackedGateAudit({
              gate: "stacked_max_detour",
              pass: false,
              reason: "stacked_detour_too_long",
              config: stackedConfigAudit,
              driver_id: driver.id,
              trip_id,
              current_trip_id: currentTrip.id,
              distance_from_driver_meters: Math.round(distanceFromDriver),
              offer_type: "stacked",
            });
            continue;
          }

          // Gate 10: presence freshness + push token
          const sp = presenceMap.get(driver.id);
          if (!sp || sp.status !== "on_trip") {
            logEligibility(driver.id, false, "stacked_presence_not_on_trip", {
              stacked_gate: true,
              presence_status: sp?.status ?? null,
            });
            continue;
          }
          if (!heartbeatFreshEnough(sp, driver, heartbeatCutoffIso)) {
            logEligibility(driver.id, false, "stacked_stale_heartbeat", { stacked_gate: true });
            continue;
          }
          if (!locationFreshEnough(sp, driver, locationCutoffIso)) {
            logEligibility(driver.id, false, "stacked_stale_location", { stacked_gate: true });
            continue;
          }
          const regTok = pushTokenMap.get(driver.id) || [];
          const stackedRealtimeFresh = realtimeFresh(sp, realtimeCutoffIso);
          if (!stackedRealtimeFresh && regTok.length === 0) {
            logEligibility(driver.id, false, "no_socket_no_push", {
              stacked_gate: true,
              has_registered_push_token: false,
              has_realtime_fresh: false,
              socket_connected: sp.socket_connected ?? null,
            });
            continue;
          }

          // â All gates passed â log eligible with quality metadata
          const newPickupEtaMinutes = detourMinutes;
          logEligibility(driver.id, true, "stacked_eligible", {
            stacked_gate: true,
            distance_from_driver_meters: Math.round(distanceFromDriver),
            distance_from_dropoff_meters: Math.round(distanceFromDropoff),
            detour_minutes: Math.round(detourMinutes * 10) / 10,
            new_pickup_eta_minutes: Math.round(newPickupEtaMinutes * 10) / 10,
            current_trip_status: currentTrip.status,
            search_radius_meters: stackedSearchRadiusM,
            config_source: stackedRideConfig.source,
          });
          logStackedGateAudit({
            gate: "stacked_all_gates",
            pass: true,
            config: stackedConfigAudit,
            driver_id: driver.id,
            trip_id,
            current_trip_id: currentTrip.id,
            distance_from_driver_meters: Math.round(distanceFromDriver),
            distance_from_dropoff_meters: Math.round(distanceFromDropoff),
            offer_type: "stacked",
          });

          stackedDrivers.push(
            attachDriverCategoryPriority({
              ...driver,
              current_trip_dropoff_lat: sDropoffLat,
              current_trip_dropoff_lng: sDropoffLng,
              distance_from_current_dropoff: distanceFromDropoff,
              distance_meters: distanceFromDropoff,
              is_stacked: true,
              dispatch_quality: "healthy",
              has_registered_push_token: regTok.length > 0,
              has_presence_push_token: !!sp.push_token,
              registered_push_platforms: regTok.map((t) => t.platform),
              app_state: sp.app_state,
              socket_connected: sp.socket_connected,
              last_socket_pong_at: sp.last_socket_pong_at,
            }, tierPriorityMap),
          );
        }
      }

      console.log("[auto-dispatch] Found", stackedDrivers.length, "stacked-eligible drivers");
    } else {
      logStackedRideDisabledSafeGuard(
        { trip_id, phase: "stacked_pool_skipped" },
        stackedRideConfig,
      );
    }

    // 6. Filter and sort drivers
    /** Permanent: declined negotiation / timeout on this trip â never re-offer same trip_id. */
    permanentlyExcludedDriverIds = new Set<string>(
      Array.isArray(trip.excluded_driver_ids)
        ? (trip.excluded_driver_ids as string[]).filter(Boolean)
        : [],
    );
    if (Array.isArray(trip.cancelled_driver_ids)) {
      for (const id of trip.cancelled_driver_ids as unknown[]) {
        if (typeof id === "string" && id.trim()) {
          permanentlyExcludedDriverIds.add(id);
        }
      }
    }

    const { data: tripExclusionRows } = await supabase
      .from("trip_driver_exclusions")
      .select("driver_id")
      .eq("trip_id", trip_id);
    for (const row of tripExclusionRows || []) {
      if (row.driver_id) permanentlyExcludedDriverIds.add(row.driver_id);
    }

    /** Active offers only â declined/expired drivers are rechecked on later waves. */
    const { data: existingOffers } = await supabase
      .from("ride_offers")
      .select("driver_id, status")
      .eq("trip_id", trip_id)
      .in("status", ["pending", "accepted", "countered"]);

    const excludedDriverIds = new Set((existingOffers || []).map(o => o.driver_id));
    for (const driverId of permanentlyExcludedDriverIds) {
      excludedDriverIds.add(driverId);
    }

    // Previous-wave declined/timed-out drivers (for wave snapshot audit)
    {
      const { data: _prevOutcomes } = await supabase
        .from("ride_offers")
        .select("driver_id, status, responded_at, broadcast_round")
        .eq("trip_id", trip_id)
        .in("status", ["declined", "expired"]);
      previousWaveOutcomes = (_prevOutcomes || []) as typeof previousWaveOutcomes;
    }

    declinedFromPreviousWaves = (previousWaveOutcomes || [])
      .filter((o) => o.status === "declined")
      .map((o) => o.driver_id);
    timedOutFromPreviousWaves = (previousWaveOutcomes || [])
      .filter((o) => o.status === "expired")
      .map((o) => o.driver_id);

    // Cooldown applies only to explicit declines â passive expiry must not block later waves.
    const { data: recentDeclines } = await supabase
      .from("ride_offers")
      .select("driver_id")
      .eq("trip_id", trip_id)
      .eq("status", "declined")
      .gt("responded_at", cooldownCutoff);
    
    const cooldownDriverIds = new Set((recentDeclines || []).map(o => o.driver_id));

    if (declined_driver_id) {
      excludedDriverIds.add(declined_driver_id);
      cooldownDriverIds.add(declined_driver_id);
      console.log("[auto-dispatch] Excluding declining driver from rebroadcast wave", {
        trip_id,
        declined_driver_id,
        trigger_reason: triggerReasonResolved,
      });
    }

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

    // 6a. Fetch driver settings for eligible + stacked drivers
    const eligibleDriverIds = eligiblePresenceDrivers.map(d => d.id);
    const stackedDriverIds = stackedDrivers.map(d => d.id);
    const allRelevantDriverIds = [...new Set([...eligibleDriverIds, ...stackedDriverIds])];

    // ââ Service-area eligibility (column OR junction-table) ââ
    // Single source of truth: a driver matches the trip's service area if EITHER
    //   â¢ drivers.service_area_id === trip.service_area_id, OR
    //   â¢ a row exists in driver_service_areas linking them
    // This prevents silent exclusion when only one source is populated.
    let serviceAreaMatchedDriverIds: Set<string> | null = null;
    serviceAreaMatchSourceByDriverId.clear();
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
      .select("driver_id, towards_destination_active, towards_destination_lat, towards_destination_lng, auto_accept, max_pickup_distance_miles, accept_cash, accept_delivery_jobs, delivery_category_preferences")
      .in("driver_id", allRelevantDriverIds.length > 0 ? allRelevantDriverIds : ["__none__"]);

    const destinationMap = new Map(
      (allDriverSettings || [])
        .filter(ds => ds.towards_destination_active && ds.towards_destination_lat != null && ds.towards_destination_lng != null)
        .map(ds => [ds.driver_id, { lat: ds.towards_destination_lat!, lng: ds.towards_destination_lng! }])
    );


    // Build map of drivers with max_pickup_distance preference (in meters)
    const maxDistanceMap = new Map<string, number>(
      (allDriverSettings || [])
        .filter(ds => ds.max_pickup_distance_miles != null && ds.max_pickup_distance_miles > 0)
        .map(ds => [ds.driver_id, ds.max_pickup_distance_miles * 1609.34]) // Convert miles to meters
    );

    // Build set of drivers with auto_accept enabled
    autoAcceptDriverIds = new Set(
      (allDriverSettings || [])
        .filter(ds => ds.auto_accept === true)
        .map(ds => ds.driver_id)
    );

    const isCashTrip = String(trip.payment_method ?? "").toLowerCase() === "cash";
    const cashAcceptingDriverIds = new Set(
      (allDriverSettings || [])
        .filter(ds => ds.accept_cash === true)
        .map(ds => ds.driver_id)
    );

    const isMarketplaceDeliveryTrip =
      String(trip.booking_type ?? "ride").toLowerCase() === "delivery" &&
      trip.dispatch_mode !== "scan_and_go";
    const marketplaceDeliveryType =
      typeof trip.delivery_type === "string" ? trip.delivery_type.toLowerCase() : null;

    const deliveryJobsOptOutDriverIds = new Set<string>();
    const deliveryCategoryOptOutDriverIds = new Set<string>();
    if (isMarketplaceDeliveryTrip) {
      for (const ds of allDriverSettings || []) {
        if (ds.accept_delivery_jobs === false) {
          deliveryJobsOptOutDriverIds.add(ds.driver_id);
          continue;
        }
        if (marketplaceDeliveryType) {
          const prefs = ds.delivery_category_preferences;
          if (
            prefs &&
            typeof prefs === "object" &&
            (prefs as Record<string, unknown>)[marketplaceDeliveryType] === false
          ) {
            deliveryCategoryOptOutDriverIds.add(ds.driver_id);
          }
        }
      }
    }

    const acceptanceRateByDriverId = new Map<string, number>();
    if (eligibleDriverIds.length > 0) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: offerHistory } = await supabase
        .from("ride_offers")
        .select("driver_id, status")
        .in("driver_id", eligibleDriverIds)
        .gte("created_at", thirtyDaysAgo);
      const stats = new Map<string, { total: number; accepted: number }>();
      for (const row of offerHistory || []) {
        if (!row.driver_id) continue;
        const s = stats.get(row.driver_id) || { total: 0, accepted: 0 };
        s.total += 1;
        if (row.status === "accepted") s.accepted += 1;
        stats.set(row.driver_id, s);
      }
      for (const [driverId, s] of stats) {
        acceptanceRateByDriverId.set(driverId, s.total > 0 ? s.accepted / s.total : 0.5);
      }
    }

    const dropoffLat = trip.dropoff_latitude || 0;
    const dropoffLng = trip.dropoff_longitude || 0;
    const destinationMatchRadiusM = destinationMatchRadiusMeters(dispatchSettings);

    // Diagnostic + audit: log every secondary-filter rejection so ops can see
    // exactly why a hard-eligible driver still didn't receive this offer.
    for (const d of eligiblePresenceDrivers) {
      if (serviceAreaMatchedDriverIds && !serviceAreaMatchedDriverIds.has(d.id)) {
        logEligibility(d.id, false, "service_mismatch", {
          trip_service_area_id: trip.service_area_id,
          driver_service_area_id: (d as any).service_area_id ?? null,
          service_area_match_source: null,
        });
        continue;
      }
      if (permanentlyExcludedDriverIds.has(d.id)) {
        logEligibility(d.id, false, "negotiation_decline_permanent_exclusion");
        continue;
      }
      if (excludedDriverIds.has(d.id)) { logEligibility(d.id, false, "existing_offer_for_trip"); continue; }
      if (cooldownDriverIds.has(d.id)) { logEligibility(d.id, false, "cooldown_after_decline"); continue; }
      if (maxedOutDriverIds.has(d.id)) { logEligibility(d.id, false, "max_concurrent_offers", { max: maxConcurrentOffers }); continue; }
      if (disabledVehicleTypeDriverIds.has(d.id)) { logEligibility(d.id, false, "vehicle_type_disabled", { vehicle_type_id: effectiveVehicleTypeId }); continue; }
      if (requiredVehicleTypeDriverIds && !requiredVehicleTypeDriverIds.has(d.id)) { logEligibility(d.id, false, "missing_required_vehicle_category", { vehicle_type_id: effectiveVehicleTypeId }); continue; }
      if (isCashTrip && !cashAcceptingDriverIds.has(d.id)) { logEligibility(d.id, false, "cash_not_opted_in"); continue; }
      if (isMarketplaceDeliveryTrip && deliveryJobsOptOutDriverIds.has(d.id)) {
        logEligibility(d.id, false, "delivery_jobs_disabled");
        continue;
      }
      if (isMarketplaceDeliveryTrip && deliveryCategoryOptOutDriverIds.has(d.id)) {
        logEligibility(d.id, false, "delivery_category_disabled", {
          delivery_type: marketplaceDeliveryType,
        });
        continue;
      }
      if (!d.current_lat || !d.current_lng) { logEligibility(d.id, false, "no_location"); continue; }
      const dist = calculateDistance(pickupLat, pickupLng, d.current_lat!, d.current_lng!);
      if (dist > effectiveRadiusM) { logEligibility(d.id, false, "outside_radius", { distance_meters: Math.round(dist), radius_meters: effectiveRadiusM }); continue; }
      const maxDist = maxDistanceMap.get(d.id);
      if (maxDist && dist > maxDist) { logEligibility(d.id, false, "exceeds_driver_max_pickup_distance", { distance_meters: Math.round(dist), max_meters: Math.round(maxDist) }); continue; }
      // Note: towards_destination filter is logged inside the .filter() chain below.
    }

    eligibleIdleDrivers = eligiblePresenceDrivers
      .filter(d => !serviceAreaMatchedDriverIds || serviceAreaMatchedDriverIds.has(d.id))
      .filter(d => !permanentlyExcludedDriverIds.has(d.id))
      .filter(d => !excludedDriverIds.has(d.id))
      .filter(d => !cooldownDriverIds.has(d.id))
      .filter(d => !maxedOutDriverIds.has(d.id))
      .filter(d => !disabledVehicleTypeDriverIds.has(d.id))
      .filter(d => !requiredVehicleTypeDriverIds || requiredVehicleTypeDriverIds.has(d.id))
      .filter(d => !isCashTrip || cashAcceptingDriverIds.has(d.id))
      .filter(d => !(isMarketplaceDeliveryTrip && deliveryJobsOptOutDriverIds.has(d.id)))
      .filter(d => !(isMarketplaceDeliveryTrip && deliveryCategoryOptOutDriverIds.has(d.id)))
      .filter(d => d.current_lat && d.current_lng)
      .filter(d => {
        // If driver has towards_destination active, only include if trip dropoff is near their destination
        const dest = destinationMap.get(d.id);
        if (dest) {
          const distToDestination = calculateDistance(dropoffLat, dropoffLng, dest.lat, dest.lng);
          if (distToDestination > destinationMatchRadiusM) {
            console.log(`[auto-dispatch] Skipping driver ${d.id} - towards destination active but dropoff ${Math.round(distToDestination)}m from their destination (max ${destinationMatchRadiusM}m)`);
            return false;
          }
          console.log(`[auto-dispatch] Driver ${d.id} towards destination MATCH - dropoff ${Math.round(distToDestination)}m from their destination`);
        }
        return true;
      })
      .map(d => ({
        ...d,
        distance_meters: calculateDistance(pickupLat, pickupLng, d.current_lat!, d.current_lng!),
        acceptance_rate: acceptanceRateByDriverId.get(d.id) ?? 0.5,
        is_stacked: false,
      }))
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
      .sort((a, b) => compareDispatchCandidates(dispatchSettings, a, b))
      .slice(0, shortlistLimit);

    // Apply offer-level filters to stacked candidates (trip-exclusion, cooldown, vehicle type, cash)
    // Each rejection logged to dispatch_eligibility_log for audit.
    let filteredStackedDrivers: StackedDriver[] = stackedDrivers
      .filter(d => {
        if (permanentlyExcludedDriverIds.has(d.id)) {
          logEligibility(d.id, false, "stacked_permanent_exclusion", { stacked_gate: true });
          return false;
        }
        if (excludedDriverIds.has(d.id)) {
          logEligibility(d.id, false, "stacked_existing_offer_for_trip", { stacked_gate: true });
          return false;
        }
        if (cooldownDriverIds.has(d.id)) {
          logEligibility(d.id, false, "stacked_cooldown_after_decline", { stacked_gate: true });
          return false;
        }
        if (disabledVehicleTypeDriverIds.has(d.id)) {
          logEligibility(d.id, false, "stacked_vehicle_type_disabled", { stacked_gate: true, vehicle_type_id: effectiveVehicleTypeId });
          return false;
        }
        if (requiredVehicleTypeDriverIds && !requiredVehicleTypeDriverIds.has(d.id)) {
          logEligibility(d.id, false, "stacked_missing_required_vehicle_category", { stacked_gate: true, vehicle_type_id: effectiveVehicleTypeId });
          return false;
        }
        if (isCashTrip && !cashAcceptingDriverIds.has(d.id)) {
          logEligibility(d.id, false, "stacked_cash_not_opted_in", { stacked_gate: true });
          return false;
        }
        if (isMarketplaceDeliveryTrip && deliveryJobsOptOutDriverIds.has(d.id)) {
          logEligibility(d.id, false, "stacked_delivery_jobs_disabled", { stacked_gate: true });
          return false;
        }
        if (isMarketplaceDeliveryTrip && deliveryCategoryOptOutDriverIds.has(d.id)) {
          logEligibility(d.id, false, "stacked_delivery_category_disabled", {
            stacked_gate: true,
            delivery_type: marketplaceDeliveryType,
          });
          return false;
        }
        // Towards-destination filter
        const dest = destinationMap.get(d.id);
        if (dest) {
          const distToDestination = calculateDistance(dropoffLat, dropoffLng, dest.lat, dest.lng);
          if (distToDestination > destinationMatchRadiusM) {
            logEligibility(d.id, false, "stacked_towards_destination_mismatch", {
              stacked_gate: true,
              distance_to_destination_m: Math.round(distToDestination),
              max_destination_radius_m: destinationMatchRadiusM,
            });
            return false;
          }
        }
        return true;
      });

    // Sort stacked drivers by dispatch score (same SSOT as idle pool).
    filteredStackedDrivers.sort((a, b) =>
      compareDispatchCandidates(
        dispatchSettings,
        { ...a, distance_meters: a.distance_from_current_dropoff ?? a.distance_meters },
        { ...b, distance_meters: b.distance_from_current_dropoff ?? b.distance_meters },
      ),
    );

    const eligibleStackedDrivers = filteredStackedDrivers;

    // Wave N parallel width â ALWAYS admin waveN_size (or max_offers_per_request fallback).
    // Never use cascade_batch_size here: with cascade_batch_size=1 only one idle driver was
    // selected per invocation, deferring others to later rounds (misaligned with wave settings).
    waveDriverCap = waveDriverCapForRound(dispatchSettings as Record<string, unknown>, currentRound);
    const batchSize = Math.max(1, waveDriverCap);

    const stackedCap = stackedRideConfig.maxStackedRides;
    const stackedSlice = eligibleStackedDrivers.slice(0, stackedCap);
    const idleSelected = eligibleIdleDrivers.slice(0, batchSize);

    audit("dispatch_wave_trace", {
      booking_id: trip_id,
      broadcast_round: currentRound,
      recheck_policy: "wave_fresh_eligibility_v1",
      temporary_exclusions_this_wave: temporaryExclusionCountThisWave,
      drivers_recovered_eligible_this_wave: driversRecoveredEligibleThisWave,
      batch_mode: batchMode,
      cascade_batch_size: dispatchSettings.cascade_batch_size,
      wave_driver_cap_from_config: waveDriverCap,
      eligible_idle_ranked_count: eligibleIdleDrivers.length,
      idle_selected_count: idleSelected.length,
      selected_idle_driver_ids: idleSelected.map((d) => d.id),
      idle_ranked: eligibleIdleDrivers.map((d, i) => {
        const dd = d as Record<string, unknown>;
        return {
          driver_id: d.id,
          driver_code: (dd.driver_code as string | undefined) ?? null,
          service_area_id: (dd.service_area_id as string | undefined) ?? null,
          rank: i + 1,
          distance_meters: Math.round(d.distance_meters ?? 0),
          category_priority: (d as { category_priority?: number }).category_priority ?? null,
          score: computeDispatchScore(dispatchSettings, d, d.distance_meters ?? 0),
          heartbeat_age_seconds: secondsSinceIso(dd.last_heartbeat_at as string),
          location_age_seconds: secondsSinceIso(dd.last_location_at as string),
          wave_number: currentRound,
          eligible: true,
          selected_for_offer: i < batchSize,
          exclusion_reason: i < batchSize ? null : "beyond_wave_cap",
        };
      }),
      eligible_stacked_count: eligibleStackedDrivers.length,
      stacked_selected_driver_ids: stackedSlice.map((d) => d.id),
      delivery_note:
        "ride_offers INSERT fires push/socket path; see booking_delivery_log + dispatch_eligibility_log per driver.",
    });

    const combinedDrivers = [...idleSelected, ...stackedSlice];

    uniqueDrivers = Array.from(new Map(combinedDrivers.map(d => [d.id, d])).values());

    for (const d of uniqueDrivers) {
      const isStackedDriver = !!(d as { is_stacked?: boolean }).is_stacked;
      queueSnapshot("selected", d.id, {
        isStackedOffer: isStackedDriver,
        metadata: {
          is_stacked: isStackedDriver,
          distance_meters: d.distance_meters ? Math.round(d.distance_meters) : null,
        },
      });
    }

    console.log("[auto-dispatch] Wave driver cap:", waveDriverCap, "| batch_mode:", batchMode, "| idle chosen:", idleSelected.length, "| stacked chosen:", stackedSlice.length, "| unique:", uniqueDrivers.length);
    console.log("[auto-dispatch] Eligible drivers after filtering:", uniqueDrivers.length);

    if (uniqueDrivers.length === 0) {
      const exclusionCounts = Object.fromEntries(
        [...exclusionReasonCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      );
      const driversNotReachingPayload = {
        trip_id,
        trip_number: (trip as { trip_number?: string | null }).trip_number ?? null,
        service_area_id: trip.service_area_id,
        broadcast_round: currentRound,
        max_rounds: maxRounds,
        exclusion_counts: exclusionCounts,
        idle_candidates_ranked: eligibleIdleDrivers.length,
        stacked_candidates_ranked: eligibleStackedDrivers.length,
        presence_rows_checked: (presenceDrivers || []).length,
        drivers_table_rows_checked: (allDrivers || []).length,
      };
      console.warn("[auto-dispatch] DRIVERS_NOT_REACHING_BOOKING", driversNotReachingPayload);
      const { error: noEligibleErr } = await supabase.rpc("record_booking_delivery", {
        p_booking_id: trip_id,
        p_phase: "no_eligible_drivers",
        p_driver_id: null,
        p_offer_id: null,
        p_source: "edge_auto_dispatch",
        p_detail: {
          ...driversNotReachingPayload,
          log_token: "DRIVERS_NOT_REACHING_BOOKING",
        },
      });
      if (noEligibleErr) {
        console.warn("[auto-dispatch] record_booking_delivery(no_eligible_drivers) failed:", noEligibleErr);
      }

      if (currentRound >= maxRounds) {
        if (
          !isScheduledInstantConversionPending(trip) &&
          shouldExpireTripAfterWavesExhausted(trip, dispatchSettings)
        ) {
          await expireTripWhenSearchExhaustedAndNotifyCustomer(supabase, {
            tripId: trip_id,
            passengerId: (trip as { passenger_id?: string | null }).passenger_id ?? null,
          });
          abortDispatch("NO_DRIVERS_SEARCH_ENDED", {
            round: currentRound,
            max_rounds: maxRounds,
            exclusion_counts: exclusionCounts,
          });
          return successResponse({
            success: false,
            trip_id,
            error: "No drivers available; customer search window ended",
            offers_created: 0,
            round: currentRound,
          });
        }

        console.log("[auto-dispatch]", WAVE3_NO_ELIGIBLE_LOG_TOKEN, {
          trip_id,
          broadcast_round: currentRound,
          max_rounds: maxRounds,
          searching_expires_at: trip.searching_expires_at ?? null,
        });
        audit(WAVE3_NO_ELIGIBLE_LOG_TOKEN, {
          broadcast_round: currentRound,
          max_rounds: maxRounds,
          exclusion_counts: exclusionCounts,
          searching_expires_at: trip.searching_expires_at ?? null,
        });

        await supabase
          .from("trips")
          .update({
            dispatch_status: "broadcasting",
            status: trip.status === "searching_new_driver" ? "searching_new_driver" : "searching",
            current_broadcast_round: currentRound,
            updated_at: new Date().toISOString(),
          })
          .eq("id", trip_id);

        abortDispatch("NO_DRIVERS_FINAL_WAVE", {
          round: currentRound,
          max_rounds: maxRounds,
          exclusion_counts: exclusionCounts,
        });
        return successResponse({
          success: true,
          trip_id,
          message: "No drivers on final wave; waiting for customer search window",
          round: currentRound,
          offers_created: 0,
          log_token: WAVE3_NO_ELIGIBLE_LOG_TOKEN,
        });
      }

      await supabase
        .from("trips")
        .update({
          dispatch_status: "broadcasting",
          status: trip.status === "searching_new_driver" ? "searching_new_driver" : "searching",
          current_broadcast_round: currentRound,
          updated_at: new Date().toISOString(),
        })
        .eq("id", trip_id);

      abortDispatch("NO_DRIVERS_WAIT_NEXT_ROUND", {
        round: currentRound,
        exclusion_counts: exclusionCounts,
      });
      return successResponse({
        success: true,
        trip_id,
        message: "No drivers available, waiting for next round",
        round: currentRound,
        offers_created: 0,
      });
    }

    } // end !enrichExistingOffersMode (driver search)

    // 7. Create offers for each driver
    let offerExpirySeconds = offerExpirySecondsResolved;
    let expiresAt = new Date(Date.now() + offerExpirySeconds * 1000).toISOString();
    const dispatchSnapshotFields = {
      ...dispatchOfferSnapshotFields(dispatchSettings as Record<string, unknown>, currentRound),
      dispatch_source: "auto_dispatch",
      dispatch_wave: waveCommission.wave,
      dispatch_round: waveCommission.dispatchRound,
      broadcast_sequence: currentRound,
      base_commission_percent: waveCommission.basePercent,
      wave_commission_reduction_percent: waveCommission.reductionPercent,
      effective_commission_percent: waveCommission.effectivePercent,
    };

    // 7a. Preset Fare Offers — Admin config + SSOT eligibility (no hardcoded chips).
    let offerOptions: number[] | null = null;
    let offerSnapshot: Record<string, unknown> | null = null;

    const sourceBlock = presetNegotiationSourceIneligibility(trip);
    const isScheduledTrip = isScheduledTripIneligibleForPresetNegotiation(trip);
    const isScanAndGo = trip.dispatch_mode === "scan_and_go";
    const isCustomZoneTrip = !!(trip.pickup_zone_id || trip.dropoff_zone_id);
    const negotiationDisabledForTrip = !!(trip as { negotiation_disabled?: boolean }).negotiation_disabled;

    const baseFarePence = resolveNegotiationBaseFarePence(trip);
    const tripFareSnapshotFields = tripFareFieldsForOfferSnapshot(
      trip as Record<string, unknown>,
    );

    let presetEligibilityResult: string = negotiationDisabledForTrip
      ? "negotiation_disabled"
      : sourceBlock
      ? sourceBlock.reason
      : isScanAndGo
      ? "ineligible_scan_and_go"
      : isCustomZoneTrip
      ? "ineligible_custom_zone"
      : "pending";

    const mayAttachPresets =
      !negotiationDisabledForTrip &&
      !sourceBlock &&
      !isScanAndGo &&
      !isCustomZoneTrip;

    console.log("[auto-dispatch] Preset eligibility:", {
      ride_id: trip_id,
      pricing_mode: trip.pricing_mode ?? null,
      fare_locked: trip.fare_locked ?? false,
      negotiation_enabled: dispatchSettings.fare_negotiation_enabled ?? null,
      preset_eligibility_result: presetEligibilityResult,
      service_area_id: trip.service_area_id ?? null,
      base_fare_pence: baseFarePence,
    });

    if (trip.service_area_id && mayAttachPresets) {
      const [{ data: presetConfig, error: presetConfigError }, { data: saRow }] = await Promise.all([
        supabase
          .from("preset_offer_configs")
          .select("*, preset_offers(*)")
          .eq("service_area_id", trip.service_area_id)
          .maybeSingle(),
        supabase
          .from("service_areas")
          .select("timezone, region:regions(timezone)")
          .eq("id", trip.service_area_id)
          .maybeSingle(),
      ]);

      const timezone =
        (saRow as { region?: { timezone?: string } } | null)?.region?.timezone
        || saRow?.timezone
        || "UTC";
      const nestedOffers = ((presetConfig?.preset_offers as unknown[]) ?? []);

      console.log("PRESET_CONFIG_QUERY", {
        ride_id: trip_id,
        service_area_id: trip.service_area_id,
        config_found: !!presetConfig,
        config_enabled: presetConfig?.is_enabled ?? false,
        query_error: presetConfigError?.message ?? null,
        active_preset_offers_count: (nestedOffers as Array<{ is_active?: boolean }>).filter(
          (o) => o.is_active,
        ).length,
        price_mode: presetConfig?.price_mode ?? null,
        timezone,
      });

      if (presetConfigError) {
        console.warn("[auto-dispatch] preset_offer_configs query error:", presetConfigError.message);
        presetEligibilityResult = "config_query_error";
      } else {
        const resolved = resolvePresetNegotiation({
          trip,
          serviceAreaId: trip.service_area_id,
          baseFarePence,
          config: presetConfig
            ? {
                is_enabled: presetConfig.is_enabled,
                schedule_enabled: presetConfig.schedule_enabled,
                schedule_days: presetConfig.schedule_days ?? [],
                schedule_start_time: presetConfig.schedule_start_time ?? "00:00",
                schedule_end_time: presetConfig.schedule_end_time ?? "23:59",
                price_mode: presetConfig.price_mode,
                countdown_seconds: presetConfig.countdown_seconds,
                countdown_enabled: presetConfig.countdown_enabled,
              }
            : null,
          offers: nestedOffers as Array<{
            offer_key?: string | null;
            label?: string | null;
            fixed_amount_pence?: number | null;
            multiplier?: number | null;
            color?: string | null;
            display_order?: number | null;
            is_active?: boolean | null;
          }>,
          timezone,
        });
        presetEligibilityResult = resolved.reason;
        if (resolved.ok) {
          offerOptions = deriveOfferOptionsPence(resolved.presetOptions);
          offerSnapshot = {
            ...tripFareSnapshotFields,
            ...presetNegotiationSnapshotFields({
              baseFarePence,
              presetOptions: resolved.presetOptions,
              countdownSeconds: resolved.countdownSeconds,
            }),
            ...dispatchSnapshotFields,
          };
          // Initial offer TTL stays dispatch offer_expiry_seconds.
          // Admin countdown_seconds is stamped later as the negotiation response window.
        }
      }
    } else if (!trip.service_area_id) {
      presetEligibilityResult = "missing_service_area";
    }

    if (negotiationDisabledForTrip || sourceBlock) {
      offerOptions = null;
      offerSnapshot = {
        baseFarePence,
        ...tripFareSnapshotFields,
        negotiationLocked: true,
        negotiationDisabled: true,
        negotiationAllowed: false,
        negotiation_eligible: false,
        rebroadcastStandardOnly: true,
        presets_enabled: false,
        countdown_auto_select: false,
        preset_options: [],
        fareSource: isScheduledTrip
          ? "scheduled_standard"
          : ((trip as { fare_snapshot_json?: { fare_source?: string } }).fare_snapshot_json?.fare_source
            ?? "rebroadcast_standard"),
        ...dispatchSnapshotFields,
      };
      if (sourceBlock) presetEligibilityResult = sourceBlock.reason;
    }

    console.log("PRESET_COMPUTED", {
      ride_id: trip_id,
      service_area_id: trip.service_area_id,
      pricing_mode: trip.pricing_mode ?? null,
      fare_locked: trip.fare_locked ?? false,
      preset_eligibility_result: presetEligibilityResult,
      generated_offer_options: offerOptions,
      generated_preset_options: (offerSnapshot as { preset_options?: unknown } | null)
        ?.preset_options ?? null,
      enrich_existing_offers_mode: enrichExistingOffersMode,
    });

    if (enrichExistingOffersMode) {
      const { data: stackedPending } = await supabase
        .from("ride_offers")
        .select("id, offer_snapshot")
        .eq("trip_id", trip_id)
        .eq("status", "pending")
        .eq("is_stacked", true)
        .gt("expires_at", new Date().toISOString());

      let stackedStripped = 0;
      for (const row of stackedPending ?? []) {
        const existing = (row.offer_snapshot && typeof row.offer_snapshot === "object"
          && !Array.isArray(row.offer_snapshot))
          ? { ...(row.offer_snapshot as Record<string, unknown>) }
          : {};
        delete existing.countdown_seconds;
        delete existing.presetCountdownSeconds;
        delete existing.default_selected_offer_id;
        delete existing.negotiationExpiresAt;
        const { error: stackedStripErr } = await supabase
          .from("ride_offers")
          .update({
            offer_options: null,
            offer_snapshot: {
              ...existing,
              ...stackedOfferNegotiationLockFields(),
            },
          })
          .eq("id", row.id);
        if (!stackedStripErr) stackedStripped += 1;
      }
      if (stackedStripped > 0) {
        console.log("PRESET_STRIPPED_STACKED_OFFERS", {
          trip_id,
          stripped_count: stackedStripped,
        });
      }

      if (sourceBlock && offerSnapshot) {
        const { data: stripped, error: stripErr } = await supabase
          .from("ride_offers")
          .update({
            offer_options: null,
            offer_snapshot: offerSnapshot,
          })
          .eq("trip_id", trip_id)
          .eq("status", "pending")
          .or("is_stacked.eq.false,is_stacked.is.null")
          .gt("expires_at", new Date().toISOString())
          .select("id");
        console.log("PRESET_STRIPPED_EXCLUDED_SOURCE", {
          trip_id,
          reason: sourceBlock.reason,
          stripped_count: stripped?.length ?? 0,
          strip_error: stripErr?.message ?? null,
        });
        return successResponse({
          success: true,
          trip_id,
          message: "Excluded booking source — negotiation chips stripped",
          offers_enriched: stripped?.length ?? 0,
          offer_options: null,
          offers_created: stripped?.length ?? 0,
        });
      }
      if (offerOptions && offerOptions.length >= 3) {
        const { data: enriched, error: enrichErr } = await supabase
          .from("ride_offers")
          .update({
            offer_options: offerOptions,
            offer_snapshot: offerSnapshot,
          })
          .eq("trip_id", trip_id)
          .eq("status", "pending")
          .or("is_stacked.eq.false,is_stacked.is.null")
          .gt("expires_at", new Date().toISOString())
          .select("id, offer_options, offer_snapshot");

        console.log("PRESET_ENRICHED_EXISTING_OFFERS", {
          trip_id,
          offer_options: offerOptions,
          enriched_count: enriched?.length ?? 0,
          enrich_error: enrichErr?.message ?? null,
          sample: enriched?.[0] ?? null,
        });

        return successResponse({
          success: true,
          trip_id,
          message: "Enriched existing ride_offers with preset options",
          offers_enriched: enriched?.length ?? 0,
          offer_options: offerOptions,
          offers_created: enriched?.length ?? 0,
        });
      }

      // SQL offers already exist â do not fail dispatch if preset config is temporarily unavailable.
      console.warn("[auto-dispatch] enrichExistingOffersMode: presets not computed, SQL offers unchanged", {
        trip_id,
        offer_options: offerOptions,
      });
      return successResponse({
        success: true,
        trip_id,
        message: "Trip already offered (SQL broadcast); preset enrichment skipped",
        offers_created: 0,
      });
    }

    const insertedAt = new Date().toISOString();
    driversForOffers = uniqueDrivers.filter(
      (d) => !permanentlyExcludedDriverIds.has(d.id),
    );
    if (driversForOffers.length < uniqueDrivers.length) {
      console.log("[auto-dispatch] Skipped permanently excluded drivers on insert", {
        trip_id,
        excluded_count: uniqueDrivers.length - driversForOffers.length,
        excluded_driver_ids: [...permanentlyExcludedDriverIds],
      });
    }
    const offerCurrencyCode =
      typeof (trip as { currency_code?: string }).currency_code === "string"
        ? (trip as { currency_code: string }).currency_code
        : "GBP";

    const offersToCreate = driversForOffers.map(driver => {
      const driverOnActiveTrip =
        activeTripDriverIds.has(driver.id) || Boolean(driver.current_trip_id);
      const isStacked = Boolean(driver.is_stacked) || driverOnActiveTrip;

      if (driverOnActiveTrip && !driver.is_stacked) {
        console.log("[auto-dispatch] FORCE_STACKED_OFFER_FOR_BUSY_DRIVER", {
          trip_id,
          driver_id: driver.id,
          lifecycle: STACKED_RIDE_STATES.stacked_offer,
        });
      }

      // Hard rule: stacked rides disable negotiations.
      // Stacked drivers see accept/decline only at original fare â no preset chips.
      const driverOfferOptions = isStacked ? null : offerOptions;
      const driverOfferSnapshot = isStacked
        ? enrichOfferSnapshotDriverNet(
          {
            baseFarePence,
            ...tripFareSnapshotFields,
            ...stackedOfferNegotiationLockFields(),
            ...dispatchSnapshotFields,
          },
          driver,
          waveCommission.effectivePercent,
          baseFarePence,
          offerCurrencyCode,
        )
        : enrichOfferSnapshotDriverNet(
          (presetEligibilityResult === "attached" && offerSnapshot)
            ? { ...offerSnapshot, ...dispatchSnapshotFields }
            : {
                baseFarePence,
                ...tripFareSnapshotFields,
                negotiationLocked: true,
                negotiationDisabled: true,
                negotiationAllowed: false,
                negotiation_eligible: false,
                rebroadcastStandardOnly: true,
                presets_enabled: false,
                countdown_auto_select: false,
                preset_options: [],
                fareSource:
                  (trip as { fare_snapshot_json?: { fare_source?: string } }).fare_snapshot_json?.fare_source
                  ?? "standard_only_fallback",
                ...dispatchSnapshotFields,
              },
          driver,
          waveCommission.effectivePercent,
          baseFarePence,
          offerCurrencyCode,
        );

      const driverNetPreview = Number(
        (driverOfferSnapshot as { driver_net_fare_pence?: number }).driver_net_fare_pence
        ?? (driverOfferSnapshot as { driver_net_preview_pence?: number }).driver_net_preview_pence
        ?? 0,
      );
      if (!Number.isFinite(driverNetPreview) || driverNetPreview <= 0) {
        console.warn("[auto-dispatch] SKIP_OFFER_NO_DRIVER_NET", {
          trip_id,
          driver_id: driver.id,
          base_fare_pence: baseFarePence,
          effective_commission_percent: waveCommission.effectivePercent,
          tier: extractDriverTierName(driver),
        });
        return null;
      }

      return {
        trip_id: trip_id,
        driver_id: driver.id,
        status: "pending",
        expires_at: expiresAt,
        broadcast_round: currentRound,
        dispatch_wave: waveCommission.wave,
        dispatch_round: waveCommission.dispatchRound,
        base_commission_percent: waveCommission.basePercent,
        wave_commission_reduction_percent: waveCommission.reductionPercent,
        effective_commission_percent: waveCommission.effectivePercent,
        offered_driver_net_pence: Math.round(driverNetPreview),
        offered_at: insertedAt,
        is_stacked: isStacked,
        distance_meters: driver.distance_meters ? Math.round(driver.distance_meters) : null,
        created_at: insertedAt,
        ...(driverOfferSnapshot
          ? { offer_options: driverOfferOptions ?? null, offer_snapshot: driverOfferSnapshot }
          : driverOfferOptions
            ? { offer_options: driverOfferOptions, offer_snapshot: driverOfferSnapshot }
            : {}),
      };
    }).filter((row): row is NonNullable<typeof row> => row != null);

    // Atomically commit dispatch wave and insert offers with optimistic concurrency checks
    const waveExpirySeconds = offerExpirySeconds;
    const { data: waveResult, error: waveErr } = await supabase.rpc("commit_dispatch_wave", {
      p_trip_id: trip_id,
      p_expected_version: trip.trip_version ?? 1,
      p_offers: offersToCreate,
      p_expires_in_seconds: waveExpirySeconds,
    });

    if (waveErr || !waveResult?.success) {
      console.error("[auto-dispatch] commit_dispatch_wave failed:", waveErr || waveResult?.error);
      abortDispatch("DB_ERROR_CREATE_OFFERS", {
        error: waveErr?.message || waveResult?.error || "commit_dispatch_wave_failed",
      });
      return errorResponse("DB_ERROR", "Failed to commit dispatch wave", 500);
    }

    // Monotonic incentive floor for subsequent waves/rounds (never regress earnings).
    await supabase
      .from("trips")
      .update({
        max_wave_commission_reduction_percent: waveCommission.reductionPercent,
        updated_at: new Date().toISOString(),
      })
      .eq("id", trip_id)
      .lt("max_wave_commission_reduction_percent", waveCommission.reductionPercent);

    const createdOffers = (waveResult.inserted_offers || []).map((o: any) => ({
      id: o.offer_id,
      driver_id: o.driver_id,
    }));

    for (const o of createdOffers) {
      const offerRow = offersToCreate.find((row) => row.driver_id === o.driver_id);
      queueSnapshot("offer_inserted", o.driver_id, {
        isStackedOffer: offerRow?.is_stacked === true,
        rideOfferId: o.id,
        metadata: {
          broadcast_round: currentRound,
          via: "edge_auto_dispatch",
          is_stacked: offerRow?.is_stacked === true,
        },
      });
    }

    // Stamp preset_options on offers when edge dispatch skipped them (SQL-only path / race).
    if (
      mayAttachPresets
      && presetEligibilityResult !== "attached"
      && createdOffers?.length
    ) {
      const { data: enrichResult, error: enrichErr } = await supabase.rpc(
        "enrich_ride_offer_presets",
        { p_trip_id: trip_id },
      );
      console.log("PRESET_ENRICH_AFTER_INSERT", {
        ride_id: trip_id,
        preset_eligibility_result: presetEligibilityResult,
        enrich_ok: enrichErr == null,
        enrich_result: enrichResult ?? null,
        enrich_error: enrichErr?.message ?? null,
      });
    }

    // ââ UNIFIED WAVE SNAPSHOT â one complete audit row per dispatch wave ââââââ
    // Maps created offers back to selected drivers for per-driver ride_offer_id.
    const offerByDriverId = new Map<string, string>();
    for (const o of createdOffers || []) {
      offerByDriverId.set(o.driver_id, o.id);
    }

    // Build per-driver array: every driver considered, with full classification
    const eligibleIdleSet = new Set(eligibleIdleDrivers.map((d) => d.id));
    const selectedSet = new Set(driversForOffers.map((d) => d.id));

    // Count degraded eligible
    const degradedEligibleCount = eligibleIdleDrivers.filter(
      (d) => (d as { dispatch_quality?: string }).dispatch_quality === "degraded",
    ).length;

    // Build per-driver detail for selected + eligible drivers (capped to avoid payload bloat)
    const driverDetails = driversForOffers.map((d, i) => {
      const dd = d as Record<string, unknown>;
      const offerId = offerByDriverId.get(d.id) ?? null;
      const isInsertMissing = !offerId; // selected but no offer row
      return {
        driver_id: d.id,
        driver_code: (dd.driver_code as string | undefined) ?? null,
        distance_rank: i + 1,
        distance_to_pickup: Math.round(d.distance_meters ?? 0),
        eligible: true,
        degraded: (dd.dispatch_quality as string) === "degraded",
        hard_excluded: false,
        reject_reason: null as string | null,
        reject_reason_category: null as string | null,
        delivery_channel: (dd.has_registered_push_token ? "push" : "realtime_only") as string,
        selected_for_offer: true,
        ride_offer_id: offerId,
        push_status: "pending" as string, // updated after push loop
        classification: isInsertMissing ? "OFFER_INSERT_MISSING_AFTER_SELECTION" : null,
      };
    });

    const previousOfferStatuses = (previousWaveOutcomes || []).map((o) => ({
      driver_id: o.driver_id,
      status: o.status,
      broadcast_round: o.broadcast_round,
    }));

    // Detect anomalies
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    const insertMissingCount = driverDetails.filter((d) => d.classification === "OFFER_INSERT_MISSING_AFTER_SELECTION").length;
    if (insertMissingCount > 0) {
      errorCode = "OFFER_INSERT_MISSING_AFTER_SELECTION";
      errorMessage = `${insertMissingCount} driver(s) selected but no ride_offer row created`;
    } else if (driversForOffers.length > 0 && (!createdOffers || createdOffers.length === 0)) {
      errorCode = "OFFER_INSERT_FAILED";
      errorMessage = "All offer inserts failed";
    }

    // Compute hard_excluded_count from exclusion reason counts
    let hardExcludedCount = 0;
    for (const [reason, count] of exclusionReasonCounts) {
      if (reason !== "beyond_wave_cap") {
        hardExcludedCount += count;
      }
    }

    const waveSnapshot = {
      trip_id,
      trip_code: (trip as { trip_number?: string | null }).trip_number ?? null,
      dispatch_round: currentRound,
      trigger_reason: triggerReasonResolved,
      reason_for_next_wave: reasonForNextWave,
      wave1_size: dispatchSettings.wave1_size,
      wave2_size: dispatchSettings.wave2_size,
      wave3_size: dispatchSettings.wave3_size,
      actual_wave_cap: waveDriverCap,
      candidate_count: candidateDriverCount,
      eligible_count: eligibleIdleDrivers.length,
      degraded_count: degradedEligibleCount,
      hard_excluded_count: hardExcludedCount,
      selected_count: driversForOffers.length,
      offer_created_count: createdOffers?.length ?? 0,
      push_sent_count: 0, // updated after push loop
      selected_driver_ids: driversForOffers.map((d) => d.id),
      declined_from_previous_wave: [...new Set(declinedFromPreviousWaves)],
      timed_out_from_previous_wave: [...new Set(timedOutFromPreviousWaves)],
      skipped_driver_ids: eligibleIdleDrivers
        .filter((d) => !selectedSet.has(d.id))
        .map((d) => d.id),
      previous_offer_statuses: previousOfferStatuses.length > 20
        ? previousOfferStatuses.slice(0, 20)
        : previousOfferStatuses,
      error_code: errorCode,
      error_message: errorMessage,
      drivers: driverDetails,
      exclusion_reason_counts: Object.fromEntries(exclusionReasonCounts),
    };

    audit("dispatch_wave_snapshot", waveSnapshot, null, currentRound);
    if (reasonForNextWave === "offer_expired" && (createdOffers?.length ?? 0) > 0) {
      audit("next_wave_started", {
        broadcast_round: currentRound,
        reason_for_next_wave: reasonForNextWave,
        offers_inserted: createdOffers?.length ?? 0,
      }, null, currentRound);
      audit("offers_inserted", {
        count: createdOffers?.length ?? 0,
        driver_ids: (createdOffers || []).map((o) => o.driver_id),
        reason_for_next_wave: reasonForNextWave,
      }, null, currentRound);
      console.log("[auto-dispatch] next_wave_started", {
        trip_id,
        broadcast_round: currentRound,
        reason_for_next_wave: reasonForNextWave,
        offers_inserted: createdOffers?.length ?? 0,
      });
    }
    console.log("[auto-dispatch] DISPATCH_WAVE_SNAPSHOT", {
      trip_id,
      round: currentRound,
      selected: driversForOffers.length,
      inserted: createdOffers?.length ?? 0,
      error_code: errorCode,
    });

    // Per-driver eligibility audit (offer created)
    for (const o of createdOffers || []) {
      const drv = uniqueDrivers.find(d => d.id === o.driver_id) as any;
      const hasNativeToken = !!drv?.has_registered_push_token || !!drv?.has_presence_push_token;
      const priorRecovery = priorRecheckByDriver.get(o.driver_id);
      logEligibility(o.driver_id, true, "eligible", {
        offer_id: o.id,
        offer_created_after_recovery: !!priorRecovery?.hadTemporaryExclusion,
        is_stacked: !!drv?.is_stacked,
        distance_meters: drv?.distance_meters ? Math.round(drv.distance_meters) : null,
        service_area_match_source: serviceAreaMatchSourceByDriverId.get(o.driver_id) ?? null,
        trip_service_area_id: trip.service_area_id ?? null,
        driver_service_area_id: drv?.service_area_id ?? null,
        delivery: {
          ride_offer_row_realtime_broadcast: true,
          push_enqueued_via_insert_trigger: true,
          registered_native_push: hasNativeToken,
          presence_push_token_hint: !!drv?.has_presence_push_token,
          app_state: drv?.app_state ?? null,
          registered_push_platforms: drv?.registered_push_platforms ?? [],
          socket_connected_heartbeat_hint: drv?.socket_connected ?? null,
          driver_last_socket_pong_at: drv?.last_socket_pong_at ?? null,
        },
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

        // Same post-accept Customer driver_assigned path as accept-offer / fare final.
        try {
          const finalize = await finalizeRideAssignmentSideEffects(supabase, {
            tripId: trip_id,
            offerId: nearestAutoAcceptOffer.id,
            driverId: nearestAutoAcceptOffer.driver_id,
            source: "edge_auto_dispatch_auto_accept",
            acceptedVia: "accept_ride_offer",
          });
          if (!finalize.ok) {
            console.warn("[auto-dispatch] AUTO-ACCEPT finalize incomplete:", finalize);
          }
        } catch (finalizeErr) {
          console.warn("[auto-dispatch] AUTO-ACCEPT finalize failed:", finalizeErr);
        }
        
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

    // 9. Update trip status (only if all offers are stacked)
    // commit_dispatch_wave RPC already set status='offered' and dispatch_status='broadcasting'.
    // If all offers are stacked, override dispatch_status to 'offered_stacked'.
    if (!autoAccepted) {
      const allOffersAreStacked =
        driversForOffers.length > 0 &&
        driversForOffers.every(
          (d) => Boolean((d as Record<string, unknown>).is_stacked) || Boolean(d.current_trip_id),
        );
      if (allOffersAreStacked) {
        await supabase
          .from("trips")
          .update({
            dispatch_status: "offered_stacked",
            updated_at: new Date().toISOString(),
          })
          .eq("id", trip_id);
      }
    }

    // 10. Reminder loop â primary offer FCM/data is sent by INSERT trigger
    // ride_offer_dispatch_push_delivery. Reminders fire at +4 s and +8 s for both iOS and Android.
    // PUSH DELIVERY TRACKING: every push attempt is logged to booking_delivery_log.
    let pushSentCount = 0;
    for (const driver of uniqueDrivers as any[]) {
      try {
        const offer = (createdOffers || []).find(o => o.driver_id === driver.id);
        if (!offer) continue;

        if (autoAccepted && offer.driver_id === nearestAutoAcceptOffer?.driver_id) continue;
        if (autoAccepted) continue;

        const hasNativeToken = !!driver.has_registered_push_token || !!driver.has_presence_push_token;
        if (!hasNativeToken) {
          // Log push skipped (no token)
          auditPromises.push(
            Promise.resolve(supabase.rpc("record_booking_delivery", {
              p_booking_id: trip_id,
              p_phase: "push_skipped",
              p_driver_id: driver.id,
              p_offer_id: offer.id,
              p_source: "edge_auto_dispatch",
              p_detail: {
                push_type: "initial",
                reason: "no_registered_push_token",
                broadcast_round: currentRound,
              },
            })).then(({ error }: { error: unknown }) => {
              if (error) console.warn("[auto-dispatch] record_booking_delivery(push_skipped) failed:", error);
            }),
          );
          continue;
        }

        const isStacked = driver.is_stacked || false;
        const notifTitle = DRIVER_NEW_RIDE_OFFER_TITLE;
        const tripRec = trip as Record<string, unknown>;
        const offerSnap = (offer.offer_snapshot ?? null) as Record<string, unknown> | null;
        const driverNetPence = driverNetPenceFromOfferContext({
          offerSnapshot: offerSnap,
          trip: tripRec,
        });
        if (driverNetPence == null || driverNetPence <= 0) {
          auditPromises.push(
            Promise.resolve(supabase.rpc("record_booking_delivery", {
              p_booking_id: trip_id,
              p_phase: "push_skipped",
              p_driver_id: driver.id,
              p_offer_id: offer.id,
              p_source: "edge_auto_dispatch",
              p_detail: {
                push_type: "initial",
                reason: "driver_net_not_ready",
                broadcast_round: currentRound,
              },
            })).then(({ error }: { error: unknown }) => {
              if (error) console.warn("[auto-dispatch] record_booking_delivery(push_skipped) failed:", error);
            }),
          );
          continue;
        }

        const notifBody = rideOfferPushBodyDriverNet(
          typeof tripRec.currency_code === "string" ? tripRec.currency_code : null,
          driverNetPence,
        );

        const semanticType = isStacked ? "stacked_ride_offer" : "new_ride_offer";
        const offerData: Record<string, string> = {
          offer_notification_type: 'new_ride_offer',
          notificationType: 'driver_new_ride_offer',
          booking_id: String(trip_id),
          sound: RIDE_OFFER_IOS_ALERT_SOUND,
          type: semanticType,
          offer_id: offer.id,
          trip_id: trip_id,
          expires_at: expiresAt,
          wave_offer_expiry_seconds: String(offerExpirySeconds),
          broadcast_round: String(currentRound),
          is_stacked: String(isStacked),
          pickupAddress: trip.pickup_address ?? '',
          dropoffAddress: trip.dropoff_address ?? '',
          pickup_summary: pickupSummaryForRideOfferPush(trip.pickup_address),
          ...(driverNetPence != null && driverNetPence > 0
            ? {
              driver_earnings_pence: String(driverNetPence),
              driver_net_preview_pence: String(driverNetPence),
            }
            : {}),
          ...(typeof trip.passenger_name === 'string' && trip.passenger_name.trim()
            ? {
              passenger_name: trip.passenger_name.trim(),
              passengerName: trip.passenger_name.trim(),
            }
            : {}),
          ...(typeof (trip as { customer_full_name?: string }).customer_full_name === 'string'
            && (trip as { customer_full_name?: string }).customer_full_name?.trim()
            ? {
              customer_full_name: (trip as { customer_full_name: string }).customer_full_name.trim(),
              customerFullName: (trip as { customer_full_name: string }).customer_full_name.trim(),
            }
            : {}),
          trip_reference: tripReferenceForRideOfferPush(tripRec),
          currencyCode: trip.currency_code ?? 'GBP',
        };

        const pushSentAt = new Date().toISOString();
        const driverPlatforms = driver.registered_push_platforms ?? [];
        pushSentCount++;

        // Log outbox reminder scheduler as OK since it was queued in the database transaction
        auditPromises.push(
          Promise.resolve(supabase.rpc("record_booking_delivery", {
            p_booking_id: trip_id,
            p_phase: "reminder_scheduler_ok",
            p_driver_id: driver.id,
            p_offer_id: offer.id,
            p_source: "edge_auto_dispatch",
            p_detail: {
              scheduler: "jobs_outbox_queue",
              platform: driverPlatforms.join(",") || "unknown",
              success: true,
              scheduled_at: pushSentAt,
              broadcast_round: currentRound,
            },
          })).then(({ error }: { error: unknown }) => {
            if (error) console.warn("[auto-dispatch] record_booking_delivery failed:", error);
          })
        );
      } catch (notifError) {
        console.error("[auto-dispatch] Failed to schedule reminders for driver:", driver.id, notifError);
      }
    }

    // Update wave snapshot with actual push_sent_count
    waveSnapshot.push_sent_count = pushSentCount;
    // Emit final push count in a follow-up audit event
    audit("dispatch_wave_push_summary", {
      push_sent_count: pushSentCount,
      offer_created_count: createdOffers?.length ?? 0,
      auto_accepted: autoAccepted,
    }, null, currentRound);

    if (reasonForNextWave === "offer_expired" && pushSentCount > 0) {
      audit("push_sent", {
        count: pushSentCount,
        broadcast_round: currentRound,
        reason_for_next_wave: reasonForNextWave,
      }, null, currentRound);
      console.log("[auto-dispatch] push_sent", {
        trip_id,
        count: pushSentCount,
        broadcast_round: currentRound,
        reason_for_next_wave: reasonForNextWave,
      });
    }

    console.log("[auto-dispatch] Created", createdOffers?.length || 0, "offers for trip", trip_id, autoAccepted ? "(auto-accepted)" : "", "pushes:", pushSentCount);

    return successResponse({
      success: true,
      trip_id,
      round: currentRound,
      offers_created: createdOffers?.length || 0,
      auto_accepted: autoAccepted,
      auto_accepted_driver: autoAccepted ? nearestAutoAcceptOffer?.driver_id : null,
      settings_source: settingsSource,
      wave_driver_cap: waveDriverCap,
      batch_mode: batchMode,
      offer_expiry_seconds_used: offerExpirySeconds,
      drivers: uniqueDrivers.map(d => ({
        id: d.id,
        distance_meters: d.distance_meters,
        is_stacked: d.is_stacked,
      })),
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error("[auto-dispatch] Error:", error);
    if (auditTripId && isValidUUID(auditTripId)) {
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        auditPromises.push(
          createClient(supabaseUrl, supabaseKey).rpc("log_dispatch_event", {
            p_trip_id: auditTripId,
            p_event_type: "dispatch_failed",
            p_round: null,
            p_driver_id: null,
            p_details: {
              reason: "unhandled_exception",
              error: errorMessage,
              stack: errorStack ?? null,
            },
          }),
        );
      } catch (auditErr) {
        console.error("[auto-dispatch] failed to queue dispatch_failed audit:", auditErr);
      }
    }
    return errorResponse("INTERNAL_ERROR", errorMessage, 500);
  } finally {
    await flushAudits();
  }
});
