/** Pure hold-release helpers — no provider I/O. */

export const FORCE_SESSION_RELEASE_REASONS = new Set([
  "create_trip_failed_to_start",
  "booking_failed_no_trip",
  "edge_boot_failure",
  "customer_cancelled_authorised_hold",
]);

/** Trip-less AUTHORISED holds older than this are swept (Try Again window). */
export const TRIPLESS_AUTHORISED_HOLD_SWEEP_MIN_AGE_MS = 3 * 60 * 1000;

export function shouldForceAuthorisedSessionRelease(reason: string): boolean {
  return FORCE_SESSION_RELEASE_REASONS.has(String(reason ?? "").trim());
}

export function sessionAgeMs(session: Record<string, unknown> | null | undefined): number {
  if (!session) return Number.POSITIVE_INFINITY;
  const raw = session.authorised_at ?? session.created_at;
  const t = Date.parse(String(raw ?? ""));
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Number.POSITIVE_INFINITY;
}
