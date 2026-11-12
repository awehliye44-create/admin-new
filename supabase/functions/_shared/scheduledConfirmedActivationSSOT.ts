/**
 * Confirmed scheduled → live pickup activation SSOT.
 *
 * Phase 5: departure acknowledgement (Heading to Pickup) stamps en_route.
 * Direct no-ack en_route is forbidden — buildConfirmedActivationPatch is only
 * used after successful acknowledgement (or legacy start_journey alias).
 */

import {
  buildDepartureAckArmPatch,
  PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS,
} from "./scheduledDepartureAckSSOT.ts";

export const CONFIRMED_ACTIVATION_FROM_STATUSES = [
  "driver_assigned",
  "scheduled_committed",
  "scheduled",
  "awaiting_activation_accept",
] as const;

export type ConfirmedActivationPatch = {
  driver_id: string;
  status: "en_route_to_pickup";
  scheduled_status: "driver_en_route";
  driver_checked_in_at: string;
  updated_at: string;
  scheduled_jit_activated_at: string;
  scheduled_jit_activation_source: string;
};

export function buildConfirmedActivationPatch(input: {
  confirmedDriverId: string;
  nowIso: string;
  existingCheckedInAt?: string | null;
  activationSource: "jit" | "fixed_fallback" | "departure_ack";
}): ConfirmedActivationPatch {
  return {
    driver_id: input.confirmedDriverId,
    status: "en_route_to_pickup",
    scheduled_status: "driver_en_route",
    driver_checked_in_at: input.existingCheckedInAt ?? input.nowIso,
    updated_at: input.nowIso,
    scheduled_jit_activated_at: input.nowIso,
    scheduled_jit_activation_source: input.activationSource,
  };
}

/** Idempotent success when already live on the confirmed assignment. */
export function isAlreadyConfirmedActivated(input: {
  scheduledStatus: string | null | undefined;
  tripStatus: string | null | undefined;
  driverId: string | null | undefined;
  confirmedDriverId: string | null | undefined;
}): boolean {
  const sched = String(input.scheduledStatus ?? "").trim().toLowerCase();
  const status = String(input.tripStatus ?? "").trim().toLowerCase();
  const driver = String(input.driverId ?? "").trim();
  const confirmed = String(input.confirmedDriverId ?? "").trim();
  if (!confirmed || (driver && driver !== confirmed)) return false;
  return sched === "driver_en_route" || status === "en_route_to_pickup";
}

/**
 * Phase 5 live boundary — urgent audible alert + Heading to Pickup / Cancel.
 * Countdown expiry ≡ Cancel Booking → exclusive rescue → instant dispatch.
 */
export const PHASE5_ACK_BOUNDARY = {
  reservedAction: "arm_ack" as const,
  countdownSeconds: PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS,
  headingToPickupAction: "heading_to_pickup" as const,
  cancelBookingAction: "cancel_booking" as const,
  timeoutReason: "acknowledgement_timeout" as const,
  note:
    "Phase 5: urgent audible alert + Heading to Pickup / Cancel. Timeout = cancel + exclude + instant dispatch. Never stamp driver_en_route before acknowledgement.",
};

/** Phase 4-compatible arm (status only). Prefer buildDepartureAckArmPatch in Phase 5. */
export function buildExclusiveActivationArmPatch(input: {
  nowIso: string;
}): {
  scheduled_status: "awaiting_activation_accept";
  updated_at: string;
} {
  return {
    scheduled_status: "awaiting_activation_accept",
    updated_at: input.nowIso,
  };
}

export { buildDepartureAckArmPatch };
