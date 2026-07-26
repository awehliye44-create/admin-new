/**
 * LiveKit VoIP call-session persistence + provider termination helpers.
 * Duration SSOT: TRIP_COMMUNICATION_MAX_DURATION_SECONDS (240).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { RoomServiceClient } from "npm:livekit-server-sdk@2.9.1";
import {
  TRIP_COMMUNICATION_ERROR,
  TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
} from "../../../shared/tripCommunicationSsot.ts";
import {
  capDurationSeconds,
  computeExpiresAtFromConnected,
  computeProvisionalExpiresAt,
  findActiveCallForTrip,
  opaqueVoipRoomName,
  type ProviderNeutralCallSession,
} from "./tripCallSession.ts";
import { isTerminalCallStatus, mapVoipLogStatus } from "./tripCallStatus.ts";
import { assertTripCallStartAllowed } from "./tripCallRateLimit.ts";

export const VOIP_END_REASON = {
  MAX_DURATION: "CALL_DURATION_LIMIT_REACHED",
  PARTICIPANT_LEFT: "CALL_COMPLETED",
  CLIENT_ENDED: "CLIENT_ENDED",
  ROOM_DELETED: "ROOM_DELETED",
  SUPERSEDED: "SUPERSEDED",
  TIMED_OUT: "TIMED_OUT",
  FAILED: "FAILED",
} as const;

export type VoipSessionCreateInput = {
  tripId: string;
  serviceAreaId: string | null;
  driverId: string | null;
  customerId: string | null;
  initiatorUserId: string;
  initiatorRole: "driver" | "customer";
  idempotencyKey: string;
};

export type VoipSessionCreateResult =
  | {
    ok: true;
    session: ProviderNeutralCallSession;
    created: boolean;
    roomName: string;
  }
  | {
    ok: false;
    errorCode: typeof TRIP_COMMUNICATION_ERROR[keyof typeof TRIP_COMMUNICATION_ERROR];
    message: string;
  };

async function loadVoipSession(
  client: SupabaseClient,
  callId: string,
): Promise<ProviderNeutralCallSession | null> {
  const { data } = await client
    .from("voip_call_logs")
    .select(
      "id, trip_id, service_area_id, status, started_at, connected_at, expires_at, ended_at, duration_seconds, end_reason, room_name, initiator_role, incoming_push_sent_at",
    )
    .eq("id", callId)
    .maybeSingle();
  if (!data) return null;
  return {
    callId: data.id,
    tripId: data.trip_id,
    serviceAreaId: data.service_area_id,
    method: "voip",
    provider: "livekit",
    status: mapVoipLogStatus(data.status, data.end_reason),
    startedAt: data.started_at,
    connectedAt: data.connected_at,
    expiresAt: data.expires_at,
    endedAt: data.ended_at,
    durationSeconds: data.duration_seconds,
    endReason: data.end_reason,
    roomName: data.room_name,
    initiatorRole: data.initiator_role === "driver" || data.initiator_role === "customer"
      ? data.initiator_role
      : null,
    incomingPushSentAt: data.incoming_push_sent_at,
  };
}

/**
 * Atomically create or reuse a VoIP session for a trip.
 * - Same idempotency key → reuse
 * - Existing active call on trip (any method) → CALL_ALREADY_ACTIVE (or reuse if same voip session + authorised)
 */
export async function createOrReuseVoipSession(
  client: SupabaseClient,
  input: VoipSessionCreateInput,
): Promise<VoipSessionCreateResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.VALIDATION_FAILED,
      message: "Valid idempotency_key is required",
    };
  }

  // Reuse exact idempotent start
  const { data: byKey } = await client
    .from("voip_call_logs")
    .select("id")
    .eq("trip_id", input.tripId)
    .eq("initiator_user_id", input.initiatorUserId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (byKey?.id) {
    const session = await loadVoipSession(client, byKey.id);
    if (session && !isTerminalCallStatus(session.status)) {
      return {
        ok: true,
        session,
        created: false,
        roomName: session.roomName ?? opaqueVoipRoomName(),
      };
    }
  }

  const existing = await findActiveCallForTrip(client, input.tripId);
  if (existing) {
    if (existing.method === "voip" && !isTerminalCallStatus(existing.status)) {
      // Concurrent start without matching idempotency key converges on the active session.
      return {
        ok: true,
        session: existing,
        created: false,
        roomName: existing.roomName ?? opaqueVoipRoomName(),
      };
    }
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.CALL_ALREADY_ACTIVE,
      message: "A call is already active for this trip",
    };
  }

  const rate = await assertTripCallStartAllowed(client, input.tripId);
  if (!rate.ok) {
    return {
      ok: false,
      errorCode: rate.errorCode,
      message: rate.message,
    };
  }

  const now = new Date().toISOString();
  const roomName = opaqueVoipRoomName();
  const expiresAt = computeProvisionalExpiresAt(now);

  const { data, error } = await client
    .from("voip_call_logs")
    .insert({
      trip_id: input.tripId,
      service_area_id: input.serviceAreaId,
      driver_id: input.driverId,
      customer_id: input.customerId,
      status: "requested",
      provider: "livekit",
      started_at: now,
      room_name: roomName,
      idempotency_key: idempotencyKey,
      initiator_role: input.initiatorRole,
      initiator_user_id: input.initiatorUserId,
      expires_at: expiresAt,
      participants_joined: 0,
    })
    .select("id")
    .single();

  if (error) {
    // Unique active-per-trip race → reload active
    if (error.code === "23505") {
      const raced = await findActiveCallForTrip(client, input.tripId);
      if (raced?.method === "voip") {
        return {
          ok: true,
          session: raced,
          created: false,
          roomName: raced.roomName ?? roomName,
        };
      }
      return {
        ok: false,
        errorCode: TRIP_COMMUNICATION_ERROR.CALL_ALREADY_ACTIVE,
        message: "A call is already active for this trip",
      };
    }
    console.error("[voipCallLogs] insert failed", error.message);
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.PROVIDER_UNAVAILABLE,
      message: "Failed to create call session",
    };
  }

  const session = await loadVoipSession(client, data.id);
  if (!session) {
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.PROVIDER_UNAVAILABLE,
      message: "Failed to load call session",
    };
  }

  return { ok: true, session, created: true, roomName };
}

