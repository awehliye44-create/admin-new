import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import { finalizeVoipCallLog, VOIP_END_REASON } from "../_shared/voipCallLogs.ts";

interface VoipCallEventRequest {
  trip_id?: string;
  call_log_id?: string;
  duration_seconds?: number;
  end_reason?: string;
}

Deno.serve(async (req) => {
  const preflight = handleCORSPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Unauthorized", 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) {
      return errorResponse("Unauthorized", 401);
    }

    const body = (await req.json()) as VoipCallEventRequest;
    const tripId = body.trip_id?.trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse("Valid trip_id is required");
    }

    const { data: trip, error: tripError } = await userClient
      .from("trips")
      .select("id, confirmed_driver_id, passenger_id")
      .eq("id", tripId)
      .maybeSingle();

    if (tripError || !trip) {
      return errorResponse("Trip not found", 404);
    }

    const { data: driverRow } = await userClient
      .from("drivers")
      .select("id, user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    const isDriver = driverRow?.id && trip.confirmed_driver_id === driverRow.id;
    const isPassenger = trip.passenger_id === authData.user.id;
    if (!isDriver && !isPassenger) {
      return errorResponse("Forbidden", 403);
    }

    let logId = body.call_log_id?.trim() ?? null;
    if (logId && !isValidUUID(logId)) {
      return validationErrorResponse("Valid call_log_id is required when provided");
    }

    if (!logId) {
      const { data: activeLog } = await serviceClient
        .from("voip_call_logs")
        .select("id")
        .eq("trip_id", tripId)
        .eq("status", "active")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      logId = activeLog?.id ?? null;
    }

    if (!logId) {
      return successResponse({ success: true, skipped: true });
    }

    const durationSeconds = Math.max(
      0,
      Number.isFinite(body.duration_seconds) ? Math.floor(body.duration_seconds!) : 0,
    );
    const endReason = body.end_reason?.trim() || VOIP_END_REASON.CLIENT_ENDED;

    await finalizeVoipCallLog(serviceClient, logId, {
      duration_seconds: durationSeconds,
      end_reason: endReason,
      status: endReason === VOIP_END_REASON.MAX_DURATION ? "disconnected" : "completed",
    });

    return successResponse({ success: true, call_log_id: logId });
  } catch (error) {
    console.error("[voip-call-event] unexpected error", error);
    return errorResponse("Internal server error", 500);
  }
});
