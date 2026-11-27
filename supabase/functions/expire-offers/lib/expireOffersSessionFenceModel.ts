/**
 * B1 — pure session-fence model (no DB driver).
 * Runtime acquire/release lives in expireOffersSessionFenceSSOT.ts.
 */

/** Stable advisory pair — must match SSOT / migration comment / tests. */
export const EXPIRE_OFFERS_ADVISORY_K1 = 872014001;
export const EXPIRE_OFFERS_ADVISORY_K2 = 1;

/**
 * Pure model of check-to-use safety with session fence vs TTL-only.
 * TTL-only: peer may reclaim after expiry while holder still mutating — unsafe.
 * Session fence: peer blocked for the whole Edge request while holder connection alive.
 */
export function canPeerReclaimWhileHolderAlive(params: {
  holderHasSessionFence: boolean;
  leaseExpired: boolean;
}): { peerMayEnterCriticalSection: boolean } {
  if (params.holderHasSessionFence) {
    return { peerMayEnterCriticalSection: false };
  }
  return { peerMayEnterCriticalSection: params.leaseExpired };
}
