/**
 * CoverageSSOT — required authorised total from payable snapshot vs provider-confirmed auth.
 * Composition (waiting, discounts, tips, receivables) is already in the snapshot.
 * Waiting ticks never call this for increment (mod + completion only).
 */

import {
  type PayableFareSnapshot,
  requiredAuthorisedTotalFromSnapshot,
} from "./offline/payableFareSnapshotSSOT.ts";

export type CoverageEvaluation = {
  requiredAuthorisedPence: number;
  providerConfirmedAuthorisedPence: number;
  shortfallPence: number;
  covered: boolean;
  /** Pending/PROCESSING/unknown never count as confirmed cover. */
  coverageState: "COVERED" | "SHORTFALL" | "UNKNOWN_PROVIDER" | "NO_PAYMENT_REQUIRED";
};

function intPence(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function evaluateAuthorisationCoverage(args: {
  snapshot: PayableFareSnapshot;
  providerConfirmedAuthorisedPence: number | null | undefined;
  providerAuthKnown: boolean;
  noPaymentRequired?: boolean;
}): CoverageEvaluation {
  const required = requiredAuthorisedTotalFromSnapshot(args.snapshot);

  if (args.noPaymentRequired === true || required === 0) {
    return {
      requiredAuthorisedPence: 0,
      providerConfirmedAuthorisedPence: intPence(args.providerConfirmedAuthorisedPence),
      shortfallPence: 0,
      covered: true,
      coverageState: "NO_PAYMENT_REQUIRED",
    };
  }

  if (!args.providerAuthKnown) {
    return {
      requiredAuthorisedPence: required,
      providerConfirmedAuthorisedPence: intPence(args.providerConfirmedAuthorisedPence),
      shortfallPence: required,
      covered: false,
      coverageState: "UNKNOWN_PROVIDER",
    };
  }

  const authorised = intPence(args.providerConfirmedAuthorisedPence);
  const shortfall = Math.max(0, required - authorised);
  return {
    requiredAuthorisedPence: required,
    providerConfirmedAuthorisedPence: authorised,
    shortfallPence: shortfall,
    covered: shortfall === 0,
    coverageState: shortfall === 0 ? "COVERED" : "SHORTFALL",
  };
}

/**
 * Same-order increment target = required total (Revolut semantics unchanged).
 */
export function sameOrderIncrementTargetPence(coverage: CoverageEvaluation): number {
  return coverage.requiredAuthorisedPence;
}
