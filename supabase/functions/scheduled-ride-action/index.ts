import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
import {
  securityHeaders,
  jsonHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  handleCORSPreflight,
  successResponse,
  errorResponse,
  isValidUUID,
  isValidAction,
  isValidCoordinate,
  validationErrorResponse,
} from "../_shared/security.ts";
import {
  resolveScheduledDispatchConfig,
} from "../_shared/scheduledDispatchConfig.ts";
import { maxBroadcastSequences } from "../_shared/dispatch-settings.ts";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";
import { driverMayTakeAdditionalScheduledBooking } from "../_shared/scheduledCommitmentOfferGateSSOT.ts";
import {
  checkScheduledCommissionWalletGate,
  filterTripsByScheduledCommissionWalletGate,
  SCHEDULED_COMMISSION_WALLET_ERROR,
  SCHEDULED_COMMISSION_WALLET_MESSAGE,
} from "../_shared/scheduledMarketplaceCommissionWalletGate.ts";
import { broadcastScheduledMarketplaceChanged } from "../_shared/scheduledMarketplaceRealtimeBroadcastSSOT.ts";
import { assertScheduledJourneyComplianceForDriverTrip } from "../_shared/scheduledJourneyComplianceGate.ts";
import {
  shouldUrgentConvertOnPreActivationRelease,
  buildScheduledMarketplaceRematchPatch,
  buildScheduledUrgentRematchPatch,
} from "../_shared/scheduledPreActivationReleaseSSOT.ts";
import { scheduleEdgeBackground } from "../_shared/scheduleEdgeBackground.ts";
import { isAcceptDeclineB3Enabled } from "../_shared/acceptDeclineB3SSOT.ts";

const RATE_LIMIT_CONFIG = {
  limit: 60,
  windowMs: 60000,
  keyPrefix: 'scheduled-ride-action'
};

const VALID_ACTIONS = ['accept', 'decline', 'timeout', 'get_available', 'check_eligibility', 'cancel_confirmed'];

interface ActionRequest {
  action: "accept" | "decline" | "timeout" | "get_available" | "check_eligibility" | "cancel_confirmed";
  trip_id?: string;
  driver_id: string;
  driver_lat?: number;
  driver_lng?: number;
  cancellation_reason?: string;
  cancellation_note?: string;
}

/**
 * Scheduled Ride Action Edge Function
 * 
 * Handles all scheduled ride actions with atomic operations and re-broadcast logic.
 * Actions:
 * - accept: Atomically accept a scheduled ride
 * - decline: Decline and trigger re-broadcast
 * - timeout: Mark as timed out and trigger re-broadcast
 * - get_available: Get available scheduled rides for driver (excluding declined/timeout)
 * - check_eligibility: Check if driver is eligible for a specific ride
 */
