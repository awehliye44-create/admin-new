import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
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
  buildScheduledUrgentConversionPatch,
  resolveScheduledDispatchConfig,
} from "../_shared/scheduledDispatchConfig.ts";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";

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
    const authHeader = req.headers.get('Authorization');
    let driver_id: string;
    
    if (authHeader) {
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
    } else {
      // No auth header - allow for backwards compatibility but warn
      if (!requestedDriverId) {
        return errorResponse("UNAUTHORIZED", "Authentication required", 401);
      }
      if (!isValidUUID(requestedDriverId)) {
        return errorResponse("BAD_REQUEST", "driver_id must be a valid UUID", 400);
      }
      driver_id = requestedDriverId;
      console.warn("[scheduled-ride-action] SECURITY: Unauthenticated request using driver_id from body - this will be deprecated");
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

      // Attach stops to each trip (multi-stop support)
      const tripsWithStops = filteredTrips.map(trip => ({
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
      // Use the atomic database function
      const { data, error } = await supabase.rpc("accept_scheduled_ride", {
        p_trip_id: trip_id,
        p_driver_id: driver_id,
      });

      if (error) {
        console.error("[scheduled-ride-action] RPC error:", error);
        return errorResponse("DATABASE_ERROR", error.message, 500);
      }

      console.log("[scheduled-ride-action] Accept result:", data);

      if (!data.success) {
        const statusCode = data.error === "TRIP_NOT_FOUND" ? 404 :
                          data.error === "TRIP_ALREADY_TAKEN" ? 409 :
                          data.error === "DRIVER_EXCLUDED" ? 403 :
                          data.error === "LOCK_CONTENTION" ? 409 : 400;

        return new Response(
          JSON.stringify(data),
          { status: statusCode, headers: jsonHeaders }
        );
      }

      console.log("SCHEDULED_JOB_ACCEPTED", {
        trip_id,
        driver_id,
        scheduled_status: "driver_assigned",
      });
      console.log("SCHEDULED_DRIVER_CONFIRMED", {
        trip_id,
        confirmed_driver_id: driver_id,
      });

      // Fetch trip + driver for notifications
      const { data: tripRow } = await supabase
        .from("trips")
        .select("passenger_id, scheduled_at, pickup_address, trip_number")
        .eq("id", trip_id)
        .single();
      const { data: driverRow } = await supabase
        .from("drivers")
        .select("first_name, last_name")
        .eq("id", driver_id)
        .single();

      // §18 — Notify customer: driver confirmed (lifecycle WAV, not mute send-customer-notification).
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
          });
        }
      } catch (notifErr) {
        console.warn("[scheduled-ride-action] accept: customer notification failed:", notifErr);
      }

      // §18 — Notify driver: job reserved / saved to Confirmed tab
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

      return successResponse(data);
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
        .select("id, driver_id, scheduled_status")
        .eq("id", trip_id)
        .single();

      const isAvailable = trip && !trip.driver_id && 
        ["broadcasting", "scheduled"].includes(trip.scheduled_status || "");

      return successResponse({ 
        success: true, 
        eligible: !isExcluded && isAvailable,
        isExcluded,
        isAvailable,
        reason: isExcluded ? "You previously declined this ride" : 
                !isAvailable ? "This ride is no longer available" : null
      });
    }

    // ============================================================
    // ACTION: CANCEL CONFIRMED SCHEDULED RIDE (DRIVER)
    // ============================================================
    if (action === "cancel_confirmed") {
      if (!cancellation_reason) {
        return validationErrorResponse({ cancellation_reason: "cancellation_reason is required" });
      }

      // Validate trip is confirmed, locked, and assigned to this driver
      const { data: trip, error: tripError } = await supabase
        .from("trips")
        .select("id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled, scheduled_at")
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

      // Record the decline (excludes driver from future offers for this trip)
      await supabase.rpc("decline_scheduled_ride", {
        p_trip_id: trip_id,
        p_driver_id: driver_id,
      });

      // Determine if check-in window is open
      const scheduledAt = new Date(trip.scheduled_at).getTime();
      const checkinOpenMs = scheduledAt - checkInWindowMinutes * 60_000;
      const nowMs = Date.now();
      const isCheckinOpen = nowMs >= checkinOpenMs;
      const minutesToPickup = (scheduledAt - nowMs) / 60_000;

      // §11/§12 dispatch_status: before commitment → 'available', after → 'urgent_rebroadcast'
      const wasCommitted = trip.scheduled_status === "scheduled_committed";
      const cancelDispatchStatus = wasCommitted ? "urgent_rebroadcast" : "available";

      // Update trip: unlock, remove driver, save cancellation details
      const { error: updateError } = await supabase
        .from("trips")
        .update({
          driver_id: null,
          confirmed_driver_id: null,
          cancelled_by: "driver",
          cancellation_reason: cancellation_reason,
          cancellation_note: cancellation_note || null,
          cancelled_at: new Date().toISOString(),
          scheduled_status: "broadcasting",
          status: isCheckinOpen ? "pending" : "offered",
          dispatch_status: cancelDispatchStatus,  // §11/§12 SSOT
          // Reset commitment columns if present
          scheduled_driver_risk: false,
          current_offer_driver_id: null,
          current_offer_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", trip_id);

      if (updateError) {
        console.error("[scheduled-ride-action] Cancel confirmed error:", updateError);
        return errorResponse("DATABASE_ERROR", updateError.message, 500);
      }

      // Log audit event
      await supabase.rpc("log_audit_event", {
        p_event_type: "scheduled_job_driver_cancelled",
        p_driver_id: driver_id,
        p_trip_id: trip_id,
        p_details: JSON.stringify({
          reason: cancellation_reason,
          note: cancellation_note || null,
          checkin_was_open: isCheckinOpen,
        }),
      });

      // §12 — Admin alert when committed driver cancels close to pickup
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

      // If check-in window is open, convert to instant and trigger auto-dispatch immediately
      if (isCheckinOpen) {
        const { data: globalCfg } = await supabase
          .from("global_dispatch_settings")
          .select("max_driver_find_time_minutes")
          .eq("singleton", true)
          .maybeSingle();
        const maxFindDriverMinutes = resolveScheduledDispatchConfig(globalCfg ?? {}).maxFindDriverMinutes;
        const convertNow = new Date();
        await supabase
          .from("trips")
          .update(buildScheduledUrgentConversionPatch({
            nowIso: convertNow.toISOString(),
            searchingExpiresAtIso: new Date(
              convertNow.getTime() + maxFindDriverMinutes * 60_000,
            ).toISOString(),
          }))
          .eq("id", trip_id);

        // Trigger auto-dispatch immediately — don't wait for expire-offers sweep
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

        console.log("[scheduled-ride-action] Check-in open: converted to instant ride, auto-dispatch triggered");
      }

      console.log(`[scheduled-ride-action] Driver ${driver_id} cancelled confirmed job ${trip_id}. Reason: ${cancellation_reason}`);

      // Notify customer: their confirmed driver has cancelled (lifecycle WAV, not trip_cancelled).
      try {
        const { data: tripForNotif } = await supabase
          .from("trips")
          .select("passenger_id, scheduled_at")
          .eq("id", trip_id)
          .single();
        if (tripForNotif?.passenger_id) {
          const customerMsg = isCheckinOpen
            ? "We're finding you a replacement driver right now."
            : "We're looking for another driver for your scheduled trip.";
          await notifyCustomerTripLifecycle(supabase, {
            passengerId: tripForNotif.passenger_id,
            tripId: trip_id,
            event: "driver_cancelled",
            title: "Driver cancelled",
            body: customerMsg,
            notificationId: `driver_cancelled-scheduled-${trip_id}`,
          });
        }
      } catch (notifErr) {
        console.warn("[scheduled-ride-action] cancel_confirmed: customer notification failed:", notifErr);
      }

      return successResponse({
        success: true,
        trip_id: trip_id,
        message: "Scheduled job cancelled successfully",
        converted_to_instant: isCheckinOpen,
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