/** @deprecated Prefer createOrReuseVoipSession — kept for any legacy imports. */
export async function startVoipCallLog(
  client: SupabaseClient,
  row: {
    trip_id: string;
    service_area_id: string | null;
    driver_id: string | null;
    customer_id: string | null;
  },
): Promise<string | null> {
  const result = await createOrReuseVoipSession(client, {
    tripId: row.trip_id,
    serviceAreaId: row.service_area_id,
    driverId: row.driver_id,
    customerId: row.customer_id,
    initiatorUserId: "00000000-0000-0000-0000-000000000000",
    initiatorRole: "driver",
    idempotencyKey: `legacy-${crypto.randomUUID()}`,
  });
  return result.ok ? result.session.callId : null;
}

export async function markVoipIncomingPushSent(
  client: SupabaseClient,
  callId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await client
    .from("voip_call_logs")
    .update({
      incoming_push_sent_at: now,
      status: "ringing",
    })
    .eq("id", callId)
    .is("incoming_push_sent_at", null)
    .in("status", ["requested", "ringing"])
    .select("id")
    .maybeSingle();
  return Boolean(data?.id);
}

export async function finalizeVoipCallLog(
  client: SupabaseClient,
  logId: string,
  patch: {
    duration_seconds: number;
    end_reason: string;
    status?: string;
  },
) {
  const { data: existing } = await client
    .from("voip_call_logs")
    .select("id, status, started_at, connected_at, ended_at")
    .eq("id", logId)
    .maybeSingle();

  if (!existing || existing.ended_at) return;
  if (isTerminalCallStatus(existing.status as never) && existing.status !== "active") {
    // Allow finalize from transitional active-family statuses only
    if (!["requested", "ringing", "connecting", "active"].includes(existing.status)) {
      return;
    }
  }

  const terminalStatus =
    patch.status ??
    (patch.end_reason === VOIP_END_REASON.MAX_DURATION ||
        patch.end_reason === VOIP_END_REASON.TIMED_OUT
      ? "timed_out"
      : patch.end_reason === VOIP_END_REASON.CLIENT_ENDED ||
          patch.end_reason === VOIP_END_REASON.PARTICIPANT_LEFT ||
          patch.end_reason === VOIP_END_REASON.ROOM_DELETED
      ? "completed"
      : "failed");

  await client
    .from("voip_call_logs")
    .update({
      ended_at: new Date().toISOString(),
      duration_seconds: capDurationSeconds(patch.duration_seconds),
      end_reason: patch.end_reason,
      status: terminalStatus,
    })
    .eq("id", logId)
    .is("ended_at", null);
}

export async function applyVoipParticipantJoined(
  client: SupabaseClient,
  callId: string,
): Promise<{ connected: boolean; expiresAt: string | null }> {
  const { data: existing } = await client
    .from("voip_call_logs")
    .select("id, status, participants_joined, connected_at, expires_at, ended_at")
    .eq("id", callId)
    .maybeSingle();

  if (!existing || existing.ended_at) {
    return { connected: false, expiresAt: null };
  }

  const joined = Math.min(2, (existing.participants_joined ?? 0) + 1);
  const bothConnected = joined >= 2;
  const now = new Date().toISOString();
  const connectedAt = existing.connected_at ?? (bothConnected ? now : null);
  const expiresAt = bothConnected
    ? (existing.connected_at
      ? existing.expires_at
      : computeExpiresAtFromConnected(connectedAt!))
    : existing.expires_at;

  await client
    .from("voip_call_logs")
    .update({
      participants_joined: joined,
      status: bothConnected ? "active" : "connecting",
      connected_at: connectedAt,
      expires_at: expiresAt,
    })
    .eq("id", callId)
    .is("ended_at", null);

  return { connected: bothConnected, expiresAt };
}

