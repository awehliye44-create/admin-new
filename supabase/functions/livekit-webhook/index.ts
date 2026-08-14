/**
 * LiveKit webhook — authoritative room/participant reconciliation for VoIP sessions.
 * verify_jwt must be false in config; authenticity comes from LiveKit signature.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { RoomServiceClient, WebhookReceiver } from "npm:livekit-server-sdk@2.9.1";
import {
  applyVoipParticipantJoined,
  finalizeVoipCallLog,
  VOIP_END_REASON,
} from "../_shared/voipCallLogs.ts";
import { findVoipCallByRoomName, capDurationSeconds } from "../_shared/tripCallSession.ts";
import { mapLiveKitWebhookEventType } from "../_shared/tripCallStatus.ts";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") {
    return json(405, { error: "METHOD_NOT_ALLOWED" });
  }

  const apiKey = Deno.env.get("LIVEKIT_API_KEY");
  const apiSecret = Deno.env.get("LIVEKIT_API_SECRET");
  const livekitUrl = Deno.env.get("LIVEKIT_URL");
  if (!apiKey || !apiSecret) {
    console.error("[livekit-webhook] LiveKit credentials missing");
    return json(503, { error: "PROVIDER_UNAVAILABLE" });
  }

  const authHeader = req.headers.get("Authorization") ??
    req.headers.get("authorization") ??
    "";
  const rawBody = await req.text();

  let event: {
    id?: string;
    event?: string;
    createdAt?: number;
    room?: { name?: string; sid?: string; numParticipants?: number };
    participant?: { identity?: string };
    track?: { type?: string | number; sid?: string; source?: string | number };
  };

  try {
    const receiver = new WebhookReceiver(apiKey, apiSecret);
    event = await receiver.receive(rawBody, authHeader) as typeof event;
  } catch {
    console.warn("[livekit-webhook] signature rejected");
    return json(401, { error: "INVALID_SIGNATURE" });
  }

  const eventId = String(event.id ?? "").trim();
  const eventType = String(event.event ?? "").trim();
  const roomName = event.room?.name?.trim() ?? "";

  if (!eventId || !eventType) {
    return json(400, { error: "INVALID_EVENT" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const client = createClient(supabaseUrl, serviceKey);

  const { error: dedupeError } = await client
    .from("livekit_webhook_events")
    .insert({
      event_id: eventId,
      event_type: eventType,
      room_name: roomName || null,
    });

  if (dedupeError) {
    if (dedupeError.code === "23505") {
      return json(200, { ok: true, duplicate: true });
    }
    console.error("[livekit-webhook] dedupe insert failed", dedupeError.message);
    return json(500, { error: "INTERNAL_ERROR" });
  }

  if (!roomName) {
    return json(200, { ok: true, ignored: true });
  }

  const session = await findVoipCallByRoomName(client, roomName);
  if (!session) {
    console.info("[livekit-webhook] no session for room", {
      event_type: eventType,
      room_prefix: roomName.slice(0, 16),
    });
    return json(200, { ok: true, unmatched: true });
  }

  await client
    .from("livekit_webhook_events")
    .update({ call_log_id: session.callId })
    .eq("event_id", eventId);

  const mapped = mapLiveKitWebhookEventType(eventType);

  if (mapped === "room_started") {
    await client
      .from("voip_call_logs")
      .update({
        status: session.status === "requested" ? "ringing" : session.status,
        provider_room_sid: event.room?.sid ?? null,
      })
      .eq("id", session.callId)
      .is("ended_at", null);
  } else if (mapped === "participant_joined") {
    await applyVoipParticipantJoined(client, session.callId);
  } else if (mapped === "track_published") {
    // Enforce audio-only: mute non-microphone tracks when published.
    const trackType = String(event.track?.type ?? event.track?.source ?? "").toLowerCase();
    const isAudio = trackType.includes("audio") ||
      trackType.includes("microphone") ||
      trackType === "2" || // TrackSource.MICROPHONE
      trackType === "audio";
    const isVideoLike = trackType.includes("video") ||
      trackType.includes("camera") ||
      trackType.includes("screen") ||
      trackType === "1" || // CAMERA
      trackType === "3" || // SCREEN_SHARE
      trackType === "4"; // SCREEN_SHARE_AUDIO still blocked for screenshare policy

    if (isVideoLike && !isAudio && livekitUrl && event.participant?.identity && event.track?.sid) {
      try {
        const rooms = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
        await rooms.mutePublishedTrack(
          roomName,
          event.participant.identity,
          event.track.sid,
          true,
        );
        console.info("[livekit-webhook] muted non-audio track", {
          call_id: session.callId,
          track_type: trackType.slice(0, 32),
        });
      } catch {
        console.warn("[livekit-webhook] mute non-audio track failed", {
          call_id: session.callId,
        });
      }
    }
  } else if (mapped === "participant_left") {
    const { data: log } = await client
      .from("voip_call_logs")
      .select("id, status, participants_joined, connected_at, started_at, ended_at")
      .eq("id", session.callId)
      .maybeSingle();

    if (log && !log.ended_at) {
      const remaining = Math.max(0, (log.participants_joined ?? 1) - 1);
      await client
        .from("voip_call_logs")
        .update({ participants_joined: remaining })
        .eq("id", session.callId)
        .is("ended_at", null);

      // Last participant left — terminalise if room webhook is delayed.
      if (remaining <= 0) {
        const baseMs = new Date(log.connected_at ?? log.started_at).getTime();
        const duration = capDurationSeconds(Math.floor((Date.now() - baseMs) / 1000));
        await finalizeVoipCallLog(client, session.callId, {
          duration_seconds: duration,
          end_reason: VOIP_END_REASON.PARTICIPANT_LEFT,
          status: log.connected_at ? "completed" : "missed",
        });
      }
    }
  } else if (mapped === "room_finished") {
    const baseMs = new Date(session.connectedAt ?? session.startedAt ?? Date.now()).getTime();
    const duration = capDurationSeconds(Math.floor((Date.now() - baseMs) / 1000));
    await finalizeVoipCallLog(client, session.callId, {
      duration_seconds: duration,
      end_reason: VOIP_END_REASON.ROOM_DELETED,
      status: "completed",
    });
  }

  return json(200, { ok: true, call_id: session.callId, event_type: eventType });
});
