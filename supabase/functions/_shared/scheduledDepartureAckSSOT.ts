/**
 * Phase 5 — Urgent Scheduled Departure Acknowledgement SSOT.
 *
 * Authoritative acknowledgement window = exactly countdownSeconds (default 45).
 * Heading to Pickup at/after deadline MUST be rejected — no driver-facing grace.
 *
 * scheduled_departure_ack_grace_seconds is DEPRECATED for deadline math and must
 * not extend the driver window. Timeout rescue may run at deadline (same boundary);
 * expire-offers / STEP 1a poll lag is recovery latency, not an ack extension.
 *
 * Heading to Pickup = departure acknowledgement (not a second booking Accept).
 * Cancel / acknowledgement_timeout → exclusive rescue → existing instant dispatch.
 */

export const PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS = 45 as const;

/**
 * @deprecated Not applied to canAcknowledgeDeparture / isDepartureAckTimedOut.
 * Retained for column compat only. Driver window is exactly 45s.
 */
export const PHASE5_DEPARTURE_ACK_GRACE_SECONDS_DEFAULT = 0 as const;

export type ScheduledAckStatus =
  | "pending"
  | "acknowledged"
  | "timed_out"
  | "cancelled"
  | "declined"
  | "superseded";

export const SCHEDULED_DEPARTURE_ACK_REASON = {
  acknowledgementTimeout: "acknowledgement_timeout",
  cancelledByDriver: "departure_ack_cancelled_by_driver",
  declinedImmediate: "departure_ack_declined_immediate",
} as const;

export type DepartureAckConfig = {
  /** Must stay false until compatible Driver OTA adoption is verified. */
  enabled: boolean;
  countdownSeconds: number;
  /**
   * Ignored for ack/timeout math (always treated as 0 for driver window).
   * @deprecated
   */
  graceSeconds: number;
};

export function resolveDepartureAckConfig(
  row: Record<string, unknown> | null | undefined,
): DepartureAckConfig {
  // Fail closed: missing / unset → disabled until rollout enables after OTA adoption.
  const enabledRaw = row?.scheduled_departure_ack_enabled;
  let enabled = false;
  if (typeof enabledRaw === "boolean") enabled = enabledRaw;
  else if (enabledRaw != null && enabledRaw !== "") {
    const v = String(enabledRaw).trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") enabled = true;
  }

  const countdown = parseInt(String(row?.scheduled_departure_ack_seconds ?? ""), 10);
  return {
    enabled,
    countdownSeconds: Number.isFinite(countdown) && countdown > 0
      ? countdown
      : PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS,
    // Never extend the driver window via grace.
    graceSeconds: 0,
  };
}

export function computeDepartureAckDeadlineMs(input: {
  nowMs: number;
  countdownSeconds?: number;
}): number {
  const seconds = Math.max(
    1,
    Math.floor(input.countdownSeconds ?? PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS),
  );
  return input.nowMs + seconds * 1000;
}

/**
 * Timeout rescue may run when server now >= authoritative deadline.
 * No grace extension — poll lag is infrastructure recovery, not driver time.
 */
export function isDepartureAckTimedOut(input: {
  nowMs: number;
  deadlineMs: number | null | undefined;
  /** Ignored — kept for call-site compat. */
  graceSeconds?: number;
}): boolean {
  void input.graceSeconds;
  if (input.deadlineMs == null || !Number.isFinite(input.deadlineMs)) return false;
  return input.nowMs >= input.deadlineMs;
}

/**
 * Heading to Pickup allowed only while now < deadline (strict).
 * Requests at or after deadline are rejected even if expiry worker has not run.
 */
export function canAcknowledgeDeparture(input: {
  nowMs: number;
  deadlineMs: number | null | undefined;
  ackStatus: string | null | undefined;
  /** Ignored — kept for call-site compat. Never extends the window. */
  graceSeconds?: number;
}): boolean {
  void input.graceSeconds;
  const status = String(input.ackStatus ?? "").trim().toLowerCase();
  if (status && status !== "pending") return false;
  if (input.deadlineMs == null || !Number.isFinite(input.deadlineMs)) {
    // Legacy Phase 4 armed rows without ack columns — allow until offer expiry rescue.
    return status === "" || status === "pending";
  }
  return input.nowMs < input.deadlineMs;
}

export function buildDepartureAckArmPatch(input: {
  nowIso: string;
  deadlineIso: string;
  driverId: string;
  nonce: string;
}): {
  scheduled_status: "awaiting_activation_accept";
  scheduled_ack_status: "pending";
  scheduled_ack_deadline_at: string;
  scheduled_ack_armed_at: string;
  scheduled_ack_driver_id: string;
  scheduled_ack_nonce: string;
  scheduled_ack_acknowledged_at: null;
  scheduled_ack_resolved_at: null;
  scheduled_ack_resolution_reason: null;
  updated_at: string;
} {
  return {
    scheduled_status: "awaiting_activation_accept",
    scheduled_ack_status: "pending",
    scheduled_ack_deadline_at: input.deadlineIso,
    scheduled_ack_armed_at: input.nowIso,
    scheduled_ack_driver_id: input.driverId,
    scheduled_ack_nonce: input.nonce,
    scheduled_ack_acknowledged_at: null,
    scheduled_ack_resolved_at: null,
    scheduled_ack_resolution_reason: null,
    updated_at: input.nowIso,
  };
}

export function buildDepartureAckAcknowledgedFields(input: {
  nowIso: string;
}): {
  scheduled_ack_status: "acknowledged";
  scheduled_ack_acknowledged_at: string;
  scheduled_ack_resolved_at: string;
  scheduled_ack_resolution_reason: "heading_to_pickup";
} {
  return {
    scheduled_ack_status: "acknowledged",
    scheduled_ack_acknowledged_at: input.nowIso,
    scheduled_ack_resolved_at: input.nowIso,
    scheduled_ack_resolution_reason: "heading_to_pickup",
  };
}

export function buildDepartureAckTimeoutFields(input: {
  nowIso: string;
  reason?: string;
}): {
  scheduled_ack_status: "timed_out";
  scheduled_ack_resolved_at: string;
  scheduled_ack_resolution_reason: string;
} {
  return {
    scheduled_ack_status: "timed_out",
    scheduled_ack_resolved_at: input.nowIso,
    scheduled_ack_resolution_reason:
      input.reason ?? SCHEDULED_DEPARTURE_ACK_REASON.acknowledgementTimeout,
  };
}

export function buildDepartureAckCancelledFields(input: {
  nowIso: string;
  reason?: string;
}): {
  scheduled_ack_status: "cancelled";
  scheduled_ack_resolved_at: string;
  scheduled_ack_resolution_reason: string;
} {
  return {
    scheduled_ack_status: "cancelled",
    scheduled_ack_resolved_at: input.nowIso,
    scheduled_ack_resolution_reason:
      input.reason ?? SCHEDULED_DEPARTURE_ACK_REASON.cancelledByDriver,
  };
}

/** Soft presence failures that must NOT block Phase 5 arm (offline reconnect window). */
export const DEPARTURE_ACK_SOFT_INELIGIBILITY = new Set([
  "driver_offline",
  "online_intent_false",
  "presence_not_online",
  "stale_heartbeat",
  "missing_presence",
  "stale_location",
  "unreachable",
  "missing_location",
  "no_delivery_channel",
]);

export function isSoftPresenceIneligibilityForDepartureAck(reason: string): boolean {
  return DEPARTURE_ACK_SOFT_INELIGIBILITY.has(String(reason ?? "").trim().toLowerCase());
}
