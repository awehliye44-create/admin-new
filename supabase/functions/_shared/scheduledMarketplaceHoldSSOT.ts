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
  "publication_exhausted",
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
 * Defensive publication gate for the EXISTING airport charge SSOT
 * (Admin → Custom Zones → Route Pricing per vehicle category → quote →
 * `airport_charge_pence` persist via `airportChargeFareSplitSSOT` /
 * `decideDispatchAfterFareEnrich`).
 *
 * Phase 3 does NOT invent airport pricing, duplicate charge fields, or require
 * manual approval for normal scheduled bookings.
 *
 * Blocks only when a genuine required-charge persist failure was stamped:
 * - `scheduled_hold_reason = airport_pricing` (post-commit when quote > 0 failed
 *   to persist — see `decideDispatchAfterFareEnrich` `airport_persist_failed`), or
 * - legacy latch: `broadcast_enabled = false` AND a positive `airport_charge_pence`
 *   is present but broadcast was never reopened.
 *
 * Valid zero airport charge / routes with no applicable airport charge → ok
 * (parity with `decideDispatchAfterFareEnrich` `airport_absent`).
 */
export function assertAirportPricingReady(input: {
  broadcastEnabled?: boolean | null;
  airportChargePence?: number | null;
  scheduledHoldReason?: string | null;
}): { ok: true } | { ok: false; reason: "airport_pricing_hold" } {
  const holdReason = String(input.scheduledHoldReason ?? "").trim().toLowerCase();
  if (holdReason === "airport_pricing") {
    return { ok: false, reason: "airport_pricing_hold" };
  }

  if (input.broadcastEnabled === false) {
    const raw = input.airportChargePence;
    if (raw == null) {
      // Absent charge + no airport_pricing stamp → not an airport pricing hold.
      return { ok: true };
    }
    const pence = Math.round(Number(raw));
    if (!Number.isFinite(pence) || pence <= 0) {
      // Valid zero must never trigger a pricing hold.
      return { ok: true };
    }
    // Positive charge still latched off broadcast → incomplete reopen after persist.
    return { ok: false, reason: "airport_pricing_hold" };
  }

  return { ok: true };
}

export function isAutoPublishEligibleHoldReason(
  reason: ScheduledHoldReason | null | undefined,
): boolean {
  if (reason == null) return false; // unknown historical / unset → fail closed
  return (AUTO_PUBLISH_ELIGIBLE_HOLD_REASONS as readonly string[]).includes(reason);
}