export async function deleteLiveKitRoom(opts: {
  roomName: string;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const roomClient = new RoomServiceClient(
      opts.livekitUrl,
      opts.livekitApiKey,
      opts.livekitApiSecret,
    );
    await roomClient.deleteRoom(opts.roomName);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "deleteRoom failed";
    console.warn("[voipCallLogs] deleteRoom failed", message);
    return { ok: false, error: message };
  }
}

export async function terminateVoipSession(
  client: SupabaseClient,
  opts: {
    callId: string;
    endReason: string;
    status?: string;
    livekitUrl?: string;
    livekitApiKey?: string;
    livekitApiSecret?: string;
  },
): Promise<{ ok: boolean; alreadyTerminal: boolean }> {
  const { data: log } = await client
    .from("voip_call_logs")
    .select(
      "id, status, started_at, connected_at, ended_at, room_name, expires_at, trip_id, driver_id, customer_id",
    )
    .eq("id", opts.callId)
    .maybeSingle();

  if (!log) return { ok: false, alreadyTerminal: false };
  if (log.ended_at || !["requested", "ringing", "connecting", "active"].includes(log.status)) {
    return { ok: true, alreadyTerminal: true };
  }

  await client
    .from("voip_call_logs")
    .update({ termination_attempted_at: new Date().toISOString() })
    .eq("id", opts.callId)
    .is("termination_attempted_at", null);

  if (log.room_name && opts.livekitUrl && opts.livekitApiKey && opts.livekitApiSecret) {
    await deleteLiveKitRoom({
      roomName: log.room_name,
      livekitUrl: opts.livekitUrl,
      livekitApiKey: opts.livekitApiKey,
      livekitApiSecret: opts.livekitApiSecret,
    });
  }

  const baseMs = new Date(log.connected_at ?? log.started_at).getTime();
  const duration = capDurationSeconds(
    Math.floor((Date.now() - baseMs) / 1000),
    TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
  );

  await finalizeVoipCallLog(client, opts.callId, {
    duration_seconds: duration,
    end_reason: opts.endReason,
    status: opts.status,
  });

  // Best-effort timeout/end notify — never blocks termination.
  try {
    const { sendCallEndedPush } = await import("./incomingCallPush.ts");
    let customerUserId: string | null = null;
    if (log.customer_id) {
      const { data: cust } = await client
        .from("customers")
        .select("user_id")
        .or(`id.eq.${log.customer_id},user_id.eq.${log.customer_id}`)
        .limit(1)
        .maybeSingle();
      customerUserId = cust?.user_id ?? String(log.customer_id);
    }
    const pushTask = sendCallEndedPush(client, {
      tripId: String(log.trip_id ?? ""),
      callId: opts.callId,
      method: "voip",
      endReason: opts.endReason,
      driverId: log.driver_id,
      customerUserId,
    });
    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(pushTask);
    } else {
      pushTask.catch(() => {});
    }
  } catch {
    // ignore notify failures
  }

  return { ok: true, alreadyTerminal: false };
}

/** Bounded sweep of expired VoIP sessions. Idempotent. */
export async function sweepExpiredVoipSessions(
  client: SupabaseClient,
  opts: {
    livekitUrl: string;
    livekitApiKey: string;
    livekitApiSecret: string;
    limit?: number;
  },
): Promise<{ scanned: number; terminated: number }> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const nowIso = new Date().toISOString();

  const { data: rows } = await client
    .from("voip_call_logs")
    .select("id")
    .is("ended_at", null)
    .in("status", ["requested", "ringing", "connecting", "active"])
    .lte("expires_at", nowIso)
    .order("expires_at", { ascending: true })
    .limit(limit);

  let terminated = 0;
  for (const row of rows ?? []) {
    const result = await terminateVoipSession(client, {
      callId: row.id,
      endReason: VOIP_END_REASON.MAX_DURATION,
      status: "timed_out",
      livekitUrl: opts.livekitUrl,
      livekitApiKey: opts.livekitApiKey,
      livekitApiSecret: opts.livekitApiSecret,
    });
    if (result.ok && !result.alreadyTerminal) terminated += 1;
  }

  return { scanned: rows?.length ?? 0, terminated };
}

/**
 * Best-effort waitUntil timer — not authoritative.
 * Authoritative enforcement is expires_at + timeout sweep + webhook.
 */
export function scheduleVoipMaxDurationEnforcement(
  client: SupabaseClient,
  opts: {
    logId: string;
    roomName: string;
    maxSeconds?: number;
    livekitUrl: string;
    livekitApiKey: string;
    livekitApiSecret: string;
  },
) {
  const maxSeconds = opts.maxSeconds ?? TRIP_COMMUNICATION_MAX_DURATION_SECONDS;
  const task = async () => {
    await new Promise((resolve) => setTimeout(resolve, maxSeconds * 1000));
    await terminateVoipSession(client, {
      callId: opts.logId,
      endReason: VOIP_END_REASON.MAX_DURATION,
      status: "timed_out",
      livekitUrl: opts.livekitUrl,
      livekitApiKey: opts.livekitApiKey,
      livekitApiSecret: opts.livekitApiSecret,
    });
  };

  // @ts-ignore Supabase edge runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(task());
  } else {
    task().catch((error) => console.error("[voipCallLogs] enforcement error", error));
  }
}