Deno.serve(async (req) => {
  console.log("[scheduled-ride-action] Received request:", req.method);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.warn("[scheduled-ride-action] Rate limit exceeded for IP:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: ActionRequest = await req.json();
    const { action, trip_id, driver_id: requestedDriverId, driver_lat, driver_lng, cancellation_reason, cancellation_note } = body;

    console.log("[scheduled-ride-action] Processing:", { action, trip_id });

    // Input validation
    const validationErrors: Record<string, string> = {};

    if (!action) {
      validationErrors.action = "action is required";
    } else if (!isValidAction(action, VALID_ACTIONS)) {
      validationErrors.action = `action must be one of: ${VALID_ACTIONS.join(', ')}`;
    }

    // Validate trip_id for actions that require it
    if (['accept', 'decline', 'timeout', 'check_eligibility'].includes(action) && !trip_id) {
      validationErrors.trip_id = `trip_id is required for ${action} action`;
    } else if (trip_id && !isValidUUID(trip_id)) {
      validationErrors.trip_id = "trip_id must be a valid UUID";
    }

    // Validate coordinates if provided
    if (driver_lat !== undefined && driver_lng !== undefined) {
      if (!isValidCoordinate(driver_lat, driver_lng)) {
        validationErrors.coordinates = "Invalid driver coordinates";
      }
    }

    if (Object.keys(validationErrors).length > 0) {
      console.log("[scheduled-ride-action] Validation failed:", validationErrors);
      return validationErrorResponse(validationErrors);
    }

    // SECURITY: Verify authenticated user and derive driver_id from JWT
    let driver_id: string;
    {
      const auth = await requireAuthenticatedUser(req, supabaseUrl, supabaseAnonKey);
      if (!auth.ok) {
        return auth.response;
      }
      const userId = auth.userId;
      
      // Get driver_id from authenticated user
      const { data: driver, error: driverError } = await supabase
        .from('drivers')
        .select('id')
        .eq('user_id', userId)
        .single();
      
      if (driverError || !driver) {
        console.log("[scheduled-ride-action] Driver not found for user:", userId);
        return errorResponse("FORBIDDEN", "Driver account not found for authenticated user", 403);
      }
      
      driver_id = driver.id;
      
      // Log if client sent a different driver_id (potential attack attempt)
      if (requestedDriverId && requestedDriverId !== driver_id) {
        console.warn("[scheduled-ride-action] SECURITY: Client sent different driver_id. Claimed:", requestedDriverId, "Actual:", driver_id);
      }
    }

    console.log("[scheduled-ride-action] Authorized driver:", driver_id);

    // Fetch admin settings
    const { data: settings } = await supabase
      .from("admin_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["search_radius_miles", "scheduled_offer_timeout_seconds", "check_in_window_minutes"]);

    const getSettingValue = (key: string, defaultValue: number): number => {
      const setting = settings?.find((s: { setting_key: string; setting_value: string }) => s.setting_key === key);
      return setting ? parseInt(String(setting.setting_value), 10) : defaultValue;
    };

    const searchRadiusMiles = getSettingValue("search_radius_miles", 6);
    const offerTimeoutSeconds = getSettingValue("scheduled_offer_timeout_seconds", 30);
    const checkInWindowMinutes = getSettingValue("check_in_window_minutes", 20);

    // ============================================================
    // ACTION: GET AVAILABLE SCHEDULED RIDES
    // ============================================================
    if (action === "get_available") {
      // Get driver info for location-based filtering
      const { data: driver } = await supabase
        .from("drivers")
        .select("id, current_lat, current_lng, is_online")
        .eq("id", driver_id)
        .single();

      if (!driver) {
        return errorResponse("NOT_FOUND", "Driver not found", 404);
      }

      // Get trips this driver has declined/timed out on
      const { data: excludedTrips } = await supabase
        .from("scheduled_offer_attempts")
        .select("trip_id")
        .eq("driver_id", driver_id)
        .in("status", ["declined", "timeout", "cancelled"]);

      const excludedTripIds = excludedTrips?.map(t => t.trip_id) || [];

      // Single backend source with broad candidate mapping:
      // we pull all recent/future scheduled-like trips and then apply explicit eligibility filters.
      const lookbackIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: availableTrips, error: queryError } = await supabase
        .from("trips")
        .select("*")
        .or(`is_scheduled.eq.true,dispatch_mode.eq.scheduled`)
        .not("scheduled_at", "is", null)
        .gte("scheduled_at", lookbackIso)
        .order("scheduled_at", { ascending: true });

      if (queryError) {
        console.error("[scheduled-ride-action] Error fetching available trips:", queryError);
        return errorResponse("QUERY_ERROR", queryError.message, 500);
      }

      const terminalTripStatuses = new Set([
        "completed",
        "cancelled",
        "expired_no_driver",
        "expired",
        // Explicit cancellation statuses — these are distinct from 'cancelled' in some flows
        "customer_cancelled",
        "driver_cancelled",
        "no_show",
      ]);
      const terminalScheduledStatuses = new Set(["cancelled", "expired", "converted_to_instant", "driver_en_route"]);
      const droppedByReason: Record<string, number> = {
        not_scheduled: 0,
        terminal_status: 0,
        terminal_scheduled_status: 0,
        assigned_driver: 0,
        targeted_other_driver: 0,
        no_schedule_time: 0,
        outside_window: 0,
      };

      const poolCandidates = (availableTrips || []).filter((trip) => {
        const isScheduledLike = trip.is_scheduled === true || trip.dispatch_mode === "scheduled";
        if (!isScheduledLike) {
          droppedByReason.not_scheduled += 1;
          return false;
        }

        if (!trip.scheduled_at) {
          droppedByReason.no_schedule_time += 1;
          return false;
        }

        const scheduledMs = Date.parse(trip.scheduled_at);
        if (!Number.isFinite(scheduledMs) || scheduledMs < Date.now() - 30 * 60 * 1000) {
          droppedByReason.outside_window += 1;
          return false;
        }

        if (terminalTripStatuses.has(trip.status)) {
          droppedByReason.terminal_status += 1;
          return false;
        }

        if (trip.scheduled_status && terminalScheduledStatuses.has(trip.scheduled_status)) {
          droppedByReason.terminal_scheduled_status += 1;
          return false;
        }

        if (trip.driver_id || trip.confirmed_driver_id) {
          droppedByReason.assigned_driver += 1;
          return false;
        }

        // Admin HELD: Driver must not see until Broadcast Now/At opens marketplace.
        if (String(trip.scheduled_status ?? "").toLowerCase() === "admin_held") {
          droppedByReason.terminal_scheduled_status += 1;
          return false;
        }

        // Align with list_driver_scheduled_jobs: no marketplace until broadcast_at is due.
        const broadcastAtRaw = trip.scheduled_broadcast_at;
        if (broadcastAtRaw == null || String(broadcastAtRaw).trim() === "") {
          droppedByReason.outside_window += 1;
          return false;
        }
        const broadcastAtMs = Date.parse(String(broadcastAtRaw));
        if (!Number.isFinite(broadcastAtMs) || broadcastAtMs > Date.now()) {
          droppedByReason.outside_window += 1;
          return false;
        }

        if (trip.current_offer_driver_id && trip.current_offer_driver_id !== driver_id) {
          droppedByReason.targeted_other_driver += 1;
          return false;
        }

        return true;
      });

      console.log("[scheduled-ride-action] Mapping diagnostics", {
        driver_id,
        lookbackIso,
        rawCount: (availableTrips || []).length,
        rawStatuses: (availableTrips || []).map((t) => ({
          id: t.id,
          status: t.status,
          scheduled_status: t.scheduled_status,
          dispatch_mode: t.dispatch_mode,
          is_scheduled: t.is_scheduled,
          scheduled_at: t.scheduled_at,
          driver_id: t.driver_id,
          confirmed_driver_id: t.confirmed_driver_id,
          current_offer_driver_id: t.current_offer_driver_id,
        })),
        droppedByReason,
        eligibleAfterMapping: poolCandidates.map((t) => t.id),
      });

      // Fetch stops for all available trips (multi-stop support)
      const tripIds = poolCandidates.map(t => t.id);
      let stopsMap: Record<string, any[]> = {};
      
      if (tripIds.length > 0) {
        const { data: allStops } = await supabase
          .from("trip_stops")
          .select("id, trip_id, stop_index, type, address, lat, lng")
          .in("trip_id", tripIds)
          .order("stop_index", { ascending: true });
        
        if (allStops) {
          stopsMap = allStops.reduce((acc: Record<string, any[]>, stop: any) => {
            if (!acc[stop.trip_id]) acc[stop.trip_id] = [];
            acc[stop.trip_id].push(stop);
            return acc;
          }, {});
        }
      }

      // Get driver's existing confirmed/active scheduled trips for overlap filtering
      const { data: driverConfirmedTrips } = await supabase
        .from("trips")
        .select("id, scheduled_at, estimated_duration_minutes")
        .or(`confirmed_driver_id.eq.${driver_id},driver_id.eq.${driver_id}`)
        .not("status", "in", '("completed","cancelled","expired","expired_no_driver","no_show")')
        .not("scheduled_at", "is", null);

      const OVERLAP_BUFFER_MIN = 15;
      const hasScheduleOverlap = (trip: any): boolean => {
        if (!trip.scheduled_at || !driverConfirmedTrips?.length) return false;
        const tripStart = new Date(trip.scheduled_at).getTime();
        const tripDuration = (trip.estimated_duration_minutes || 30) * 60_000;
        const newWindowStart = tripStart - OVERLAP_BUFFER_MIN * 60_000;
        const newWindowEnd = tripStart + tripDuration + OVERLAP_BUFFER_MIN * 60_000;

        return driverConfirmedTrips.some((ct: any) => {
          if (ct.id === trip.id) return false;
          const ctStart = new Date(ct.scheduled_at).getTime();
          const ctDuration = (ct.estimated_duration_minutes || 30) * 60_000;
          const ctWindowStart = ctStart - OVERLAP_BUFFER_MIN * 60_000;
          const ctWindowEnd = ctStart + ctDuration + OVERLAP_BUFFER_MIN * 60_000;
          return newWindowStart < ctWindowEnd && newWindowEnd > ctWindowStart;
        });
      };

      // Filter out excluded trips, distance, and overlap
      const driverLat = driver_lat || driver.current_lat;
      const driverLng = driver_lng || driver.current_lng;
      
      const filteredTrips = poolCandidates.filter(trip => {
        if (excludedTripIds.includes(trip.id)) {
          console.log(`[scheduled-ride-action] Excluding trip ${trip.id}: driver previously declined/timed out`);
          return false;
        }

        if (hasScheduleOverlap(trip)) {
          console.log(`[scheduled-ride-action] Excluding trip ${trip.id}: schedule overlap with existing confirmed trip`);
          return false;
        }

        if (driverLat && driverLng && trip.pickup_latitude && trip.pickup_longitude) {
          const distance = calculateDistanceMiles(
            driverLat, driverLng,
            trip.pickup_latitude, trip.pickup_longitude
          );
          if (distance > searchRadiusMiles) {
            console.log(`[scheduled-ride-action] Excluding trip ${trip.id}: distance ${distance.toFixed(1)}mi > ${searchRadiusMiles}mi radius`);
            return false;
          }
        }

        return true;
      });

      // Gap C: same commission-wallet gate as instant dispatch (fail closed per trip).
      const { allowed: walletEligibleTrips, blockedTripIds: walletBlockedTripIds } =
        await filterTripsByScheduledCommissionWalletGate(supabase, driver_id, filteredTrips);
      if (walletBlockedTripIds.length > 0) {
        console.log("[scheduled-ride-action] Excluding trips: commission wallet gate", {
          driver_id,
          trip_ids: walletBlockedTripIds,
        });
      }

      // Journey-horizon compliance (docs must remain valid through estimated end).
      const complianceEligibleTrips: typeof walletEligibleTrips = [];
      const complianceBlockedTripIds: string[] = [];
      for (const trip of walletEligibleTrips) {
        const journey = await assertScheduledJourneyComplianceForDriverTrip(supabase, {
          driverId: driver_id,
          tripId: String(trip.id),
          scheduledAtIso: trip.scheduled_at != null ? String(trip.scheduled_at) : null,
          estimatedDurationMinutes: trip.estimated_duration_minutes != null
            ? Number(trip.estimated_duration_minutes)
            : null,
        });
        if (journey.allowed) {
          complianceEligibleTrips.push(trip);
        } else {
          complianceBlockedTripIds.push(String(trip.id));
        }
      }
      if (complianceBlockedTripIds.length > 0) {
        console.log("[scheduled-ride-action] Excluding trips: journey compliance", {
          driver_id,
          trip_ids: complianceBlockedTripIds,
        });
      }

      // Attach stops to each trip (multi-stop support)
      const tripsWithStops = complianceEligibleTrips.map(trip => ({
        ...trip,
        stops: stopsMap[trip.id] || [],
        is_multi_stop: (stopsMap[trip.id] || []).length > 2,
      }));

      console.log(`[scheduled-ride-action] Returning ${tripsWithStops.length} available trips for driver ${driver_id} (filtered from ${poolCandidates.length}, raw ${(availableTrips || []).length})`);

      return successResponse({ 
        success: true, 
        trips: tripsWithStops,
        settings: { searchRadiusMiles, offerTimeoutSeconds, checkInWindowMinutes }
      });
    }

    // ============================================================
    // ACTION: ACCEPT SCHEDULED RIDE
    // ============================================================
    if (action === "accept") {
      const acceptStartedAt = Date.now();
      const acceptStagesMs: Record<string, number> = {};
      const markAcceptStage = (key: string, startedAt: number) => {
        acceptStagesMs[key] = Math.max(0, Date.now() - startedAt);
      };
      const b3Parallel = isAcceptDeclineB3Enabled();

      // Hard Rule #1: never preconfirm from Admin HELD / unreleased marketplace.
      // B3: one trips SELECT carries marketplace guard + commitment geometry.
      {
        const stageAt = Date.now();
        const { data: tripGuard } = await supabase
          .from("trips")
          .select(
            b3Parallel
              ? "id, scheduled_status, scheduled_broadcast_at, driver_id, confirmed_driver_id, scheduled_at, estimated_duration_minutes, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude"
              : "id, scheduled_status, scheduled_broadcast_at, driver_id, confirmed_driver_id",
          )
          .eq("id", trip_id)
          .maybeSingle();
        const sched = String(tripGuard?.scheduled_status ?? "").toLowerCase();
        if (sched === "admin_held") {
          return errorResponse(
            "INVALID_STATE",
            "This scheduled ride is still held by Admin and is not open for drivers.",
            409,
          );
        }
        const broadcastRaw = tripGuard?.scheduled_broadcast_at;
        const broadcastMs = broadcastRaw ? Date.parse(String(broadcastRaw)) : NaN;
        if (
          !broadcastRaw ||
          !Number.isFinite(broadcastMs) ||
          broadcastMs > Date.now()
        ) {
          return errorResponse(
            "INVALID_STATE",
            "This scheduled ride is not open on the marketplace yet.",
            409,
          );
        }
        if (tripGuard?.driver_id || tripGuard?.confirmed_driver_id) {
          return errorResponse("TRIP_ALREADY_TAKEN", "This ride is no longer available", 409);
        }
        markAcceptStage("marketplace_guard_ms", stageAt);

        if (b3Parallel) {
          // Phase 4 + journey + wallet: independent after marketplace open — parallelise.
          const gatesAt = Date.now();
          const candAt = Date.parse(String(tripGuard?.scheduled_at ?? ""));
          const [gate, journey, walletGate] = await Promise.all([
            Number.isFinite(candAt)
              ? driverMayTakeAdditionalScheduledBooking({
                supabase,
                driverId: driver_id,
                nowMs: Date.now(),
                candidateTripId: trip_id!,
                candidateScheduledAtMs: candAt,
                candidateDurationMinutes:
                  Number(tripGuard?.estimated_duration_minutes) || 30,
                candidatePickupLat: tripGuard?.pickup_latitude == null
                  ? null
                  : Number(tripGuard.pickup_latitude),
                candidatePickupLng: tripGuard?.pickup_longitude == null
                  ? null
                  : Number(tripGuard.pickup_longitude),
                candidateDropoffLat: tripGuard?.dropoff_latitude == null
                  ? null
                  : Number(tripGuard.dropoff_latitude),
                candidateDropoffLng: tripGuard?.dropoff_longitude == null
                  ? null
                  : Number(tripGuard.dropoff_longitude),
              })
              : Promise.resolve({ allowed: true as const }),
            assertScheduledJourneyComplianceForDriverTrip(supabase, {
              driverId: driver_id,
              tripId: trip_id!,
            }),
            checkScheduledCommissionWalletGate(supabase, driver_id, trip_id!),
          ]);
          markAcceptStage("pre_rpc_gates_parallel_ms", gatesAt);
          if (!gate.allowed) {
            return errorResponse(
              "SCHEDULED_COMMITMENT_INFEASIBLE",
              "This booking conflicts with another confirmed scheduled ride.",
              409,
            );
          }
          if (!journey.allowed) {
            const code = journey.code === "ACCOUNT_INELIGIBLE"
              ? "ACCOUNT_INELIGIBLE"
              : journey.code === "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END"
              ? "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END"
              : "DOCUMENTS_NOT_APPROVED";
            return errorResponse(
              code,
              journey.message ||
                "One or more of your documents has expired or is not approved. Renew them before accepting scheduled rides.",
              403,
            );
          }
          if (!walletGate.ok) {
            if (walletGate.reason === "wallet_gate_error") {
              console.error(
                "[scheduled-ride-action] wallet gate RPC error:",
                walletGate.detail,
              );
              return errorResponse(
                "DATABASE_ERROR",
                "Could not verify commission wallet eligibility",
                500,
              );
            }
            return errorResponse(
              SCHEDULED_COMMISSION_WALLET_ERROR,
              SCHEDULED_COMMISSION_WALLET_MESSAGE,
              409,
            );
          }
        } else {
          // Legacy sequential gates (B3 OFF).
          {
            const stageAt2 = Date.now();
            const { data: cand } = await supabase
              .from("trips")
              .select(
                "id, scheduled_at, estimated_duration_minutes, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude",
              )
              .eq("id", trip_id)
              .maybeSingle();
            const candAt = Date.parse(String(cand?.scheduled_at ?? ""));
            if (Number.isFinite(candAt)) {
              const gate = await driverMayTakeAdditionalScheduledBooking({
                supabase,
                driverId: driver_id,
                nowMs: Date.now(),
                candidateTripId: trip_id,
                candidateScheduledAtMs: candAt,
                candidateDurationMinutes: Number(cand?.estimated_duration_minutes) || 30,
                candidatePickupLat: cand?.pickup_latitude == null
                  ? null
                  : Number(cand.pickup_latitude),
                candidatePickupLng: cand?.pickup_longitude == null
                  ? null
                  : Number(cand.pickup_longitude),
                candidateDropoffLat: cand?.dropoff_latitude == null
                  ? null
                  : Number(cand.dropoff_latitude),
                candidateDropoffLng: cand?.dropoff_longitude == null
                  ? null
                  : Number(cand.dropoff_longitude),
              });
              if (!gate.allowed) {
                return errorResponse(
                  "SCHEDULED_COMMITMENT_INFEASIBLE",
                  "This booking conflicts with another confirmed scheduled ride.",
                  409,
                );
              }
            }
            markAcceptStage("commitment_gate_ms", stageAt2);
          }

          {
            const stageAt2 = Date.now();
            const journey = await assertScheduledJourneyComplianceForDriverTrip(supabase, {
              driverId: driver_id,
              tripId: trip_id!,
            });
            if (!journey.allowed) {
              const code = journey.code === "ACCOUNT_INELIGIBLE"
                ? "ACCOUNT_INELIGIBLE"
                : journey.code === "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END"
                ? "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END"
                : "DOCUMENTS_NOT_APPROVED";
              return errorResponse(
                code,
                journey.message ||
                  "One or more of your documents has expired or is not approved. Renew them before accepting scheduled rides.",
                403,
              );
            }
            markAcceptStage("journey_compliance_ms", stageAt2);
          }

          {
            const stageAt2 = Date.now();
            const walletGate = await checkScheduledCommissionWalletGate(
              supabase,
              driver_id,
              trip_id!,
            );
            if (!walletGate.ok) {
              if (walletGate.reason === "wallet_gate_error") {
                console.error(
                  "[scheduled-ride-action] wallet gate RPC error:",
                  walletGate.detail,
                );
                return errorResponse(
                  "DATABASE_ERROR",
                  "Could not verify commission wallet eligibility",
                  500,
                );
              }
              return errorResponse(
                SCHEDULED_COMMISSION_WALLET_ERROR,
                SCHEDULED_COMMISSION_WALLET_MESSAGE,
                409,
              );
            }
            markAcceptStage("wallet_gate_ms", stageAt2);
          }
        }
      }

      // Invoke as the authenticated driver so SECURITY DEFINER auth.uid() /
      // check_driver_documents_approved inside the RPC cannot be skipped.
      // Service-role client remains for HELD guards + post-accept normalize.
      const authHeader = req.headers.get("Authorization") ?? "";
      const driverRpc = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const rpcStartedAt = Date.now();
      const { data, error } = await driverRpc.rpc("accept_scheduled_ride", {
        p_trip_id: trip_id,
        p_driver_id: driver_id,
      });
      markAcceptStage("accept_rpc_ms", rpcStartedAt);

      if (error) {
        console.error("[scheduled-ride-action] RPC error:", error);
        return errorResponse("DATABASE_ERROR", error.message, 500);
      }

      console.log("[scheduled-ride-action] Accept result:", data);

      if (!data.success) {
        const statusCode = data.error === "TRIP_NOT_FOUND" ? 404 :
                          data.error === "TRIP_ALREADY_TAKEN" ? 409 :
                          data.error === "DRIVER_EXCLUDED" ? 403 :
                          data.error === "DOCUMENTS_NOT_APPROVED" ? 403 :
                          data.error === "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END" ? 403 :
                          data.error === "ACCOUNT_INELIGIBLE" ? 403 :
                          data.error === "INSUFFICIENT_COMMISSION_WALLET_BALANCE" ? 409 :
                          data.error === "SCHEDULED_COMMITMENT_INFEASIBLE" ? 409 :
                          data.error === "LOCK_CONTENTION" ? 409 : 400;

        return new Response(
          JSON.stringify(data),
          { status: statusCode, headers: jsonHeaders }
        );
      }

      // Hard Rule #4 / preconfirm: never leave live driver_id after marketplace Accept.
      // Activation NRO Accept (scheduled-checkin) is the only path that stamps driver_id.
      {
        const stageAt = Date.now();
        const nowIso = new Date().toISOString();
        const { error: preconfirmErr } = await supabase
          .from("trips")
          .update({
            driver_id: null,
            confirmed_driver_id: driver_id,
            scheduled_status: "driver_assigned",
            // Keep list-only trip status — do not flip into live searching/en_route.
            status: "scheduled",
            updated_at: nowIso,
          })
          .eq("id", trip_id)
          .or(`confirmed_driver_id.eq.${driver_id},confirmed_driver_id.is.null`);
        if (preconfirmErr) {
          console.warn("[scheduled-ride-action] accept preconfirm normalize soft-fail:", preconfirmErr);
        }
        markAcceptStage("preconfirm_ms", stageAt);
      }

      acceptStagesMs.authoritative_commit_ms = Math.max(
        0,
        Date.now() - acceptStartedAt,
      );

      console.log("SCHEDULED_JOB_ACCEPTED", {
        trip_id,
        driver_id,
        scheduled_status: "driver_assigned",
      });
      console.log("SCHEDULED_DRIVER_CONFIRMED", {
        trip_id,
        confirmed_driver_id: driver_id,
      });

      // Bug #27: return after authoritative accept + preconfirm. Notify /
      // marketplace broadcast via waitUntil so Accept→Confirmed stays <2s.
      scheduleEdgeBackground(async () => {
        const { data: tripRow } = await supabase
          .from("trips")
          .select("passenger_id, scheduled_at, pickup_address, trip_number, service_area_id")
          .eq("id", trip_id)
          .single();
        const { data: driverRow } = await supabase
          .from("drivers")
          .select("first_name, last_name")
          .eq("id", driver_id)
          .single();

        try {
          await broadcastScheduledMarketplaceChanged(supabase, {
            tripId: trip_id,
            serviceAreaId: tripRow?.service_area_id ?? null,
            reason: "accepted",
          });
        } catch (broadcastErr) {
          console.warn(
            "[scheduled-ride-action] accept marketplace broadcast failed:",
            broadcastErr,
          );
        }

        try {
          if (tripRow?.passenger_id) {
            const driverName = driverRow
              ? `${driverRow.first_name ?? "Your driver"}`.trim()
              : "Your driver";
            await notifyCustomerTripLifecycle(supabase, {
              passengerId: tripRow.passenger_id,
              tripId: trip_id,
              event: "driver_assigned",
              title: "Driver confirmed",
              body: `${driverName} will pick you up for your scheduled ride.`,
              notificationId: `driver_assigned-${trip_id}-scheduled_accept`,
              path: "/account/rides",
            });
          }
        } catch (notifErr) {
          console.warn("[scheduled-ride-action] accept: customer notification failed:", notifErr);
        }

        try {
          const pickupLabel = tripRow?.pickup_address ?? "your pickup location";
          const pickupDate = tripRow?.scheduled_at
            ? new Date(tripRow.scheduled_at).toLocaleString("en-GB", {
                weekday: "short", day: "numeric", month: "short",
                hour: "2-digit", minute: "2-digit",
              })
            : "your scheduled time";
          await supabase.functions.invoke("send-driver-notification", {
            body: {
              driverId: driver_id,
              type: "SCHEDULED_JOB_CONFIRMED",
              title: "Scheduled job reserved",
              body: `Job saved to your Confirmed tab. Pickup: ${pickupLabel} at ${pickupDate}.`,
              data: {
                trip_id,
                type: "scheduled_job_confirmed",
                pickup_address: pickupLabel,
                scheduled_at: tripRow?.scheduled_at ?? "",
              },
            },
          });
        } catch (notifErr) {
          console.warn("[scheduled-ride-action] accept: driver notification failed:", notifErr);
        }
      }, "scheduled_accept_post_commit");

      return successResponse({
        ...(data && typeof data === "object" ? data : { success: true }),
        post_commit: "background",
        stages_ms: acceptStagesMs,
      });
    }

    // ============================================================
    // ACTION: DECLINE SCHEDULED RIDE
    // ============================================================
    if (action === "decline") {
      const { data, error } = await supabase.rpc("decline_scheduled_ride", {
        p_trip_id: trip_id,
        p_driver_id: driver_id,
      });

      if (error) {
        console.error("[scheduled-ride-action] Decline RPC error:", error);
        return errorResponse("DATABASE_ERROR", error.message, 500);
      }

      console.log("[scheduled-ride-action] Decline result:", data);

      return successResponse(data);
    }

    // ============================================================
    // ACTION: TIMEOUT SCHEDULED OFFER
    // ============================================================
    if (action === "timeout") {
      const { data, error } = await supabase.rpc("timeout_scheduled_offer", {
        p_trip_id: trip_id,
        p_driver_id: driver_id,
      });

      if (error) {
        console.error("[scheduled-ride-action] Timeout RPC error:", error);
        return errorResponse("DATABASE_ERROR", error.message, 500);
      }

      return successResponse(data);
    }

    // ============================================================
    // ACTION: CHECK ELIGIBILITY
    // ============================================================
    if (action === "check_eligibility") {
      // Check if driver previously declined/timed out
      const { data: attempts } = await supabase
        .from("scheduled_offer_attempts")
        .select("status")
        .eq("trip_id", trip_id)
        .eq("driver_id", driver_id)
        .in("status", ["declined", "timeout", "cancelled"]);

      const isExcluded = (attempts?.length || 0) > 0;

      // Check if trip is still available
      const { data: trip } = await supabase
        .from("trips")
        .select("id, driver_id, scheduled_status, scheduled_broadcast_at, scheduled_at, estimated_duration_minutes")
        .eq("id", trip_id)
        .single();

      const sched = String(trip?.scheduled_status ?? "").toLowerCase();
      const broadcastRaw = trip?.scheduled_broadcast_at;
      const broadcastMs = broadcastRaw ? Date.parse(String(broadcastRaw)) : NaN;
      const broadcastDue =
        Boolean(broadcastRaw) &&
        Number.isFinite(broadcastMs) &&
        broadcastMs <= Date.now();
      const isAvailable = Boolean(
        trip &&
          !trip.driver_id &&
          sched !== "admin_held" &&
          ["broadcasting", "scheduled", "pending"].includes(sched) &&
          broadcastDue,
      );

      let complianceOk = true;
      let complianceReason: string | null = null;
      if (!isExcluded && isAvailable && trip_id) {
        const journey = await assertScheduledJourneyComplianceForDriverTrip(supabase, {
          driverId: driver_id,
          tripId: trip_id,
          scheduledAtIso: trip?.scheduled_at != null ? String(trip.scheduled_at) : null,
          estimatedDurationMinutes: trip?.estimated_duration_minutes != null
            ? Number(trip.estimated_duration_minutes)
            : null,
        });
        complianceOk = journey.allowed;
        if (!journey.allowed) {
          complianceReason =
            journey.message ||
            "Your account or required documents do not meet eligibility for this scheduled journey.";
        }
      }

      return successResponse({ 
        success: true, 
        eligible: !isExcluded && isAvailable && complianceOk,
        isExcluded,
        isAvailable,
        reason: isExcluded ? "You previously declined this ride" : 
                !isAvailable ? "This ride is no longer available" :
                !complianceOk ? complianceReason : null
      });
    }

    // ============================================================
    // ACTION: CANCEL CONFIRMED SCHEDULED RIDE (DRIVER)
    // ============================================================
    if (action === "cancel_confirmed") {
      const cancelStartedAt = Date.now();
      const cancelStagesMs: Record<string, number> = {};
      const markCancelStage = (key: string, startedAt: number) => {
        cancelStagesMs[key] = Math.max(0, Date.now() - startedAt);
      };

      if (!cancellation_reason) {
        return validationErrorResponse({ cancellation_reason: "cancellation_reason is required" });
      }

      // Validate trip is confirmed, locked, and assigned to this driver
      const validateAt = Date.now();
      const { data: trip, error: tripError } = await supabase
        .from("trips")
        .select("id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled, scheduled_at, scheduled_broadcast_at, service_area_id")
        .eq("id", trip_id)
        .single();

      if (tripError || !trip) {
        return errorResponse("NOT_FOUND", "Trip not found", 404);
      }

      // Validation checks
      if (!trip.is_scheduled) {
        return errorResponse("INVALID_STATE", "Trip is not a scheduled job", 400);
      }
      if (trip.driver_id !== driver_id && trip.confirmed_driver_id !== driver_id) {
        return errorResponse("FORBIDDEN", "You are not assigned to this job", 403);
      }
      if (["cancelled", "completed"].includes(trip.status || "")) {
        return errorResponse("INVALID_STATE", "Trip is already " + trip.status, 400);
      }
      if (["in_progress", "en_route_to_pickup", "arrived"].includes(trip.status || "")) {
        return errorResponse("INVALID_STATE", "Cannot cancel after ride has started. Use normal trip cancellation.", 400);
      }
      markCancelStage("validate_trip_ms", validateAt);

      // Bug #22: unclaimed scheduled→instant clock = urgentTrigger (NOT check-in).
      const cfgAt = Date.now();
      const { data: globalCfgForCancel } = await supabase
        .from("global_dispatch_settings")
        .select(
          "max_driver_find_time_minutes, max_dispatch_rounds, urgent_dispatch_trigger_minutes_before_pickup",
        )
        .eq("singleton", true)
        .maybeSingle();
      const cancelDispatchCfg = resolveScheduledDispatchConfig(
        globalCfgForCancel ?? {},
      );
      markCancelStage("dispatch_cfg_ms", cfgAt);
      const nowMs = Date.now();
      const scheduledAt = new Date(trip.scheduled_at).getTime();
      const minutesToPickup = (scheduledAt - nowMs) / 60_000;
      const isUrgentConvert = shouldUrgentConvertOnPreActivationRelease({
        scheduledAtIso: String(trip.scheduled_at),
        nowMs,
        urgentTriggerMinutesBeforePickup:
          cancelDispatchCfg.urgentTriggerMinutesBeforePickup,
      });

      const wasCommitted =
        trip.scheduled_status === "scheduled_committed" ||
        trip.scheduled_status === "awaiting_activation_accept" ||
        trip.scheduled_status === "driver_assigned";

      const releaseNowIso = new Date().toISOString();
      const broadcastAt =
        trip.scheduled_broadcast_at && String(trip.scheduled_broadcast_at).trim()
          ? trip.scheduled_broadcast_at
          : releaseNowIso;

      const { data: rematchGateTrip } = await supabase
        .from("trips")
        .select("broadcast_enabled, airport_charge_pence, scheduled_hold_reason")
        .eq("id", trip_id)
        .maybeSingle();
      const rematchBroadcastEnabled =
        rematchGateTrip?.broadcast_enabled !== false;

      // Authoritative SQL CAS (FOR UPDATE) — same class as compliance release.
      // JIT activate / Phase-5 arm / replacement confirm / compliance cannot
      // race-overwrite this cancel; ACTIVATED_PROTECTED → activated cancel path.
      let casReleased = false;
      let casUrgent = false;
      let casViaSql = false;
      const casStartedAt = Date.now();
      {
        const { data: casRow, error: casErr } = await supabase.rpc(
          "release_scheduled_assignment_for_driver_cancel",
          {
            p_trip_id: trip_id,
            p_expected_driver_id: driver_id,
            p_reason: cancellation_reason,
            p_note: cancellation_note || null,
            p_urgent: Boolean(isUrgentConvert && rematchBroadcastEnabled),
          },
        );
        if (!casErr && casRow && typeof casRow === "object") {
          casViaSql = true;
          const row = casRow as Record<string, unknown>;
          if (row.error === "ACTIVATED_PROTECTED") {
            return errorResponse(
              "ACTIVATED",
              "This journey has already started. Use trip cancellation instead.",
              409,
            );
          }
          if (row.error === "DRIVER_MISMATCH") {
            return errorResponse(
              "CONFLICT",
              "Trip assignment changed — refresh and try again",
              409,
            );
          }
          if (row.success === true && (row.released === true || row.idempotent === true)) {
            casReleased = Boolean(row.released === true || row.idempotent === true);
            casUrgent = Boolean(row.urgent ?? (isUrgentConvert && rematchBroadcastEnabled));
          } else if (row.error === "CAS_MISMATCH") {
            return errorResponse(
              "CONFLICT",
              "Trip assignment or status changed — refresh and try again",
              409,
            );
          } else if (row.error && row.error !== "ALREADY_RELEASED") {
            return errorResponse("INVALID_STATE", String(row.error), 400);
          }
        } else if (casErr) {
          console.warn(
            "[scheduled-ride-action] cancel_confirmed: SQL CAS RPC unavailable, Edge CAS fallback",
            casErr.message,
          );
        }
      }

      if (!casViaSql) {
        // Edge CAS fallback (identical predicates) when SQL RPC not yet migrated.
        // Order matches SQL: CAS update first, then decline — never decline an
        // activated trip when JIT/activate won the race (Bug #22 hardening).
        let rematchPatch: Record<string, unknown>;
        if (isUrgentConvert && rematchBroadcastEnabled) {
          const maxFindDriverMinutes = cancelDispatchCfg.maxFindDriverMinutes;
          const instantMaxSequences = maxBroadcastSequences(
            { max_dispatch_rounds: globalCfgForCancel?.max_dispatch_rounds },
            null,
          );
          const { data: priorConvertOffers } = await supabase
            .from("ride_offers")
            .select("broadcast_round")
            .eq("trip_id", trip_id)
            .order("broadcast_round", { ascending: false })
            .limit(1);
          const maxExistingBroadcastRound = Number(
            priorConvertOffers?.[0]?.broadcast_round ?? 0,
          );
          rematchPatch = {
            ...buildScheduledUrgentRematchPatch({
              nowIso: releaseNowIso,
              searchingExpiresAtIso: new Date(
                nowMs + maxFindDriverMinutes * 60_000,
              ).toISOString(),
              maxExistingBroadcastRound: Number.isFinite(maxExistingBroadcastRound)
                ? maxExistingBroadcastRound
                : 0,
              maxBroadcastSequences: instantMaxSequences,
              currentBroadcastEnabled: rematchBroadcastEnabled,
            }),
            cancellation_reason: cancellation_reason,
            cancellation_note: cancellation_note || null,
          };
        } else if (isUrgentConvert && !rematchBroadcastEnabled) {
          rematchPatch = buildScheduledMarketplaceRematchPatch({
            nowIso: releaseNowIso,
            broadcastAtIso: broadcastAt,
            broadcastEnabled: false,
            cancellationReason: cancellation_reason,
            cancellationNote: cancellation_note || null,
          });
        } else {
          rematchPatch = buildScheduledMarketplaceRematchPatch({
            nowIso: releaseNowIso,
            broadcastAtIso: broadcastAt,
            broadcastEnabled: rematchBroadcastEnabled,
            cancellationReason: cancellation_reason,
            cancellationNote: cancellation_note || null,
          });
        }

        const { data: casUpdated, error: updateError } = await supabase
          .from("trips")
          .update(rematchPatch)
          .eq("id", trip_id)
          .eq("confirmed_driver_id", driver_id)
          .is("driver_id", null)
          .is("started_at", null)
          .select("id")
          .maybeSingle();

        if (updateError) {
          console.error("[scheduled-ride-action] Cancel confirmed error:", updateError);
          return errorResponse("DATABASE_ERROR", updateError.message, 500);
        }
        if (!casUpdated) {
          const { data: after } = await supabase
            .from("trips")
            .select("id, driver_id, confirmed_driver_id, status, scheduled_status, started_at")
            .eq("id", trip_id)
            .maybeSingle();
          const afterStatus = String(after?.status ?? "").toLowerCase();
          const afterSched = String(after?.scheduled_status ?? "").toLowerCase();
          if (
            after?.started_at ||
            after?.driver_id ||
            ["in_progress", "en_route_to_pickup", "arrived", "arrived_at_pickup"].includes(afterStatus) ||
            afterSched === "driver_en_route" ||
            afterSched === "converted_to_instant"
          ) {
            return errorResponse(
              "ACTIVATED",
              "This journey has already started. Use trip cancellation instead.",
              409,
            );
          }
          return errorResponse(
            "CONFLICT",
            "Trip assignment or status changed — refresh and try again",
            409,
          );
        }

        // CAS won — exclude cancelling driver from reconfirming (same as SQL path).
        await supabase.rpc("decline_scheduled_ride", {
          p_trip_id: trip_id,
          p_driver_id: driver_id,
        });

        casReleased = true;
        casUrgent = Boolean(isUrgentConvert && rematchBroadcastEnabled);

        await supabase
          .from("ride_offers")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("trip_id", trip_id)
          .eq("driver_id", driver_id)
          .in("status", ["pending", "offered", "countered"]);

        await supabase.rpc("log_audit_event", {
          p_event_type: "scheduled_job_driver_cancelled",
          p_driver_id: driver_id,
          p_trip_id: trip_id,
          p_details: JSON.stringify({
            reason: cancellation_reason,
            note: cancellation_note || null,
            urgent_convert: casUrgent,
            urgent_trigger_minutes:
              cancelDispatchCfg.urgentTriggerMinutesBeforePickup,
            checkin_window_minutes: checkInWindowMinutes,
            cas: "edge_fallback",
          }),
        });
      }

      if (!casReleased && casViaSql) {
        // SQL idempotent already-released — still continue notify/marketplace kick.
        casReleased = true;
      }

      markCancelStage("cas_release_ms", casStartedAt);
      cancelStagesMs.authoritative_commit_ms = Math.max(
        0,
        Date.now() - cancelStartedAt,
      );

      const convertedToInstant = Boolean(casUrgent);

      console.log(`[scheduled-ride-action] Driver ${driver_id} cancelled confirmed job ${trip_id}. Reason: ${cancellation_reason}`);

      // Bug #27: CAS release + exclusion already durable. Kick dispatch /
      // notify / marketplace via waitUntil so cancel UI is not blocked.
      // Cron/sweep recover if background work is interrupted.
      const serviceAreaIdForBroadcast = trip.service_area_id ?? null;
      scheduleEdgeBackground(async () => {
        if (wasCommitted && minutesToPickup <= 15) {
          try {
            await supabase.functions.invoke("send-admin-notification", {
              body: {
                type: "SCHEDULED_COMMITTED_DRIVER_CANCELLED_CRITICAL",
                title: "🚨 Committed driver cancelled — urgent",
                body: `Driver cancelled a committed scheduled job with ${Math.round(minutesToPickup)} min to pickup. Trip ${trip_id}. Immediate rebroadcast triggered.`,
                data: {
                  trip_id,
                  driver_id,
                  minutes_to_pickup: String(Math.round(minutesToPickup)),
                },
              },
            });
          } catch (adminErr) {
            console.warn("[scheduled-ride-action] cancel_confirmed: admin alert failed:", adminErr);
          }
        }

        if (convertedToInstant) {
          try {
            await fetch(`${supabaseUrl}/functions/v1/auto-dispatch`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${supabaseKey}`,
              },
              body: JSON.stringify({ trip_id, force_rebroadcast: true }),
            });
          } catch (e) {
            console.error("[scheduled-ride-action] auto-dispatch trigger failed:", e);
          }
          console.log(
            "[scheduled-ride-action] Urgent window: converted to instant ride, auto-dispatch triggered",
          );
        } else if (rematchBroadcastEnabled) {
          try {
            await fetch(`${supabaseUrl}/functions/v1/scheduled-dispatch`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${supabaseKey}`,
              },
              body: JSON.stringify({}),
            });
          } catch (e) {
            console.error("[scheduled-ride-action] pre-window scheduled-dispatch kick failed:", e);
          }
        }

        try {
          const { data: tripForNotif } = await supabase
            .from("trips")
            .select("passenger_id, scheduled_at")
            .eq("id", trip_id)
            .single();
          if (tripForNotif?.passenger_id) {
            const customerMsg = convertedToInstant
              ? "We're finding you a replacement driver right now."
              : "We're looking for another driver for your scheduled trip.";
            await notifyCustomerTripLifecycle(supabase, {
              passengerId: tripForNotif.passenger_id,
              tripId: trip_id,
              event: "driver_cancelled",
              title: "Driver cancelled",
              body: customerMsg,
              notificationId: `driver_cancelled-scheduled-${trip_id}`,
              path: convertedToInstant ? "/booking/finding-drivers" : "/account/rides",
            });
          }
        } catch (notifErr) {
          console.warn("[scheduled-ride-action] cancel_confirmed: customer notification failed:", notifErr);
        }

        try {
          await broadcastScheduledMarketplaceChanged(supabase, {
            tripId: trip_id,
            serviceAreaId: serviceAreaIdForBroadcast,
            reason: convertedToInstant ? "converted" : "cancelled",
          });
        } catch (broadcastErr) {
          console.warn(
            "[scheduled-ride-action] cancel marketplace broadcast failed:",
            broadcastErr,
          );
        }
      }, "scheduled_cancel_post_cas");

      return successResponse({
        success: true,
        trip_id: trip_id,
        message: "Scheduled job cancelled successfully",
        converted_to_instant: convertedToInstant,
        cas: casViaSql ? "sql" : "edge_fallback",
        post_commit: "background",
        stages_ms: cancelStagesMs,
      });
    }

    return errorResponse("INVALID_ACTION", "Invalid action", 400);

  } catch (error) {
    console.error("[scheduled-ride-action] Error:", error);
    return errorResponse("INTERNAL_ERROR", String(error), 500);
  }
});

/**
 * Calculate distance between two points in miles using Haversine formula
 */
function calculateDistanceMiles(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 3959; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
