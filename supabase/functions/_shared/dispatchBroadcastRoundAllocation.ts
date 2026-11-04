/**
 * Broadcast-round allocation SSOT: keep (trip_id, driver_id, broadcast_round)
 * unique across scheduled broadcast → rematch → convert-to-instant → instant waves.
 */

import { resolveDispatchBroadcastRound } from "./dispatchSearchWindow.ts";
import {
  maxBroadcastRoundFromOfferRows,
  resolveNextRematchBroadcastRound,
} from "./driverCancelRematch.ts";

export { maxBroadcastRoundFromOfferRows };

/** Conversion trip stamp: same cycle-end anchor as driver-cancel rematch. */
export function resolveConversionBroadcastRoundAnchor(
  maxExistingBroadcastRound: number | null | undefined,
): number {
  return resolveNextRematchBroadcastRound(maxExistingBroadcastRound);
}

/**
 * Next absolute sequence for auto-dispatch that cannot collide with existing
 * ride_offers.(trip_id, driver_id, broadcast_round) rows.
 *
 * When history already occupies the naive next sequence, jump to W1 of the next
 * 3-wave cycle (same rematch/convert alignment).
 */
export function resolveUniqueDispatchBroadcastRound(params: {
  storedRound: number;
  maxExistingOfferRound: number;
  maxRounds: number;
  forceRebroadcast: boolean;
  searchWindowActive: boolean;
}): number {
  const resolved = resolveDispatchBroadcastRound({
    storedRound: params.storedRound,
    maxRounds: params.maxRounds,
    forceRebroadcast: params.forceRebroadcast,
    searchWindowActive: params.searchWindowActive,
  });
  const maxExisting = Math.max(0, Math.floor(params.maxExistingOfferRound || 0));
  if (maxExisting < resolved) {
    return resolved;
  }
  const anchor = resolveConversionBroadcastRoundAnchor(maxExisting);
  const next = Math.max(resolved, anchor + 1);
  const maxSequences = Math.max(1, Math.floor(params.maxRounds));
  return Math.min(next, maxSequences);
}
