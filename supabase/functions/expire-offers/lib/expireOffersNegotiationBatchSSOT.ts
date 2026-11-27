/**
 * I-1 residual — negotiation-block batch helpers (no TTL / cron change).
 *
 * Confirmed prod (27 Nov post-B1): authorised worker burns full 8s budget in
 * negotiation_block with N+1 per-offer SELECTs + per-unit durable lease RPC.
 * Session advisory remains the check-to-use primary; durable assert is
 * defense-in-depth and may be interval-throttled while the session fence is held.
 */

/** Default interval between durable lease asserts while session fence held. */
export const EXPIRE_OFFERS_DURABLE_ASSERT_INTERVAL_MS_DEFAULT = 1000;

export function indexRowsById<T extends { id: string }>(
  rows: T[] | null | undefined,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows ?? []) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    map.set(id, row);
  }
  return map;
}

/**
 * When session fence is held, peers cannot reclaim — durable assert may be
 * throttled. Without session fence, always assert (fail closed).
 */
export function shouldAssertDurableLeaseNow(params: {
  nowMs: number;
  lastAssertAtMs: number | null;
  sessionFenceHeld: boolean;
  intervalMs?: number;
}): boolean {
  if (!params.sessionFenceHeld) return true;
  const interval = params.intervalMs ?? EXPIRE_OFFERS_DURABLE_ASSERT_INTERVAL_MS_DEFAULT;
  if (params.lastAssertAtMs == null) return true;
  return params.nowMs - params.lastAssertAtMs >= interval;
}

/** Unique non-empty ids for `.in(...)` batch selects. */
export function uniqueNonEmptyIds(ids: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
