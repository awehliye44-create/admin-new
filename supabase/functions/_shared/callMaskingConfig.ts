/**
 * Runtime max duration SSOT is always 240 seconds.
 * Do not trust service-area DB values for enforcement.
 */
import { TRIP_COMMUNICATION_MAX_DURATION_SECONDS } from "../../../shared/tripCommunicationSsot.ts";

export const DEFAULT_MAX_CALL_DURATION_SEC = TRIP_COMMUNICATION_MAX_DURATION_SECONDS;

/** @deprecated Prefer DEFAULT_MAX_CALL_DURATION_SEC / TRIP_COMMUNICATION_MAX_DURATION_SECONDS. */
export const MAX_CALL_DURATION_SEC = DEFAULT_MAX_CALL_DURATION_SEC;

/** Grace period after trip completion before masking session expires. */
export const POST_COMPLETION_GRACE_MINUTES = 10;

/**
 * Trip statuses that end masking immediately (except `completed`, which gets grace).
 * Keep aligned with customer app `TERMINAL_TRIP_STATUSES` minus `completed`.
 */
export const IMMEDIATE_MASKING_EXPIRY_STATUSES = new Set([
  "cancelled",
  "customer_cancelled",
  "customer_canceled",
  "passenger_cancelled",
  "passenger_canceled",
  "no_show",
  "expired",
  "expired_no_driver",
  "failed",
  "driver_cancelled",
]);

/** Terminal for call initiation — only `completed` retains a grace window. */
export const TERMINAL_TRIP_STATUSES = new Set([
  "completed",
  ...IMMEDIATE_MASKING_EXPIRY_STATUSES,
]);

export const DISCONNECT_REASON = {
  CALL_DURATION_LIMIT_REACHED: "CALL_DURATION_LIMIT_REACHED",
  CALL_COMPLETED: "CALL_COMPLETED",
  CALL_FAILED: "CALL_FAILED",
  CALL_BUSY: "CALL_BUSY",
  CALL_NO_ANSWER: "CALL_NO_ANSWER",
  CALL_CANCELLED: "CALL_CANCELLED",
  TRIP_CANCELLED: "TRIP_CANCELLED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
} as const;

export type DisconnectReason = typeof DISCONNECT_REASON[keyof typeof DISCONNECT_REASON];

/**
 * Trip statuses where call masking is allowed (aligned with shared/tripLifecycle.ts).
 * Must include production aliases: driver_arrived, driver_arriving, trip_started, etc.
 */
export const CALLABLE_TRIP_STATUSES = new Set([
  "accepted",
  "confirmed",
  "driver_assigned",
  "queued",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "enroute_to_pickup",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "driver_arrived",
  "waiting_at_pickup",
  "in_progress",
  "on_trip",
  "started",
  "ongoing",
  "completing",
  "passenger_onboard",
  "trip_started",
]);

export function isCallableTripStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase().replace(/-/g, "_");
  return CALLABLE_TRIP_STATUSES.has(normalized);
}
