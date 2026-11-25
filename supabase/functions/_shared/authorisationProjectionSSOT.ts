/**
 * #103 / #93A — Authorisation projection semantics.
 *
 * authorised_amount_pence / original_authorised_pence = original preauth hold (immutable).
 * total_authorised_amount_pence = local mirror of confirmed cumulative coverage.
 * Provider retrieve (revolutProviderAuthorisedTotalPence) = decision authority for coverage.
 *
 * Never treat bare authorised_amount_pence as live coverage after increments.
 * Never invent original hold from provider total (historical promoted rows → report ambiguity).
 */

export type AuthorisationProjectionRow = {
  authorised_amount_pence?: number | null;
  original_authorised_pence?: number | null;
  total_authorised_amount_pence?: number | null;
  additional_authorised_pence?: number | null;
};

export type CoverageResolveSource =
  | "provider"
  | "local_total"
  | "local_original_fallback"
  | "unknown";

export type AuthorisationProjectionClass =
  | "original_intact"
  | "both_equal_initial"
  | "authorised_promoted"
  | "total_stale"
  | "total_missing_after_increment"
  | "other";

function intPence(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

function positivePenceOrNull(value: unknown): number | null {
  const n = intPence(value);
  return n > 0 ? n : null;
}

/** Original preauth hold — never live coverage. Prefer explicit original column. */
export function resolveInitialAuthorisedHoldPence(
  row: AuthorisationProjectionRow,
): number | null {
  return positivePenceOrNull(row.original_authorised_pence)
    ?? positivePenceOrNull(row.authorised_amount_pence);
}

/**
 * Local mirror of confirmed cumulative coverage.
 * Prefers total_authorised; falls back to authorised only when total is absent
 * (pre-increment / legacy rows where both equal the original hold).
 */
export function resolveLocalConfirmedCoveragePence(
  row: AuthorisationProjectionRow,
): number | null {
  const total = positivePenceOrNull(row.total_authorised_amount_pence);
  if (total != null) return total;
  return positivePenceOrNull(row.authorised_amount_pence);
}

/**
 * Decision coverage: provider-confirmed first, else local total mirror.
 * Does not invent coverage from missing provider + missing total.
 */
export function resolveSessionAuthorisedCoveragePence(args: {
  providerConfirmedAuthorisedPence?: number | null;
  providerAuthKnown?: boolean;
  total_authorised_amount_pence?: number | null;
  authorised_amount_pence?: number | null;
  original_authorised_pence?: number | null;
}): { coveragePence: number | null; source: CoverageResolveSource } {
  if (args.providerAuthKnown === true) {
    const provider = positivePenceOrNull(args.providerConfirmedAuthorisedPence);
    if (provider != null) {
      return { coveragePence: provider, source: "provider" };
    }
  } else {
    const provider = positivePenceOrNull(args.providerConfirmedAuthorisedPence);
    if (provider != null) {
      return { coveragePence: provider, source: "provider" };
    }
  }

  const total = positivePenceOrNull(args.total_authorised_amount_pence);
  if (total != null) {
    return { coveragePence: total, source: "local_total" };
  }

  const original = resolveInitialAuthorisedHoldPence(args);
  if (original != null) {
    return { coveragePence: original, source: "local_original_fallback" };
  }

  return { coveragePence: null, source: "unknown" };
}

/**
 * Expected residual authorisation (audit) = coverage − capture when coverage > capture.
 * Never a confirmed released amount.
 */
export function expectedResidualFromCoveragePence(args: {
  coveragePence: number | null | undefined;
  capturedPence: number | null | undefined;
}): number | null {
  const coverage = positivePenceOrNull(args.coveragePence);
  const captured = args.capturedPence == null ? null : intPence(args.capturedPence);
  if (coverage == null || captured == null || captured < 0) return null;
  if (coverage <= captured) return null;
  return coverage - captured;
}

/**
 * Classify local projection vs confirmed-increment evidence (observability / P4 prep).
 * Does not repair. Does not invent original from provider total.
 */
export function classifyAuthorisationProjection(args: {
  authorised_amount_pence?: number | null;
  total_authorised_amount_pence?: number | null;
  original_authorised_pence?: number | null;
  psaConfirmedTotalPence?: number | null;
  confirmedIncrementCount?: number | null;
}): AuthorisationProjectionClass {
  const authorised = intPence(args.authorised_amount_pence);
  const total = intPence(args.total_authorised_amount_pence);
  const psa = positivePenceOrNull(args.psaConfirmedTotalPence);
  const increments = Math.max(0, Math.round(Number(args.confirmedIncrementCount ?? 0)));

  if (increments > 0 && authorised > 0 && total > authorised) return "original_intact";
  if (
    increments > 0
    && authorised > 0
    && authorised === total
    && (psa == null || authorised === psa)
  ) {
    return "authorised_promoted";
  }
  if (increments > 0 && total > 0 && psa != null && total < psa) return "total_stale";
  if (increments > 0 && total === 0 && authorised > 0) return "total_missing_after_increment";
  if (increments === 0 && authorised === total) return "both_equal_initial";
  return "other";
}

/**
 * Build a session patch that may advance total coverage but never overwrites
 * an already-confirmed original hold.
 */
export function buildAuthorisationMirrorPatch(args: {
  existingAuthorisedPence?: number | null;
  existingTotalAuthorisedPence?: number | null;
  /** Confirmed cumulative coverage to mirror (provider or PSA). */
  confirmedCoveragePence: number;
  /** Only seed original when existing authorised is absent. */
  seedOriginalIfMissing?: boolean;
}): Record<string, number> {
  const confirmed = Math.max(0, Math.round(Number(args.confirmedCoveragePence)));
  const existingTotal = intPence(args.existingTotalAuthorisedPence);
  const existingAuth = intPence(args.existingAuthorisedPence);
  const patch: Record<string, number> = {};

  // Never regress confirmed local coverage mirror.
  const nextTotal = Math.max(existingTotal, confirmed);
  if (nextTotal > 0) {
    patch.total_authorised_amount_pence = nextTotal;
  }

  if (
    args.seedOriginalIfMissing === true
    && existingAuth <= 0
    && confirmed > 0
  ) {
    patch.authorised_amount_pence = confirmed;
  }

  return patch;
}

/** Whether an UPDATE may change authorised_amount_pence (app-side precheck). */
export function mayWriteOriginalAuthorisedAmount(args: {
  existingAuthorisedPence?: number | null;
  nextAuthorisedPence?: number | null;
}): boolean {
  const existing = intPence(args.existingAuthorisedPence);
  if (existing <= 0) return true;
  const next = args.nextAuthorisedPence == null ? null : intPence(args.nextAuthorisedPence);
  if (next == null) return false;
  return next === existing;
}
