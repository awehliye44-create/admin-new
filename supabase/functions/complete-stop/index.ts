import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
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
  validationErrorResponse,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = {
  limit: 60,
  windowMs: 60000,
  keyPrefix: 'complete-stop'
};

const VALID_ACTIONS = ['arrive', 'complete'];

/**
 * SINGLE SOURCE OF TRUTH: Stop Completion Logic
 * 
 * Backend enforcement for stop completion:
 * 1. Cannot complete a stop if previous stops are not completed
 * 2. Cannot complete the same stop twice (idempotent)
 * 3. current_stop_index can NEVER revert to a previous value
 * 4. Trip can only be completed when at final stop
 */

interface CompleteStopRequest {
  trip_id: string;
  stop_id: string;
  driver_id: string;
  action: 'arrive' | 'complete';
  client_action_id?: string; // Idempotency key
}

type StopStatus = 'pending' | 'current' | 'completed' | 'skipped';

Deno.serve(async (req) => {
  console.warn(
    "[complete-stop] LEGACY_PATH_EXECUTED — use stop-workflow (arrive_stop / drive_to_next / complete_trip)",
  );
  console.log("[complete-stop] Received request:", req.method);
  
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.warn("[complete-stop] Rate limit exceeded for IP:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: CompleteStopRequest = await req.json();
    const { trip_id, stop_id, driver_id, action, client_action_id } = body;

    console.log("[complete-stop] Request:", JSON.stringify({ trip_id, stop_id, driver_id, action }));

    // Input validation
    const validationErrors: Record<string, string> = {};

    if (!trip_id) {
      validationErrors.trip_id = "trip_id is required";
    } else if (!isValidUUID(trip_id)) {
      validationErrors.trip_id = "trip_id must be a valid UUID";
    }

    if (!stop_id) {
      validationErrors.stop_id = "stop_id is required";
    } else if (!isValidUUID(stop_id)) {
      validationErrors.stop_id = "stop_id must be a valid UUID";
    }

    if (!driver_id) {
      validationErrors.driver_id = "driver_id is required";
    } else if (!isValidUUID(driver_id)) {
      validationErrors.driver_id = "driver_id must be a valid UUID";
    }

    if (!action) {
      validationErrors.action = "action is required";
    } else if (!isValidAction(action, VALID_ACTIONS)) {
      validationErrors.action = `action must be one of: ${VALID_ACTIONS.join(', ')}`;
    }

    if (Object.keys(validationErrors).length > 0) {
      console.log("[complete-stop] Validation failed:", validationErrors);
      return validationErrorResponse(validationErrors);
    }

    // Fetch trip to validate driver authorization
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("*")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      console.log("[complete-stop] Trip not found:", tripError);
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    // Verify driver authorization
    if (trip.driver_id !== driver_id) {
      return errorResponse("UNAUTHORIZED", "Not authorized - trip assigned to different driver", 403);
    }

    // Verify trip is in progress
    if (!['in_progress', 'accepted', 'arrived_pickup'].includes(trip.status)) {
      return errorResponse("INVALID_STATE", `Cannot modify stops for trip in status: ${trip.status}`, 400);
    }

    // Fetch all stops for the trip
    const { data: stops, error: stopsError } = await supabase
      .from("trip_stops")
      .select("*")
      .eq("trip_id", trip_id)
      .order("stop_index", { ascending: true });

    if (stopsError) {
      console.error("[complete-stop] Error fetching stops:", stopsError);
      return errorResponse("FETCH_ERROR", "Failed to fetch stops", 500);
    }

    // Find the target stop
    const targetStop = stops?.find(s => s.id === stop_id);
    if (!targetStop) {
      return errorResponse("STOP_NOT_FOUND", "Stop not found", 404);
    }

    console.log("[complete-stop] Target stop:", targetStop.stop_index, "Status:", targetStop.status, "Action:", action);

    const now = new Date().toISOString();

    // Handle ARRIVE action
    if (action === 'arrive') {
      // IDEMPOTENCY: If already current or completed, return success
      if (targetStop.status === 'current' || targetStop.status === 'completed') {
        console.log("[complete-stop] Stop already current/completed, returning success (idempotent)");
        return successResponse({ 
          success: true, 
          stop: targetStop,
          idempotent: true,
          message: "Stop already arrived" 
        });
      }

      // Validate: can only arrive at pending stops
      if (targetStop.status !== 'pending') {
        return errorResponse("INVALID_STATUS", `Cannot arrive at stop with status: ${targetStop.status}`, 400);
      }

      // Validate: all previous stops must be completed or skipped
      const previousStops = stops?.filter(s => s.stop_index < targetStop.stop_index) || [];
      const allPreviousCompleted = previousStops.every(s => 
        s.status === 'completed' || s.status === 'skipped'
      );

      if (!allPreviousCompleted) {
        const incompletePrevious = previousStops.find(s => 
          s.status !== 'completed' && s.status !== 'skipped'
        );
        return errorResponse(
          "SEQUENCE_ERROR", 
          "Must complete previous stops first", 
          400,
          { incomplete_stop_index: incompletePrevious?.stop_index }
        );
      }

      // Update stop to 'current'
      const { data: updatedStop, error: updateError } = await supabase
        .from("trip_stops")
        .update({
          status: 'current' as StopStatus,
          arrived_at: now,
          updated_at: now,
        })
        .eq("id", stop_id)
        .select()
        .single();

      if (updateError) {
        console.error("[complete-stop] Update error:", updateError);
        return errorResponse("UPDATE_FAILED", "Failed to update stop", 500);
      }

      console.log("[complete-stop] ARRIVE SUCCESS:", stop_id);
      return successResponse({ success: true, stop: updatedStop });
    }

    // Handle COMPLETE action
    if (action === 'complete') {
      // IDEMPOTENCY: If already completed, return success
      if (targetStop.status === 'completed' || targetStop.status === 'skipped') {
        console.log("[complete-stop] Stop already completed, returning success (idempotent)");
        return successResponse({ 
          success: true, 
          stop: targetStop,
          idempotent: true,
          message: "Stop already completed" 
        });
      }

      // Validate: can only complete stops that are 'current'
      if (targetStop.status !== 'current') {
        return errorResponse("INVALID_STATUS", `Cannot complete stop with status: ${targetStop.status}. Must arrive first.`, 400);
      }

      // Mark stop as completed
      const { data: completedStop, error: completeError } = await supabase
        .from("trip_stops")
        .update({
          status: 'completed' as StopStatus,
          completed_at: now,
          updated_at: now,
        })
        .eq("id", stop_id)
        .select()
        .single();

      if (completeError) {
        console.error("[complete-stop] Complete error:", completeError);
        return errorResponse("UPDATE_FAILED", "Failed to complete stop", 500);
      }

      // Find and set next stop as current
      const nextStop = stops?.find(s => s.stop_index === targetStop.stop_index + 1);
      
      if (nextStop && nextStop.status === 'pending') {
        await supabase
          .from("trip_stops")
          .update({
            status: 'current' as StopStatus,
            updated_at: now,
          })
          .eq("id", nextStop.id);

        // Update trip's current_stop_index (forward only - validate)
        const currentIndex = trip.current_stop_index || 0;
        const newIndex = nextStop.stop_index;
        
        if (newIndex >= currentIndex) {
          await supabase
            .from("trips")
            .update({
              current_stop_index: newIndex,
              updated_at: now,
            })
            .eq("id", trip_id);
        } else {
          console.log("[complete-stop] REJECTED index revert:", newIndex, "< current:", currentIndex);
        }
      }

      console.log("[complete-stop] COMPLETE SUCCESS:", stop_id);
      return successResponse({ 
        success: true, 
        stop: completedStop,
        next_stop_id: nextStop?.id || null
      });
    }

    return errorResponse("UNKNOWN", "Unexpected error", 500);

  } catch (error) {
    console.error("[complete-stop] Error:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
