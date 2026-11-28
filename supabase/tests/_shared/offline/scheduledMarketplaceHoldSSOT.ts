/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Phase 3 gap closure — authoritative scheduled marketplace hold reasons.
 *
 * Additive column trips.scheduled_hold_reason (migration).
 * Automatic recovery may ONLY clear/publish eligible reasons.
 */

import { resolveConversionBroadcastEnabled } from "../../../functions/_shared/scheduledDispatchConfig.ts";
import { ScheduledHoldReason, normaliseScheduledHoldReason, assertAirportPricingReady } from "../../../functions/_shared/scheduledMarketplaceHoldSSOT.ts";


/** Reasons that must never be auto-released. */
export const AUTO_PUBLISH_BLOCKED_HOLD_REASONS: readonly ScheduledHoldReason[] = [
  "publication_exhausted",
  "airport_pricing",
  "payment_gate",
  "manual_trip",
  "admin_exceptional",
  "unknown_historical",
];


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
    scheduledHoldReason: input.scheduledHoldReason,
  });

  if (!airport.ok || reason === "airport_pricing") {
    return { class: "airport_pricing", autoPublishEligible: false, proposedAction: "skip" };
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

export * from "../../../functions/_shared/scheduledMarketplaceHoldSSOT.ts";
