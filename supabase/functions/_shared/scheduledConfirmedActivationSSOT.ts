/**
 * Phase 4 — confirmed scheduled → live pickup activation SSOT.
 *
 * Default execution mode is ack_nro (exclusive activation offer + Driver Accept).
 * Direct en_route patches are only used when jit_auto_activate_enabled=true
 * (ops override). Phase 5 will insert a 45s arm_ack before activate_now.
 *
 * Do not add countdown / Heading-to-Pickup UI here.
 */

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
  activationSource: "jit" | "fixed_fallback";
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
 * Phase 5 boundary marker — documents the future ack arm without implementing it.
 * Phase 4 callers must never treat this as an executable path.
 */
export const PHASE5_ACK_BOUNDARY = {
  reservedAction: "arm_ack" as const,
  countdownSeconds: 45,
  note:
    "Phase 5 only: urgent audible alert + Heading to Pickup / Cancel + timeout = cancel. Phase 4 default remains arm_exclusive_nro.",
};

/** Patch for ack-safe arm (existing exclusive NRO path). */
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
