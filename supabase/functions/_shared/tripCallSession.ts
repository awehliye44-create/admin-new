/**
 * Provider-neutral trip call session adapter over voip_call_logs + call_masking_call_logs.
 * Never returns secrets, room names, phone numbers, or provider session IDs to clients.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  TRIP_COMMUNICATION_ACTIVE_STATUSES,
  TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
  type TripCommunicationActiveCallProjection,
  type TripCommunicationCallStatus,
  type TripCommunicationMethodType,
} from "../../../shared/tripCommunicationSsot.ts";
import {
  mapMaskingLogStatus,
  mapVoipLogStatus,
  isTerminalCallStatus,
} from "./tripCallStatus.ts";

export type ProviderNeutralCallSession = {
  callId: string;
  tripId: string;
  serviceAreaId: string | null;
  method: TripCommunicationMethodType;
  provider: "livekit" | "msg91";
  status: TripCommunicationCallStatus;
  startedAt: string | null;
  connectedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  endReason: string | null;
  /** Server-only — never project to clients. */
  roomName: string | null;
  initiatorRole: "driver" | "customer" | null;
  incomingPushSentAt: string | null;
};

const VOIP_ACTIVE_STATUSES = ["requested", "ringing", "connecting", "active"] as const;

function remainingSeconds(expiresAt: string | null, nowMs = Date.now()): number | null {
  if (!expiresAt) return null;
  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return null;
  return Math.max(0, Math.floor((expiresMs - nowMs) / 1000));
}

export function toActiveCallProjection(
  session: ProviderNeutralCallSession,
  nowMs = Date.now(),
): TripCommunicationActiveCallProjection | null {
  if (isTerminalCallStatus(session.status)) return null;

  const remaining = remainingSeconds(session.expiresAt, nowMs);
  const expired = remaining !== null && remaining <= 0;
  if (expired) {
    // Present as not joinable; sweep will mark timed_out.
    return {
      call_id: session.callId,
      method: session.method,
      provider: session.provider,
      status: "timed_out",
      started_at: session.startedAt,
      connected_at: session.connectedAt,
      expires_at: session.expiresAt,
      remaining_seconds: 0,
      join_allowed: false,
      end_allowed: false,
    };
  }

  const joinAllowed = TRIP_COMMUNICATION_ACTIVE_STATUSES.has(session.status) &&
    session.status !== "active"
      ? true
      : session.status === "active";

  return {
    call_id: session.callId,
    method: session.method,
    provider: session.provider,
    status: session.status,
    started_at: session.startedAt,
    connected_at: session.connectedAt,
    expires_at: session.expiresAt,
    remaining_seconds: remaining,
    join_allowed: joinAllowed && !expired,
    end_allowed: TRIP_COMMUNICATION_ACTIVE_STATUSES.has(session.status) && !expired,
  };
}

