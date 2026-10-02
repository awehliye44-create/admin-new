/**
 * STEP 4 no-driver expiry decision for converted scheduled searches.
 * Reuses the existing expire RPC path — does not invent a parallel engine.
 *
 * Gap: searching_expires_at can be null after activate/broadcast/exhaust,
 * leaving past-pickup rides non-terminal forever (Overdue/Pending on Admin).
 */
export function shouldExpireConvertedScheduledNoDriver(input: {
  searchingExpiresAt: string | null | undefined;
  scheduledAt: string | null | undefined;
  nowMs: number;
}): { expire: boolean; reason: string } {
  const nowMs = input.nowMs;
  if (input.searchingExpiresAt) {
    const deadlineMs = Date.parse(String(input.searchingExpiresAt));
    if (Number.isFinite(deadlineMs)) {
      if (deadlineMs <= nowMs) {
        return { expire: true, reason: 'search_window_exhausted' };
      }
      return { expire: false, reason: 'search_window_open' };
    }
  }

  // Null/invalid deadline: never linger past pickup with no accepted driver.
  if (input.scheduledAt) {
    const pickupMs = Date.parse(String(input.scheduledAt));
    if (Number.isFinite(pickupMs) && pickupMs <= nowMs) {
      return { expire: true, reason: 'past_pickup_no_search_deadline' };
    }
  }

  return { expire: false, reason: 'awaiting_search_deadline' };
}

/**
 * When converted search has no stamped deadline but pickup is still ahead,
 * stamp a canonical window so STEP 4 can expire later via the same path.
 */
export function resolveBackfillSearchingExpiresAtIso(input: {
  nowMs: number;
  scheduledAt: string | null | undefined;
  maxFindDriverMinutes: number;
}): string {
  const maxFind = Math.max(1, Number(input.maxFindDriverMinutes) || 6);
  const fromNow = input.nowMs + maxFind * 60_000;
  if (input.scheduledAt) {
    const pickupMs = Date.parse(String(input.scheduledAt));
    if (Number.isFinite(pickupMs) && pickupMs > input.nowMs) {
      return new Date(Math.min(fromNow, pickupMs)).toISOString();
    }
  }
  return new Date(fromNow).toISOString();
}
