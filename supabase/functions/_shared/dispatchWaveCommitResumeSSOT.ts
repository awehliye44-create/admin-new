/**
 * MK-261106-007: after VERSION_MISMATCH / OFFER_CREATE_UNIQUE_COLLISION, keep the
 * trip rebroadcast-eligible and never strand current_broadcast_round at 0 while
 * offer history or an attempted sequence proves progress.
 *
 * Admin Max Dispatch Rounds / wave sizes / find-time TTL stay authoritative —
 * this only recovers concurrency races.
 */

import {
  DISPATCH_STATUS_OFFER_CREATE_BLOCKED,
  STALE_TRIP_REBROADCAST_DISPATCH_STATUS,
  DEFAULT_MAX_BROADCAST_SEQUENCES,
} from "./sweepExpiredOffers.ts";

export const COMMIT_DISPATCH_WAVE_VERSION_MISMATCH = "VERSION_MISMATCH" as const;

export function isCommitDispatchWaveVersionMismatch(error: unknown): boolean {
  const text = (() => {
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const record = error as { message?: unknown; code?: unknown; error?: unknown };
      return [record.message, record.code, record.error].filter(Boolean).join(" ");
    }
    return String(error ?? "");
  })();
  return /VERSION_MISMATCH/i.test(text);
}

/** SQLSTATEs / message prefix raised by tr_ride_offer_financial_invariant_guard_fn (20270222160000/170000). */
export const FINANCIAL_OFFER_INVARIANT_REASON = "FINANCIAL_OFFER_INVARIANT" as const;

/**
 * True when commit_dispatch_wave (or any offer insert) was rejected by the DB financial offer
 * invariant guard: FO001 (stale / fabricated / wrong-commission / airport) or FO002 (no
 * verifiable financial snapshot). The wave transaction is rolled back, so nothing is half-written.
 *
 * Recovery is NOT a new retry mechanism: auto-dispatch stamps the SAME resumable state it uses for a
 * unique-round collision (tripPatchAfterTransientOfferCreateFailure) so expire-offers resumes the trip
 * while the round budget and searching_expires_at remain, and expire_trip_when_search_exhausted ends the
 * search through the normal path afterwards. A guard rejection never releases a payment hold itself and
 * never leaves the trip with broadcast_enabled=false (which would make that terminal path return false).
 */
export function isFinancialOfferInvariantError(error: unknown): boolean {
  const text = (() => {
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const record = error as { message?: unknown; code?: unknown; error?: unknown; details?: unknown };
      return [record.message, record.code, record.error, record.details].filter(Boolean).join(" ");
    }
    return String(error ?? "");
  })();
  return /FINANCIAL_OFFER_INVARIANT|\bFO00[12]\b/.test(text);
}

/** Effective round stamp for resume — never prefer a stranded 0 over offer history. */
export function effectiveBroadcastRoundForResume(input: {
  storedRound: number | null | undefined;
  maxExistingOfferRound: number | null | undefined;
  attemptedBroadcastRound?: number | null | undefined;
}): number {
  const stored = Math.max(0, Math.floor(Number(input.storedRound) || 0));
  const existing = Math.max(0, Math.floor(Number(input.maxExistingOfferRound) || 0));
  const attempted = Math.max(0, Math.floor(Number(input.attemptedBroadcastRound) || 0));
  return Math.max(stored, existing, attempted);
}

/**
 * After a unique-collision or version race: stay on broadcasting (not permanent
 * offer_create_blocked) and stamp a non-zero round so expire-offers can resume.
 */
export function tripPatchAfterTransientOfferCreateFailure(input: {
  nowIso: string;
  storedRound: number;
  maxExistingOfferRound: number;
  attemptedBroadcastRound: number;
}): {
  dispatch_status: typeof STALE_TRIP_REBROADCAST_DISPATCH_STATUS;
  broadcast_enabled: true;
  current_broadcast_round: number;
  updated_at: string;
} {
  const current_broadcast_round = effectiveBroadcastRoundForResume(input);
  return {
    dispatch_status: STALE_TRIP_REBROADCAST_DISPATCH_STATUS,
    broadcast_enabled: true,
    current_broadcast_round: Math.max(1, current_broadcast_round),
    updated_at: input.nowIso,
  };
}

export type StaleTripRebroadcastCandidateV2 = {
  dispatch_status: string | null;
  current_broadcast_round: number | null;
  max_broadcast_rounds: number | null;
  pending_offer_count: number;
  /** Max ride_offers.broadcast_round when known (0 if none / unknown). */
  max_existing_offer_round?: number | null;
  searching_expires_at?: string | null;
  nowMs?: number;
};

function searchWindowStillOpen(trip: StaleTripRebroadcastCandidateV2): boolean {
  const raw = trip.searching_expires_at;
  if (raw == null || String(raw).trim() === "") return true; // unknown → allow resume
  const deadline = Date.parse(String(raw));
  if (!Number.isFinite(deadline)) return true;
  const now = typeof trip.nowMs === "number" ? trip.nowMs : Date.now();
  return deadline > now;
}

/**
 * expire-offers stale scan: resume while TTL remains and no pending offers,
 * including stranded round=0 after convert/collision when offer history exists,
 * and recover legacy offer_create_blocked rows.
 */
export function isStaleTripRebroadcastCandidateV2(
  trip: StaleTripRebroadcastCandidateV2,
): boolean {
  if (trip.pending_offer_count !== 0) return false;
  if (!searchWindowStillOpen(trip)) return false;

  const status = String(trip.dispatch_status ?? "");
  const resumableStatus =
    status === STALE_TRIP_REBROADCAST_DISPATCH_STATUS
    || status === DISPATCH_STATUS_OFFER_CREATE_BLOCKED;
  if (!resumableStatus) return false;

  const maxRounds = trip.max_broadcast_rounds ?? DEFAULT_MAX_BROADCAST_SEQUENCES;
  const effective = effectiveBroadcastRoundForResume({
    storedRound: trip.current_broadcast_round,
    maxExistingOfferRound: trip.max_existing_offer_round ?? 0,
  });

  // Still under configured sequence budget (Admin rounds × 3, typically 9).
  if (effective >= maxRounds) return false;

  // Progress exists (stored or offer history) — including stranded 0 + history.
  if (effective <= 0 && (trip.max_existing_offer_round ?? 0) <= 0) return false;
  return true;
}

/** Terminal / assigned / cancelled / expired must never resume. */
export function shouldBlockDispatchResumeForTripStatus(status: string | null | undefined): boolean {
  const s = String(status ?? "").toLowerCase();
  return [
    "completed",
    "cancelled",
    "customer_cancelled",
    "driver_cancelled",
    "no_show",
    "expired",
    "expired_no_driver",
    "accepted",
    "driver_assigned",
    "en_route",
    "arrived",
    "in_progress",
    "waiting",
  ].includes(s);
}