function mapVoipRow(row: Record<string, unknown>): ProviderNeutralCallSession {
  return {
    callId: String(row.id),
    tripId: String(row.trip_id),
    serviceAreaId: row.service_area_id ? String(row.service_area_id) : null,
    method: "voip",
    provider: "livekit",
    status: mapVoipLogStatus(String(row.status ?? "active")),
    startedAt: row.started_at ? String(row.started_at) : null,
    connectedAt: row.connected_at ? String(row.connected_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    endedAt: row.ended_at ? String(row.ended_at) : null,
    durationSeconds: typeof row.duration_seconds === "number" ? row.duration_seconds : null,
    endReason: row.end_reason ? String(row.end_reason) : null,
    roomName: row.room_name ? String(row.room_name) : null,
    initiatorRole: row.initiator_role === "driver" || row.initiator_role === "customer"
      ? row.initiator_role
      : null,
    incomingPushSentAt: row.incoming_push_sent_at
      ? String(row.incoming_push_sent_at)
      : null,
  };
}

function mapMaskingRow(row: Record<string, unknown>): ProviderNeutralCallSession {
  return {
    callId: String(row.id),
    tripId: String(row.booking_id ?? ""),
    serviceAreaId: null,
    method: "call_masking",
    provider: "msg91",
    status: mapMaskingLogStatus(String(row.status ?? "active"), row.disconnect_reason),
    startedAt: row.call_start ? String(row.call_start) : null,
    connectedAt: row.connected_at
      ? String(row.connected_at)
      : (row.call_start ? String(row.call_start) : null),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    endedAt: row.call_end ? String(row.call_end) : null,
    durationSeconds: typeof row.duration_seconds === "number" ? row.duration_seconds : null,
    endReason: row.disconnect_reason ? String(row.disconnect_reason) : null,
    roomName: null,
    initiatorRole: null,
    incomingPushSentAt: null,
  };
}

/** Load the single active provider-neutral call for a trip, if any. */
export async function findActiveCallForTrip(
  client: SupabaseClient,
  tripId: string,
): Promise<ProviderNeutralCallSession | null> {
  const { data: voipRows } = await client
    .from("voip_call_logs")
    .select(
      "id, trip_id, service_area_id, status, started_at, connected_at, expires_at, ended_at, duration_seconds, end_reason, room_name, initiator_role, incoming_push_sent_at",
    )
    .eq("trip_id", tripId)
    .is("ended_at", null)
    .in("status", [...VOIP_ACTIVE_STATUSES])
    .order("started_at", { ascending: false })
    .limit(1);

  const voip = voipRows?.[0];
  if (voip) return mapVoipRow(voip);

  const { data: maskingRows } = await client
    .from("call_masking_call_logs")
    .select(
      "id, booking_id, status, call_start, call_end, connected_at, expires_at, duration_seconds, disconnect_reason",
    )
    .eq("booking_id", tripId)
    .eq("status", "active")
    .is("call_end", null)
    .order("call_start", { ascending: false })
    .limit(1);

  const masking = maskingRows?.[0];
  if (masking) return mapMaskingRow(masking);
  return null;
}

export async function findVoipCallById(
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
  return data ? mapVoipRow(data) : null;
}

export async function findVoipCallByRoomName(
  client: SupabaseClient,
  roomName: string,
): Promise<ProviderNeutralCallSession | null> {
  const { data } = await client
    .from("voip_call_logs")
    .select(
      "id, trip_id, service_area_id, status, started_at, connected_at, expires_at, ended_at, duration_seconds, end_reason, room_name, initiator_role, incoming_push_sent_at",
    )
    .eq("room_name", roomName)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? mapVoipRow(data) : null;
}

export function computeExpiresAtFromConnected(connectedAtIso: string): string {
  const base = new Date(connectedAtIso).getTime();
  return new Date(base + TRIP_COMMUNICATION_MAX_DURATION_SECONDS * 1000).toISOString();
}

export function computeProvisionalExpiresAt(startedAtIso: string): string {
  // Safety net for never-connected sessions — same 240s constant, not a second policy.
  return computeExpiresAtFromConnected(startedAtIso);
}

export function capDurationSeconds(
  duration: number,
  max = TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
): number {
  return Math.min(max, Math.max(0, Math.floor(duration)));
}

export function opaqueVoipRoomName(): string {
  return `onecab-call-${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Call-scoped opaque LiveKit identity.
 * Uses HMAC of callId+role so raw call UUIDs are not exposed in the room.
 * Sync fallback keeps role-scoped form when secret is unavailable (should not happen in Edge).
 */
export async function voipParticipantIdentity(
  callId: string,
  role: "driver" | "customer",
  hmacSecret?: string | null,
): Promise<string> {
  const secret = hmacSecret?.trim() ||
    Deno.env.get("LIVEKIT_API_SECRET")?.trim() ||
    Deno.env.get("TRIP_CALL_IDENTITY_HMAC_SECRET")?.trim() ||
    "";
  if (!secret) {
    return `trip-call:${callId}:${role}`;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${callId}:${role}`),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
  return `tc:${role}:${hex}`;
}

/**
 * Short-lived join token TTL: enough to connect/reconnect, not a full call window.
 * Never exceeds remaining session window by more than a small grace.
 */
export function voipJoinTokenTtlSeconds(input: {
  expiresAt: string | null;
  nowMs?: number;
}): number {
  const nowMs = input.nowMs ?? Date.now();
  const JOIN_GRACE_SECONDS = 90;
  const MAX_JOIN_TTL = 120;
  if (!input.expiresAt) return MAX_JOIN_TTL;
  const remaining = remainingSeconds(input.expiresAt, nowMs) ?? 0;
  if (remaining <= 0) return 0;
  return Math.max(30, Math.min(MAX_JOIN_TTL, remaining + JOIN_GRACE_SECONDS));
}
