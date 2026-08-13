import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { AccessToken, TrackSource } from "npm:livekit-server-sdk@2.9.1";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import { isCallableTripStatus } from "../_shared/callMaskingConfig.ts";
import {
  createOrReuseVoipSession,
  markVoipIncomingPushSent,
  scheduleVoipMaxDurationEnforcement,
  VOIP_END_REASON,
} from "../_shared/voipCallLogs.ts";
import { sendIncomingCallPush } from "../_shared/incomingCallPush.ts";
import {
  findActiveCallForTrip,
  voipJoinTokenTtlSeconds,
  voipParticipantIdentity,
} from "../_shared/tripCallSession.ts";
import { isTerminalCallStatus } from "../_shared/tripCallStatus.ts";
import {
  readCommunicationProviderReadinessFromEnv,
  resolveTripCommunicationParticipant,
  resolveTripCommunicationSsot,
  resolveVoipTokenGate,
  TRIP_COMMUNICATION_ERROR,
  TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
} from "../../../shared/tripCommunicationSsot.ts";

interface TokenRequest {
  trip_id?: string;
  idempotency_key?: string;
  /** start = create/reuse + push; join = token for existing active session */
  action?: "start" | "join";
  call_id?: string;
}

/**
 * Issue a short-lived audio-only LiveKit token for an authorised trip participant.
 * Session create is idempotent; room names and identities are server-derived.
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

    const body = (await req.json()) as TokenRequest;
    const tripId = body.trip_id?.trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse({ trip_id: "Valid trip_id is required" });
    }

    const action = body.action === "join" ? "join" : "start";
    const idempotencyKey = body.idempotency_key?.trim() ?? "";
    if (action === "start" && (!idempotencyKey || idempotencyKey.length > 128)) {
      return validationErrorResponse({
        idempotency_key: "idempotency_key is required for start (max 128 chars)",
      });
    }

    const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY");
    const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET");
    const livekitUrl = Deno.env.get("LIVEKIT_URL");

    const { data: trip, error: tripError } = await userClient
      .from("trips")
      .select(
        "id, status, service_area_id, confirmed_driver_id, driver_id, passenger_id",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (tripError) {
      console.error("[livekit-voip-token] trip lookup failed", tripError.message);
      return errorResponse("INTERNAL_ERROR", "Failed to load trip", 500);
    }
    if (!trip) {
      return errorResponse(
        TRIP_COMMUNICATION_ERROR.TRIP_NOT_FOUND,
        "Trip not found",
        404,
      );
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

    let settings = null;
    let maskingConfig = null;
    if (trip.service_area_id) {
      const { data, error: settingsError } = await serviceClient
        .from("service_area_communication_settings")
        .select(
          "is_enabled, voip_enabled, call_masking_enabled, default_method, maximum_call_duration_seconds",
        )
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();
      if (settingsError) {
        console.error("[livekit-voip-token] settings lookup failed", settingsError.message);
        return errorResponse("INTERNAL_ERROR", "Failed to load communication settings", 500);
      }
      settings = data;

      const { data: maskingRow } = await serviceClient
        .from("service_area_call_masking_config")
        .select("outbound_caller_id, is_active, provider_config_id")
        .eq("service_area_id", trip.service_area_id)
        .maybeSingle();
      maskingConfig = maskingRow;
    }

    const providerReadiness = readCommunicationProviderReadinessFromEnv(Deno.env);
    const livekitReady = Boolean(
      providerReadiness.livekitConfigured && livekitApiKey && livekitApiSecret && livekitUrl,
    );
    const ssot = resolveTripCommunicationSsot({
      tripId,
      serviceAreaId: trip.service_area_id,
      actorRole: participant.role,
      participantAuthorised: true,
      lifecycleEligible: isCallableTripStatus(trip.status),
      settings,
      maskingConfig,
      providerReadiness: {
        ...providerReadiness,
        livekitConfigured: livekitReady,
      },
    });

    const gate = resolveVoipTokenGate(ssot);
    if (!gate.ok) {
      return errorResponse(gate.errorCode, gate.message, gate.status);
    }

    const assignedDriverId = participant.assignedDriverId;
    let session = null as Awaited<ReturnType<typeof createOrReuseVoipSession>> extends
      { ok: true; session: infer S } ? S : never;
    let roomName = "";
    let created = false;

    if (action === "start") {
      const createdSession = await createOrReuseVoipSession(serviceClient, {
        tripId,
        serviceAreaId: trip.service_area_id,
        driverId: assignedDriverId,
        customerId: trip.passenger_id,
        initiatorUserId: authData.user.id,
        initiatorRole: participant.role,
        idempotencyKey,
      });
      if (!createdSession.ok) {
        return errorResponse(createdSession.errorCode, createdSession.message, 409);
      }
      session = createdSession.session;
      roomName = createdSession.roomName;
      created = createdSession.created;

      if (created) {
        const pushMarked = await markVoipIncomingPushSent(serviceClient, session.callId);
        if (pushMarked) {
          const recipientDriverId = participant.role === "customer" ? assignedDriverId : null;
          let recipientUserId: string | null = null;
          if (participant.role === "driver") {
            // Resolve trip passenger to auth user_id for customer_push_tokens.
            const passengerRef = String(trip.passenger_id ?? "").trim();
            if (passengerRef) {
              if (customerRow?.id === passengerRef || customerRow?.user_id === passengerRef) {
                recipientUserId = customerRow.user_id ?? authData.user.id;
              } else {
                const { data: passengerCustomer } = await serviceClient
                  .from("customers")
                  .select("user_id, id")
                  .or(`id.eq.${passengerRef},user_id.eq.${passengerRef}`)
                  .limit(1)
                  .maybeSingle();
                recipientUserId = passengerCustomer?.user_id ?? passengerRef;
              }
            }
          }
          // Fire-and-forget; do not block token issuance on push
          // @ts-ignore
          const pushTask = sendIncomingCallPush(serviceClient, {
            tripId,
            callId: session.callId,
            method: "voip",
            initiatorRole: participant.role,
            expiresAt: session.expiresAt,
            recipientDriverId,
            recipientUserId,
          });
          // @ts-ignore
          if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
            // @ts-ignore
            EdgeRuntime.waitUntil(pushTask);
          } else {
            pushTask.catch(() => {});
          }
        }

        scheduleVoipMaxDurationEnforcement(serviceClient, {
          logId: session.callId,
          roomName,
          maxSeconds: TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
          livekitUrl: livekitUrl!,
          livekitApiKey: livekitApiKey!,
          livekitApiSecret: livekitApiSecret!,
        });
      }
    } else {
      const active = body.call_id && isValidUUID(body.call_id)
        ? await findActiveCallForTrip(serviceClient, tripId).then((s) =>
          s && s.callId === body.call_id ? s : null
        )
        : await findActiveCallForTrip(serviceClient, tripId);

      if (!active || active.method !== "voip") {
        return errorResponse(
          TRIP_COMMUNICATION_ERROR.CALL_NOT_FOUND,
          "No joinable VoIP call for this trip",
          404,
        );
      }
      if (isTerminalCallStatus(active.status)) {
        return errorResponse(
          TRIP_COMMUNICATION_ERROR.CALL_NOT_JOINABLE,
          "Call is no longer joinable",
          409,
        );
      }
      const remaining = voipJoinTokenTtlSeconds({ expiresAt: active.expiresAt });
      if (remaining <= 0) {
        return errorResponse(
          TRIP_COMMUNICATION_ERROR.CALL_EXPIRED,
          "Call session has expired",
          409,
        );
      }
      session = active;
      roomName = active.roomName ?? "";
      if (!roomName) {
        return errorResponse(
          TRIP_COMMUNICATION_ERROR.CALL_NOT_JOINABLE,
          "Call session is missing room context",
          409,
        );
      }
    }

    if (!session || isTerminalCallStatus(session.status)) {
      return errorResponse(
        TRIP_COMMUNICATION_ERROR.CALL_NOT_JOINABLE,
        "Call session is not joinable",
        409,
      );
    }

    const ttlSeconds = voipJoinTokenTtlSeconds({ expiresAt: session.expiresAt });
    if (ttlSeconds <= 0) {
      return errorResponse(
        TRIP_COMMUNICATION_ERROR.CALL_EXPIRED,
        "Call session has expired",
        409,
      );
    }

    const participantIdentity = await voipParticipantIdentity(
      session.callId,
      participant.role,
    );
    const participantName = participant.role === "driver" ? "Driver" : "Customer";

    const token = new AccessToken(livekitApiKey!, livekitApiSecret!, {
      identity: participantIdentity,
      name: participantName,
      ttl: ttlSeconds,
    });

    // Audio-only: restrict publish sources to microphone when SDK supports it.
    // Mobile clients must also disable camera/screenshare publish.
    token.addGrant({
      roomJoin: true,
      room: roomName,
      roomCreate: false,
      roomAdmin: false,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: [TrackSource.MICROPHONE],
      canUpdateOwnMetadata: false,
    });

    const jwt = await token.toJwt();

    return successResponse({
      token: jwt,
      livekit_url: livekitUrl,
      // Room name returned only on authorised join/start — never via push.
      room_name: roomName,
      maximum_call_duration_seconds: TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
      participant_identity: participantIdentity,
      call_log_id: session.callId,
      call_id: session.callId,
      action,
      created,
      expires_at: session.expiresAt,
      status: session.status,
      token_ttl_seconds: ttlSeconds,
      end_reason_hint: VOIP_END_REASON.MAX_DURATION,
    });
  } catch (error) {
    console.error("[livekit-voip-token] unexpected error", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
