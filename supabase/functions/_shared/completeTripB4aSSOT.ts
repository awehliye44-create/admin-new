/**
 * B4-A — Tip-window persist: skip redundant post-completion tip re-SELECT when
 * completion UPDATE RETURNING already proves the open tip window.
 *
 * Default OFF (`COMPLETE_TRIP_B4A` unset/0). When ON:
 * - Prefer authoritative RETURNING tip_window_* columns.
 * - Never treat in-memory tipWindowOnComplete as proof of persistence.
 * - Missing/incomplete RETURNING → one recovery re-SELECT (fail-closed path).
 * - Unexpected RETURNING mismatch vs expected → recovery re-SELECT, then
 *   existing settlement recovery re-stamp rules apply.
 *
 * Does not move PENDING, capture, TEN, or completion write semantics.
 */

export const COMPLETE_TRIP_B4A_FLAG = "COMPLETE_TRIP_B4A";

function readCompleteTripB4aFlagFromEnv(): string | undefined {
  try {
    if (typeof Deno === "undefined") return undefined;
    return Deno.env.get(COMPLETE_TRIP_B4A_FLAG) ?? undefined;
  } catch {
    return undefined;
  }
}

export function isCompleteTripB4aEnabled(
  raw: string | undefined | null = readCompleteTripB4aFlagFromEnv(),
): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export type TipWindowPersistDecision =
  | {
    action: "skip_reselect_returning_authoritative";
    skipTipWindowColumns: true;
    performReselect: false;
    reason: "returning_authoritative";
  }
  | {
    action: "reselect_recovery";
    skipTipWindowColumns: false;
    performReselect: true;
    reason:
      | "returning_missing"
      | "returning_incomplete"
      | "returning_mismatch"
      | "b4a_off_legacy_reselect";
  }
  | {
    action: "no_expected_window";
    skipTipWindowColumns: false;
    performReselect: false;
    reason: "no_expected_open";
  };

/**
 * Decide whether the post-completion tip re-SELECT is redundant.
 * `returningAuthoritative` must come from DB RETURNING (or recovery SELECT), never memory.
 */
export function decideTipWindowPersistPath(args: {
  b4aEnabled: boolean;
  hasExpectedOpen: boolean;
  returningAuthoritative: boolean;
  returningRowPresent: boolean;
  returningHasAllTipFields: boolean;
}): TipWindowPersistDecision {
  if (!args.hasExpectedOpen) {
    return {
      action: "no_expected_window",
      skipTipWindowColumns: false,
      performReselect: false,
      reason: "no_expected_open",
    };
  }
  if (args.returningAuthoritative) {
    return {
      action: "skip_reselect_returning_authoritative",
      skipTipWindowColumns: true,
      performReselect: false,
      reason: "returning_authoritative",
    };
  }
  // B4-A OFF: legacy always attempted recovery re-SELECT when not yet authoritative.
  if (!args.b4aEnabled) {
    return {
      action: "reselect_recovery",
      skipTipWindowColumns: false,
      performReselect: true,
      reason: "b4a_off_legacy_reselect",
    };
  }
  // B4-A ON: recovery re-SELECT only when RETURNING missing/incomplete/mismatch.
  if (!args.returningRowPresent) {
    return {
      action: "reselect_recovery",
      skipTipWindowColumns: false,
      performReselect: true,
      reason: "returning_missing",
    };
  }
  if (!args.returningHasAllTipFields) {
    return {
      action: "reselect_recovery",
      skipTipWindowColumns: false,
      performReselect: true,
      reason: "returning_incomplete",
    };
  }
  return {
    action: "reselect_recovery",
    skipTipWindowColumns: false,
    performReselect: true,
    reason: "returning_mismatch",
  };
}

/** Isolated OFF/ON model: count tip re-SELECT queries for identical RETURNING outcomes. */
export function measureCompleteTripB4aReselectWorkload(params: {
  enabled: boolean;
  cases: Array<{
    hasExpectedOpen: boolean;
    returningAuthoritative: boolean;
    returningRowPresent: boolean;
    returningHasAllTipFields: boolean;
  }>;
}): { reselect_queries: number; skip_reselect: number } {
  let reselect_queries = 0;
  let skip_reselect = 0;
  for (const c of params.cases) {
    const d = decideTipWindowPersistPath({
      b4aEnabled: params.enabled,
      ...c,
    });
    if (d.performReselect) reselect_queries += 1;
    else if (d.action === "skip_reselect_returning_authoritative") {
      skip_reselect += 1;
    }
  }
  return { reselect_queries, skip_reselect };
}
