/**
 * Phase 3 gap closure — authoritative scheduled marketplace hold reasons.
 *
 * Additive column trips.scheduled_hold_reason (migration).
 * Automatic recovery may ONLY clear/publish eligible reasons.
 */

import { resolveConversionBroadcastEnabled } from "./scheduledDispatchConfig.ts";

export const SCHEDULED_HOLD_REASONS = [
  "publication_pending",
  "publication_retry",
  "airport_pricing",
  "payment_gate",
  "manual_trip",
  "admin_exceptional",
  "unknown_historical",
] as const;

export type ScheduledHoldReason = (typeof SCHEDULED_HOLD_REASONS)[number];

/** Reasons automatic recovery / post-commit may publish. */
export const AUTO_PUBLISH_ELIGIBLE_HOLD_REASONS: readonly ScheduledHoldReason[] = [
  "publication_pending",
  "publication_retry",
];

/** Reasons that must never be auto-released. */
export const AUTO_PUBLISH_BLOCKED_HOLD_REASONS: readonly ScheduledHoldReason[] = [
  "airport_pricing",
  "payment_gate",
  "manual_trip",
  "admin_exceptional",
  "unknown_historical",
];

export function normaliseScheduledHoldReason(
  raw: unknown,
): ScheduledHoldReason | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return null;
  return (SCHEDULED_HOLD_REASONS as readonly string[]).includes(v)
    ? (v as ScheduledHoldReason)
    : "unknown_historical";
}

/**
 * Airport / mandatory pricing readiness for publication, conversion, broadcast.
 * When broadcast_enabled is false, treat as unresolved mandatory pricing hold.
 * Ordinary non-airport trips leave broadcast_enabled true/null → ok.
 */
export function assertAirportPricingReady(input: {
  broadcastEnabled?: boolean | null;
  airportChargePence?: number | null;
}): { ok: true } | { ok: false; reason: "airport_pricing_hold" } {
  if (input.broadcastEnabled === false) {
    return { ok: false, reason: "airport_pricing_hold" };
  }
  return { ok: true };
}

/**
 * Never force-open broadcast while airport pricing hold is active.
 * forceOpen is ignored when currentBroadcastEnabled === false.
 */
export function resolveSafeBroadcastEnabled(input: {
  currentBroadcastEnabled?: boolean | null;
  forceOpen?: boolean;
}): boolean {
  if (input.currentBroadcastEnabled === false) return false;
  return resolveConversionBroadcastEnabled({
    currentBroadcastEnabled: input.currentBroadcastEnabled,
    forceOpen: input.forceOpen === true,
  });
}

export function isAutoPublishEligibleHoldReason(
  reason: ScheduledHoldReason | null | undefined,
): boolean {
  if (reason == null) return false; // unknown historical / unset → fail closed
  return (AUTO_PUBLISH_ELIGIBLE_HOLD_REASONS as readonly string[]).includes(reason);
}

export function classifyAuthoritativeHold(input: {
  scheduledHoldReason?: string | null;
  scheduledStatus?: string | null;
  scheduledBroadcastAt?: string | null;
  broadcastEnabled?: boolean | null;
  airportChargePence?: number | null;
  pendingReleaseKind?: string | null;
  bookingSource?: string | null;
  driverId?: string | null;
  confirmedDriverId?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  status?: string | null;
  nowMs?: number;
}): {
  class: ScheduledHoldReason | "already_published" | "already_assigned" | "terminal" | "clear";
  autoPublishEligible: boolean;
  proposedAction: "auto_publish" | "skip" | "review" | "already_ok";
} {
  const status = String(input.status ?? "").toLowerCase();
  const sched = String(input.scheduledStatus ?? "").toLowerCase();
  if (
    input.completedAt ||
    input.cancelledAt ||
    ["completed", "cancelled", "no_show", "expired", "expired_no_driver"].includes(status) ||
    ["cancelled", "converted_to_instant", "no_driver_found"].includes(sched)
  ) {
    return { class: "terminal", autoPublishEligible: false, proposedAction: "skip" };
  }
  if (input.driverId || input.confirmedDriverId) {
    return { class: "already_assigned", autoPublishEligible: false, proposedAction: "skip" };
  }

  const reason = normaliseScheduledHoldReason(input.scheduledHoldReason);
  const airport = assertAirportPricingReady({
    broadcastEnabled: input.broadcastEnabled,
    airportChargePence: input.airportChargePence,
  });

  if (!airport.ok || reason === "airport_pricing" || sched === "" && input.broadcastEnabled === false) {
    if (!airport.ok || reason === "airport_pricing") {
      return { class: "airport_pricing", autoPublishEligible: false, proposedAction: "skip" };
    }
  }
  if (reason === "payment_gate" || sched === "payment_gate_blocked") {
    return { class: "payment_gate", autoPublishEligible: false, proposedAction: "skip" };
  }
  if (reason === "manual_trip") {
    return { class: "manual_trip", autoPublishEligible: false, proposedAction: "review" };
  }
  if (reason === "admin_exceptional") {
    return { class: "admin_exceptional", autoPublishEligible: false, proposedAction: "review" };
  }
  if (reason === "publication_retry") {
    return { class: "publication_retry", autoPublishEligible: true, proposedAction: "auto_publish" };
  }
  if (reason === "publication_pending") {
    return { class: "publication_pending", autoPublishEligible: true, proposedAction: "auto_publish" };
  }

  const at = input.scheduledBroadcastAt ? Date.parse(String(input.scheduledBroadcastAt)) : NaN;
  const nowMs = input.nowMs ?? Date.now();
  if (
    sched !== "admin_held" &&
    Number.isFinite(at) &&
    at <= nowMs &&
    !input.driverId &&
    !input.confirmedDriverId
  ) {
    return { class: "already_published", autoPublishEligible: false, proposedAction: "already_ok" };
  }

  // Unset reason + held → unknown historical (fail closed)
  if (sched === "admin_held" || !Number.isFinite(at)) {
    return { class: "unknown_historical", autoPublishEligible: false, proposedAction: "review" };
  }

  return { class: "clear", autoPublishEligible: false, proposedAction: "already_ok" };
}

export function buildHoldReasonPatch(
  reason: ScheduledHoldReason | null,
): { scheduled_hold_reason: ScheduledHoldReason | null } {
  return { scheduled_hold_reason: reason };
}
