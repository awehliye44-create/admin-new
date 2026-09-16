import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";

/**
 * APPLY-TRIP-CHANGE
 * 
 * When a driver approves (or auto-applies) a trip change request:
 * 1. Validates the change request
 * 2. Applies route/stop/dropoff modifications to the trip
 * 3. Recalculates fare based on new route using vehicle_pricing
 * 4. Updates the trip row with new fare + route data
 * 5. Marks the change request as applied
 * 
 * The trips row update triggers realtime → both driver and customer apps
 * receive the updated fare immediately via their existing subscriptions.
 */

const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60000, keyPrefix: 'apply-trip-change' };

// Haversine distance in km
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Calculate total route distance through all waypoints
function calculateRouteDistanceKm(waypoints: { lat: number; lng: number }[]): number {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const straight = haversineKm(
      waypoints[i - 1].lat, waypoints[i - 1].lng,
      waypoints[i].lat, waypoints[i].lng
    );
    total += straight * 1.3; // Road factor
  }
  return total;
}

Deno.serve(async (req) => {
  console.log("[apply-trip-change] Request:", req.method);

  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Please sign in again.", 401);
    }

    const anon = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) {
      return errorResponse("INVALID_SESSION", "Please sign in again.", 401);
    }

    const body = await req.json();
    const { change_request_id, driver_id: requested_driver_id, action } = body;

    // Validate
    const errors: Record<string, string> = {};
    if (!change_request_id) errors.change_request_id = "required";
    else if (!isValidUUID(change_request_id)) errors.change_request_id = "invalid UUID";
    if (requested_driver_id && !isValidUUID(requested_driver_id)) errors.driver_id = "invalid UUID";
    if (!action || !['approve', 'reject'].includes(action)) errors.action = "must be 'approve' or 'reject'";
    if (Object.keys(errors).length > 0) return validationErrorResponse(errors);

    const { data: driverProfile, error: driverErr } = await supabase
      .from("drivers")
      .select("id")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (driverErr || !driverProfile?.id) {
      return errorResponse("DRIVER_PROFILE_REQUIRED", "Driver profile not found.", 403);
    }

    const driver_id = driverProfile.id;
    if (requested_driver_id && requested_driver_id !== driver_id) {
      return errorResponse("FORBIDDEN", "Not authorized for this driver.", 403);
    }

    const now = new Date().toISOString();

    const { data: cr, error: crErr } = await supabase
      .from("trip_change_requests")
      .select("*")
      .eq("id", change_request_id)
      .single();

    if (crErr || !cr) {
      console.error("[apply-trip-change] Change request not found:", crErr);
      return errorResponse("NOT_FOUND", "Change request not found", 404);
    }

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("*")
      .eq("id", cr.trip_id)
      .single();

    if (tripErr || !trip) {
      console.error("[apply-trip-change] Trip not found:", tripErr);
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    const assignedDriverId = trip.confirmed_driver_id ?? trip.driver_id;
    if (!assignedDriverId || assignedDriverId !== driver_id) {
      return errorResponse("FORBIDDEN", "Not authorized for this trip", 403);
    }

    // ── REJECT path ──
    if (action === 'reject') {
      const { error: rejectErr } = await supabase
        .from("trip_change_requests")
        .update({
          status: "rejected",
          responded_at: now,
          response_by: driver_id,
          rejection_reason: "Driver declined",
        })
        .eq("id", change_request_id);

      if (rejectErr) {
        console.error("[apply-trip-change] Reject error:", rejectErr);
        return errorResponse("UPDATE_FAILED", "Failed to reject", 500);
      }
      return successResponse({ success: true, action: "rejected" });
    }

    // ── APPROVE path ──

    if (cr.status !== "pending_driver_approval") {
      // Idempotent: if already approved/applied (e.g. auto-applied by DB trigger), return success
      if (cr.status === "approved" || cr.status === "applied") {
        console.log("[apply-trip-change] Already applied (idempotent), returning success");
        return successResponse({ success: true, action: "approved", idempotent: true, trip_id: cr.trip_id });
      }
      return errorResponse("ALREADY_PROCESSED", `Change request is ${cr.status}`, 409);
    }

    if (Number(cr.fare_delta_pence ?? 0) > 0 && cr.payment_status !== "confirmed") {
      return errorResponse(
        "PAYMENT_REQUIRED",
        "Payment confirmation required before apply",
        402,
      );
    }

    // 3. Fetch current stops
    const { data: currentStops } = await supabase
      .from("trip_stops")
      .select("*")
      .eq("trip_id", trip.id)
      .order("stop_index", { ascending: true });

    // 4. Apply modifications based on change_type
    const afterSnapshot = cr.after_route_snapshot || {};
    let newDropoffAddress = trip.dropoff_address;
    let newDropoffLat = trip.dropoff_latitude;
    let newDropoffLng = trip.dropoff_longitude;
    let stopsModified = false;

    if (cr.change_type === "change_dropoff" && afterSnapshot.dropoff) {
      newDropoffAddress = afterSnapshot.dropoff.address || trip.dropoff_address;
      newDropoffLat = afterSnapshot.dropoff.lat ?? trip.dropoff_latitude;
      newDropoffLng = afterSnapshot.dropoff.lng ?? trip.dropoff_longitude;
      
      // Update dropoff stop in trip_stops
      if (currentStops) {
        const dropoffStop = currentStops.find(s => s.type === 'dropoff');
        if (dropoffStop) {
          await supabase
            .from("trip_stops")
            .update({
              address: newDropoffAddress,
              lat: newDropoffLat,
              lng: newDropoffLng,
              updated_at: now,
            })
            .eq("id", dropoffStop.id);
        }
      }
      stopsModified = true;
    }

    if (cr.change_type === "add_stop" && afterSnapshot.stops) {
      // Insert new intermediate stops from the snapshot
      const newStops = afterSnapshot.stops.filter((s: any) => s.type === 'stop');
      
      if (newStops.length > 0 && currentStops) {
        // Find current max stop_index before dropoff
        const dropoffStop = currentStops.find(s => s.type === 'dropoff');
        const dropoffIndex = dropoffStop?.stop_index ?? currentStops.length;
        
        // Insert new stops before the dropoff
        for (let i = 0; i < newStops.length; i++) {
          const ns = newStops[i];
          // Shift dropoff index up
          const newIndex = dropoffIndex + i;
          
          await supabase
            .from("trip_stops")
            .insert({
              trip_id: trip.id,
              stop_index: newIndex,
              type: 'stop',
              address: ns.address || 'New Stop',
              lat: ns.lat || 0,
              lng: ns.lng || 0,
              status: 'pending',
            });
        }

        // Update dropoff stop_index
        if (dropoffStop) {
          const newDropoffIdx = dropoffIndex + newStops.length;
          await supabase
            .from("trip_stops")
            .update({ stop_index: newDropoffIdx, updated_at: now })
            .eq("id", dropoffStop.id);
        }

        // Update total_stops on trip
        const newTotal = (trip.total_stops || currentStops.length) + newStops.length;
        await supabase
          .from("trips")
          .update({ total_stops: newTotal })
          .eq("id", trip.id);
      }

      // If dropoff also changed
      if (afterSnapshot.dropoff) {
        const beforeDropoff = cr.before_route_snapshot?.dropoff?.address;
        if (beforeDropoff !== afterSnapshot.dropoff.address) {
          newDropoffAddress = afterSnapshot.dropoff.address;
          newDropoffLat = afterSnapshot.dropoff.lat ?? newDropoffLat;
          newDropoffLng = afterSnapshot.dropoff.lng ?? newDropoffLng;

          if (currentStops) {
            const dropoffStop = currentStops.find(s => s.type === 'dropoff');
            if (dropoffStop) {
              await supabase
                .from("trip_stops")
                .update({
                  address: newDropoffAddress,
                  lat: newDropoffLat,
                  lng: newDropoffLng,
                  updated_at: now,
                })
                .eq("id", dropoffStop.id);
            }
          }
        }
      }
      stopsModified = true;
    }

    if (cr.change_type === "remove_stop" && afterSnapshot.stops) {
      // Remove stops that are no longer in the after snapshot
      if (currentStops) {
        const afterStopAddresses = new Set(
          (afterSnapshot.stops || []).map((s: any) => s.address)
        );
        
        const stopsToRemove = currentStops.filter(
          s => s.type === 'stop' && !afterStopAddresses.has(s.address)
        );
        
        for (const s of stopsToRemove) {
          await supabase.from("trip_stops").delete().eq("id", s.id);
        }

        // Reindex remaining stops
        const { data: remainingStops } = await supabase
          .from("trip_stops")
          .select("*")
          .eq("trip_id", trip.id)
          .order("stop_index", { ascending: true });

        if (remainingStops) {
          for (let i = 0; i < remainingStops.length; i++) {
            if (remainingStops[i].stop_index !== i) {
              await supabase
                .from("trip_stops")
                .update({ stop_index: i, updated_at: now })
                .eq("id", remainingStops[i].id);
            }
          }
          await supabase
            .from("trips")
            .update({ total_stops: remainingStops.length })
            .eq("id", trip.id);
        }
      }
      stopsModified = true;
    }

    // 5. RECALCULATE FARE — use the new fare from change request if provided,
    //    otherwise recalculate from vehicle_pricing
    let newFarePence: number;
    let newEstimatedFare: number;
    let newDistanceKm: number;
    let newDurationMinutes: number;

    if (cr.new_fare_pence && cr.new_fare_pence > 0) {
      // Use pre-calculated fare from the change request (customer app already computed it)
      newFarePence = cr.new_fare_pence;
      newEstimatedFare = newFarePence / 100;
      newDistanceKm = cr.new_distance_meters ? cr.new_distance_meters / 1000 : (trip.estimated_distance_km || 0);
      newDurationMinutes = cr.new_duration_seconds ? Math.round(cr.new_duration_seconds / 60) : (trip.estimated_duration_minutes || 0);
      console.log("[apply-trip-change] Using pre-calculated fare from change request:", newFarePence, "pence");
    } else {
      // Recalculate from scratch using vehicle_pricing
      console.log("[apply-trip-change] Recalculating fare from vehicle_pricing");

      // Build waypoints: pickup → intermediate stops → new dropoff
      const { data: latestStops } = await supabase
        .from("trip_stops")
        .select("*")
        .eq("trip_id", trip.id)
        .order("stop_index", { ascending: true });

      const waypoints: { lat: number; lng: number }[] = [];
      if (latestStops) {
        for (const s of latestStops) {
          waypoints.push({ lat: s.lat || 0, lng: s.lng || 0 });
        }
      }
      // Fallback if no stops
      if (waypoints.length < 2) {
        waypoints.length = 0;
        waypoints.push({ lat: trip.pickup_latitude || 0, lng: trip.pickup_longitude || 0 });
        waypoints.push({ lat: newDropoffLat || 0, lng: newDropoffLng || 0 });
      }

      newDistanceKm = calculateRouteDistanceKm(waypoints);
      newDurationMinutes = Math.max(5, Math.round(newDistanceKm * 2.5));

      // Get pricing
      let baseFarePence = 0;
      let perKmPence = 0;
      let minFarePence = 0;

      if (trip.service_area_id) {
        const vehicleType = trip.vehicle_type || 'economy';
        const { data: pricing } = await supabase
          .from("vehicle_pricing")
          .select("base_fare_pence, per_km_pence, per_mile_pence, min_fare_pence")
          .eq("service_area_id", trip.service_area_id)
          .eq("vehicle_type", vehicleType)
          .eq("is_active", true)
          .maybeSingle();

        if (pricing) {
          baseFarePence = pricing.base_fare_pence || 0;
          perKmPence = pricing.per_km_pence || 0;
          minFarePence = pricing.min_fare_pence || 0;
        }
      }

      newFarePence = baseFarePence + Math.round(newDistanceKm * perKmPence);
      if (minFarePence > 0) {
        newFarePence = Math.max(newFarePence, minFarePence);
      }
      newEstimatedFare = newFarePence / 100;

      console.log("[apply-trip-change] Recalculated fare:", {
        distanceKm: newDistanceKm.toFixed(2),
        baseFarePence,
        perKmPence,
        totalPence: newFarePence,
        fare: newEstimatedFare,
      });
    }

    // 6. Update the trip row with new fare + route data (triggers realtime)
    const tripUpdate: Record<string, unknown> = {
      estimated_fare: newEstimatedFare,
      fare: newEstimatedFare,
      estimated_total_pence: newFarePence,
      base_fare_pence: newFarePence, // Update base for commission calc
      estimated_distance_km: Math.round(newDistanceKm * 100) / 100,
      estimated_duration_minutes: newDurationMinutes,
      dropoff_address: newDropoffAddress,
      dropoff_latitude: newDropoffLat,
      dropoff_longitude: newDropoffLng,
      updated_at: now,
    };

    // Rebuild the stops JSON array on the trip (legacy field used by some components)
    if (stopsModified) {
      const { data: finalStops } = await supabase
        .from("trip_stops")
        .select("*")
        .eq("trip_id", trip.id)
        .order("stop_index", { ascending: true });

      if (finalStops) {
        const stopsJson = finalStops
          .filter(s => s.type === 'stop')
          .map(s => ({ lat: s.lat, lng: s.lng, address: s.address, order: s.stop_index }));
        tripUpdate.stops = stopsJson;
      }
    }

    console.log("[apply-trip-change] Updating trip:", trip.id, tripUpdate);

    const { data: updatedTrip, error: updateErr } = await supabase
      .from("trips")
      .update(tripUpdate)
      .eq("id", trip.id)
      .select()
      .single();

    if (updateErr) {
      console.error("[apply-trip-change] Trip update error:", updateErr);
      return errorResponse("UPDATE_FAILED", "Failed to update trip", 500);
    }

    // 7. Mark change request as approved + applied
    await supabase
      .from("trip_change_requests")
      .update({
        status: "approved",
        responded_at: now,
        response_by: driver_id,
      })
      .eq("id", change_request_id);

    console.log("[apply-trip-change] Success — trip updated with new fare:", newEstimatedFare);

    return successResponse({
      success: true,
      action: "approved",
      trip: updatedTrip,
      fare_pence: newFarePence,
      fare: newEstimatedFare,
      distance_km: Math.round(newDistanceKm * 100) / 100,
      duration_minutes: newDurationMinutes,
    });

  } catch (error) {
    console.error("[apply-trip-change] Error:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
