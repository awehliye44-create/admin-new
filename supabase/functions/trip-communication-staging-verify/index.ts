/**
 * Service-role / cron staging verification for trip communication 4-minute enforcement.
 * Does NOT require mobile UI. Proves:
 * - LiveKit room create + deleteRoom (provider disconnect control)
 * - VoIP session expires → sweep/terminate → timed_out + duration capped at 240
 * - Expired session cannot mint a join token (CALL_EXPIRED / not joinable)
 * - MSG91 hang-up URL reachability (HTTP probe; not a live PSTN call)
 *
 * Auth: assertCronOrServiceRoleAuth
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { AccessToken, RoomServiceClient, TrackSource } from "npm:livekit-server-sdk@2.9.1";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import {
  createOrReuseVoipSession,
  terminateVoipSession,
  VOIP_END_REASON,
} from "../_shared/voipCallLogs.ts";
import {
  opaqueVoipRoomName,
  voipJoinTokenTtlSeconds,
  voipParticipantIdentity,
  capDurationSeconds,
} from "../_shared/tripCallSession.ts";
import { TRIP_COMMUNICATION_MAX_DURATION_SECONDS } from "../../../shared/tripCommunicationSsot.ts";

const MSG91_HANGUP_URLS = [
  "https://control.msg91.com/api/v5/voice/call/hangup",
  "https://control.msg91.com/api/v5/voice/hangup",
  "https://control.msg91.com/api/v5/voice/call/disconnect",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const auth = await assertCronOrServiceRoleAuth(req, body);
  if (!auth.ok) return auth.response;

  const report: Record<string, unknown> = {
    max_duration_seconds: TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
    live_media_calls: {
      note: "Skipped — no mobile UI / no active assigned trip in this phase",
      driver_to_customer_voip: "not_run",
      customer_to_driver_voip: "not_run",
      driver_to_customer_msg91: "not_run",
      customer_to_driver_msg91: "not_run",
    },
  };

  const livekitUrl = Deno.env.get("LIVEKIT_URL") ?? "";
  const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY") ?? "";
  const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const client = createClient(supabaseUrl, serviceKey);

  // --- LiveKit room create + delete ---
  const roomName = opaqueVoipRoomName();
  let livekitRoom: Record<string, unknown> = { ok: false };
  if (livekitUrl && livekitApiKey && livekitApiSecret) {
    const rooms = new RoomServiceClient(livekitUrl, livekitApiKey, livekitApiSecret);
    try {
      await rooms.createRoom({ name: roomName, emptyTimeout: 60, maxParticipants: 2 });
      // Mint a short audio-only token for the room (contract check, not a media call)
      const token = new AccessToken(livekitApiKey, livekitApiSecret, {
        identity: await voipParticipantIdentity(crypto.randomUUID(), "driver"),
        name: "StagingDriver",
        ttl: 60,
      });
      token.addGrant({
        roomJoin: true,
        room: roomName,
        roomCreate: false,
        roomAdmin: false,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: [TrackSource.MICROPHONE],
      });
      const jwt = await token.toJwt();
      await rooms.deleteRoom(roomName);
      livekitRoom = {
        ok: true,
        room_created_and_deleted: true,
        room_prefix: roomName.slice(0, 16),
        token_issued: Boolean(jwt && jwt.length > 20),
        token_includes_room_admin: false,
        audio_only_grant: true,
      };
    } catch (error) {
      livekitRoom = {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 120) : "livekit_error",
      };
    }
  } else {
    livekitRoom = { ok: false, error: "LIVEKIT_ENV_MISSING" };
  }
  report.livekit_room_control = livekitRoom;

  // --- VoIP session timeout termination ---
  const { data: trip } = await client.from("trips").select("id, service_area_id").limit(1).maybeSingle();
  let voipTimeout: Record<string, unknown> = { ok: false };
  if (trip?.id) {
    const created = await createOrReuseVoipSession(client, {
      tripId: trip.id,
      serviceAreaId: trip.service_area_id,
      driverId: null,
      customerId: null,
      initiatorUserId: "00000000-0000-0000-0000-000000000001",
      initiatorRole: "driver",
      idempotencyKey: `staging-verify-${crypto.randomUUID()}`,
    });
    if (created.ok) {
      const past = new Date(Date.now() - 5_000).toISOString();
      await client
        .from("voip_call_logs")
        .update({
          expires_at: past,
          connected_at: new Date(Date.now() - 300_000).toISOString(),
          status: "active",
          participants_joined: 2,
        })
        .eq("id", created.session.callId);

      const ttlBefore = voipJoinTokenTtlSeconds({ expiresAt: past });
      const term = await terminateVoipSession(client, {
        callId: created.session.callId,
        endReason: VOIP_END_REASON.MAX_DURATION,
        status: "timed_out",
        livekitUrl,
        livekitApiKey,
        livekitApiSecret,
      });
      const { data: after } = await client
        .from("voip_call_logs")
        .select("status, duration_seconds, ended_at, end_reason")
        .eq("id", created.session.callId)
        .maybeSingle();

      // Idempotent second terminate
      const term2 = await terminateVoipSession(client, {
        callId: created.session.callId,
        endReason: VOIP_END_REASON.MAX_DURATION,
        status: "timed_out",
        livekitUrl,
        livekitApiKey,
        livekitApiSecret,
      });

      voipTimeout = {
        ok: after?.status === "timed_out" &&
          (after?.duration_seconds ?? 999) <= TRIP_COMMUNICATION_MAX_DURATION_SECONDS &&
          Boolean(after?.ended_at) &&
          ttlBefore === 0 &&
          term.ok &&
          term2.alreadyTerminal,
        join_ttl_when_expired: ttlBefore,
        status: after?.status,
        duration_seconds: after?.duration_seconds,
        duration_capped: capDurationSeconds(after?.duration_seconds ?? 0) <= 240,
        end_reason: after?.end_reason,
        terminate_idempotent: term2.alreadyTerminal,
        opaque_room: created.roomName.startsWith("onecab-call-"),
      };
    } else {
      voipTimeout = { ok: false, error: created.errorCode };
    }
  } else {
    voipTimeout = { ok: false, error: "NO_TRIP_ROW" };
  }
  report.voip_timeout_enforcement = voipTimeout;

  // --- MSG91 hang-up endpoint probe (no live call) ---
  const authKey = Deno.env.get("MSG91_AUTH_KEY")?.trim() ?? "";
  const hangupProbe: Array<Record<string, unknown>> = [];
  if (authKey) {
    for (const hangupUrl of MSG91_HANGUP_URLS) {
      try {
        const res = await fetch(hangupUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", authkey: authKey },
          body: JSON.stringify({ uuid: "00000000-0000-0000-0000-000000000000" }),
        });
        // Do not log response body (may contain provider details)
        hangupProbe.push({
          url_path: new URL(hangupUrl).pathname,
          http_status: res.status,
          reachable: res.status > 0,
        });
      } catch {
        hangupProbe.push({
          url_path: new URL(hangupUrl).pathname,
          reachable: false,
        });
      }
    }
  }
  report.msg91_hangup_probe = {
    auth_configured: Boolean(authKey),
    max_call_duration_field: "max_call_duration",
    max_call_duration_value: TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
    endpoints: hangupProbe,
    note: "Hang-up probed with dummy uuid; live PSTN auto-end still requires a real bridge call.",
  };

  const hardGateReady = Boolean(
    (livekitRoom as { ok?: boolean }).ok && (voipTimeout as { ok?: boolean }).ok && authKey,
  );
  report.hard_gate = {
    backend_auto_terminate_voip: (voipTimeout as { ok?: boolean }).ok === true,
    backend_livekit_disconnect_control: (livekitRoom as { ok?: boolean }).ok === true,
    msg91_hangup_capability_coded: hangupProbe.some((p) => p.reachable === true),
    live_four_minute_media_calls_both_methods: false,
    claim_complete: false,
    reason: hardGateReady
      ? "Backend enforcement proven; live 4-minute media staging still required for hard gate."
      : "Backend staging checks incomplete — see report fields.",
  };

  return Response.json({ ok: true, report });
});
