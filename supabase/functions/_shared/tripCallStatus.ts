/**
 * Provider-neutral status mapping for LiveKit VoIP and MSG91 call masking.
 * Clients never see raw provider statuses.
 */
import type { TripCommunicationCallStatus } from "../../../shared/tripCommunicationSsot.ts";
import { TRIP_COMMUNICATION_ACTIVE_STATUSES } from "../../../shared/tripCommunicationSsot.ts";

const TERMINAL: ReadonlySet<TripCommunicationCallStatus> = new Set([
  "completed",
  "declined",
  "missed",
  "cancelled",
  "failed",
  "timed_out",
]);

export function isTerminalCallStatus(status: TripCommunicationCallStatus): boolean {
  return TERMINAL.has(status);
}

export function isActiveCallStatus(status: TripCommunicationCallStatus): boolean {
  return TRIP_COMMUNICATION_ACTIVE_STATUSES.has(status);
}

/** Map voip_call_logs.status (+ end_reason hints) → neutral status. */
export function mapVoipLogStatus(
  status: string,
  endReason?: string | null,
): TripCommunicationCallStatus {
  const s = status.trim().toLowerCase();
  if (
    s === "requested" ||
    s === "ringing" ||
    s === "connecting" ||
    s === "active" ||
    s === "completed" ||
    s === "declined" ||
    s === "missed" ||
    s === "cancelled" ||
    s === "failed" ||
    s === "timed_out"
  ) {
    return s;
  }

  const reason = (endReason ?? "").toUpperCase();
  if (reason.includes("DURATION") || reason.includes("TIMED_OUT") || reason === "CALL_DURATION_LIMIT_REACHED") {
    return "timed_out";
  }
  if (s === "disconnected") {
    if (reason === "CLIENT_ENDED" || reason === "CALL_COMPLETED" || reason === "ROOM_DELETED") {
      return "completed";
    }
    if (reason === "SUPERSEDED") return "cancelled";
    return "failed";
  }
  return "failed";
}

/** Map call_masking_call_logs.status → neutral status. */
export function mapMaskingLogStatus(
  status: string,
  disconnectReason?: unknown,
): TripCommunicationCallStatus {
  const s = status.trim().toLowerCase();
  if (s === "active") return "active";
  if (s === "completed") return "completed";
  if (s === "timed_out") return "timed_out";

  const reason = String(disconnectReason ?? "").toUpperCase();
  if (reason.includes("DURATION") || reason === "CALL_DURATION_LIMIT_REACHED") {
    return "timed_out";
  }
  if (s === "disconnected") {
    if (reason.includes("CANCEL")) return "cancelled";
    if (reason.includes("MISS") || reason.includes("NO_ANSWER")) return "missed";
    if (reason.includes("DECLIN")) return "declined";
    return "completed";
  }
  return mapVoipLogStatus(s, reason);
}

/** LiveKit webhook event → status hints (idempotent apply happens in webhook handler). */
export function mapLiveKitWebhookEventType(
  eventType: string,
):
  | "room_started"
  | "participant_joined"
  | "participant_left"
  | "room_finished"
  | "track_published"
  | "other" {
  switch (eventType) {
    case "room_started":
      return "room_started";
    case "participant_joined":
      return "participant_joined";
    case "participant_left":
      return "participant_left";
    case "room_finished":
      return "room_finished";
    case "track_published":
      return "track_published";
    default:
      return "other";
  }
}
