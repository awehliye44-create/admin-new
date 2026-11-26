/**
 * P6 M1 — bounded per-trip backoff for capture-expired-tip-windows.
 *
 * A trip whose expiry attempt did not confirm capture (shortfall, provider
 * unknown, finalize error, claim denied …) is deferred via
 * trips.tip_window_next_attempt_at so it cannot monopolise the oldest-first
 * 50-row window every 5s. Never abandoned — the cap just bounds cadence.
 *
 * L2 — provider-GET throttle: CAS on trips.tip_window_last_provider_get_at,
 * stamped BEFORE the Revolut GET (see buildProviderGetCasFilter).
 */
import { TIP_WINDOW_PROVIDER_GET_THROTTLE_MS } from "./expiredTipWindowStaleReclaimSSOT.ts";

export const TIP_EXPIRY_BACKOFF_BASE_SECONDS = 30;
export const TIP_EXPIRY_MAX_BACKOFF_SECONDS = 30 * 60;

/** attempt: 0-based count of prior failed attempts. */
export function computeTipExpiryNextRetrySeconds(attempt: number): number {
  const a = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(TIP_EXPIRY_BACKOFF_BASE_SECONDS * Math.pow(2, a), TIP_EXPIRY_MAX_BACKOFF_SECONDS);
}

export function buildTipExpiryDeferral(args: { priorAttempts: number; nowMs: number }): {
  tip_window_next_attempt_at: string;
  tip_window_expiry_attempt_count: number;
} {
  const prior = Math.max(0, Math.floor(Number(args.priorAttempts) || 0));
  return {
    tip_window_next_attempt_at: new Date(
      args.nowMs + computeTipExpiryNextRetrySeconds(prior) * 1000,
    ).toISOString(),
    tip_window_expiry_attempt_count: prior + 1,
  };
}

export function isTipExpiryDeferred(
  nextAttemptAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (!nextAttemptAt) return false;
  const ms = Date.parse(String(nextAttemptAt));
  return Number.isFinite(ms) && ms > nowMs;
}

/** PostgREST `.or()` expression: GET allowed when never stamped or stamp older than the throttle. */
export function buildProviderGetCasFilter(nowMs: number): string {
  const cutoffIso = new Date(nowMs - TIP_WINDOW_PROVIDER_GET_THROTTLE_MS).toISOString();
  return `tip_window_last_provider_get_at.is.null,tip_window_last_provider_get_at.lt.${cutoffIso}`;
}

/** PostgREST `.or()` expression: row is due (not deferred). */
export function buildTipExpiryDueFilter(nowIso: string): string {
  return `tip_window_next_attempt_at.is.null,tip_window_next_attempt_at.lte.${nowIso}`;
}
