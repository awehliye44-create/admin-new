/**
 * Phase 5 — when to rescue an awaiting_activation_accept trip.
 *
 * Prefer scheduled_ack_deadline_at (+ grace) when armed as departure ack.
 * Legacy Phase 4 rows without ack columns still use open offer expiry.
 */

import { isDepartureAckTimedOut } from "./scheduledDepartureAckSSOT.ts";

export function shouldRescueAwaitingActivation(input: {
  nowMs: number;
  ackStatus?: string | null;
  ackDeadlineAt?: string | null;
  graceSeconds?: number;
  /** True when a pending/offered ride_offer still has expires_at > now. */
  hasOpenLiveOffer: boolean;
}): { rescue: boolean; reason: "acknowledgement_timeout" | "offer_expired" | "wait" } {
  const status = String(input.ackStatus ?? "").trim().toLowerCase();
  const deadlineMs = input.ackDeadlineAt
    ? Date.parse(String(input.ackDeadlineAt))
    : NaN;

  if (status === "pending" && Number.isFinite(deadlineMs)) {
    if (
      isDepartureAckTimedOut({
        nowMs: input.nowMs,
        deadlineMs,
        graceSeconds: input.graceSeconds,
      })
    ) {
      return { rescue: true, reason: "acknowledgement_timeout" };
    }
    // Still within ack window — do not rescue even if offer row missing
    // (offline reconnect / push lag).
    return { rescue: false, reason: "wait" };
  }

  // Legacy Phase 4 / no ack columns: rescue when no live open offer.
  if (input.hasOpenLiveOffer) {
    return { rescue: false, reason: "wait" };
  }
  return { rescue: true, reason: "offer_expired" };
}
