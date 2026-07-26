import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import {
  finalizeVoipCallLog,
  terminateVoipSession,
  VOIP_END_REASON,
} from "../_shared/voipCallLogs.ts";
import {
  resolveTripCommunicationParticipant,
  TRIP_COMMUNICATION_ERROR,
} from "../../../shared/tripCommunicationSsot.ts";

interface VoipCallEventRequest {
  trip_id?: string;
  call_log_id?: string;
  call_id?: string;
  action?: "end" | "hint";
  duration_seconds?: number;
  end_reason?: string;
}

/**
 * Authorised VoIP call end / client hint.
 * End action terminates the LiveKit room server-side; webhook reconciles if delayed.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  if (req.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse(
        TRIP_COMMUNICATION_ERROR.AUTH_REQUIRED,
        "Authentication required",
        401,
      );
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
      return errorResponse(
        TRIP_COMMUNICATION_ERROR.AUTH_REQUIRED,
        "Authentication required",
        401,
      );
    }

    const body = (await req.json()) as VoipCallEventRequest;
    const tripId = body.trip_id?.trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse({ trip_id: "Valid trip_id is required" });
    }

    const action = body.action === "hint" ? "hint" : "end";

    const { data: trip, error: tripError } = await userClient
      .from("trips")
      .select("id, confirmed_driver_id, driver_id, passenger_id")
      .eq("id", tripId)
      .maybeSingle();

    if (tripError || !trip) {
      return errorResponse(TRIP_COMMUNICATION_ERROR.TRIP_NOT_FOUND, "Trip not found", 404);
    }

    const { data: driverRow } = await userClient
      .from("drivers")
      .select("id, user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    const { data: customerRow } = await userClient
      .from("customers")
      .select("id, user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    const passengerId = trip.passenger_id;
    const customerOwnsTrip = Boolean(
      passengerId &&
        (passengerId === authData.user.id ||
          (customerRow?.id && passengerId === customerRow.id) ||
          (customerRow?.user_id && passengerId === customerRow.user_id)),
    );

    const participant = resolveTripCommunicationParticipant({
      authUserId: authData.user.id,
      driverProfileId: driverRow?.id ?? null,
      trip: {
        ...trip,
        passenger_id: customerOwnsTrip ? authData.user.id : trip.passenger_id,
      },
    });
    if (!participant.ok) {
      return errorResponse(
        participant.errorCode,
        "You are not authorised to communicate on this trip.",
        403,
      );
    }

    let logId = (body.call_id ?? body.call_log_id)?.trim() ?? null;
    if (logId && !isValidUUID(logId)) {
      return validationErrorResponse({
        call_id: "Valid call_id is required when provided",
      });
    }

    if (!logId) {
      const { data: activeLog } = await serviceClient
        .from("voip_call_logs")
        .select("id")
        .eq("trip_id", tripId)
        .is("ended_at", null)
        .in("status", ["requested", "ringing", "connecting", "active"])
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      logId = activeLog?.id ?? null;
    }

    if (!logId) {
      return successResponse({ success: true, skipped: true });
    }

    // Ensure the call belongs to this trip
    const { data: logRow } = await serviceClient
      .from("voip_call_logs")
      .select("id, trip_id, status, ended_at")
      .eq("id", logId)
      .maybeSingle();

    if (!logRow || logRow.trip_id !== tripId) {
      return errorResponse(
        TRIP_COMMUNICATION_ERROR.CALL_NOT_FOUND,
        "Call not found for this trip",
        404,
      );
    }

    if (action === "hint") {
      const durationSeconds = Math.max(
        0,
        Number.isFinite(body.duration_seconds) ? Math.floor(body.duration_seconds!) : 0,
      );
      const endReason = body.end_reason?.trim() || VOIP_END_REASON.CLIENT_ENDED;
      await finalizeVoipCallLog(serviceClient, logId, {
        duration_seconds: durationSeconds,
        end_reason: endReason,
        status: endReason === VOIP_END_REASON.MAX_DURATION ? "timed_out" : "completed",
      });
      return successResponse({ success: true, call_log_id: logId, action: "hint" });
    }

    const livekitUrl = Deno.env.get("LIVEKIT_URL") ?? "";
    const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY") ?? "";
    const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET") ?? "";

    const result = await terminateVoipSession(serviceClient, {
      callId: logId,
      endReason: body.end_reason?.trim() || VOIP_END_REASON.CLIENT_ENDED,
      status: "completed",
      livekitUrl,
      livekitApiKey,
      livekitApiSecret,
    });

    return successResponse({
      success: true,
      call_log_id: logId,
      action: "end",
      already_terminal: result.alreadyTerminal,
    });
  } catch (error) {
    console.error("[voip-call-event] unexpected error", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
