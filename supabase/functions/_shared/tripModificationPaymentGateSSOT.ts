/**
 * Trip-modification payment gate SSOT (MK-260915-002).
 *
 * Fare-increasing modifications must not mutate trip destination/stops/fare
 * until provider read-back proves authorised TOTAL covers the new payable.
 * Processing / pending / unknown never unlock apply.
 *
 * Pure helpers — no wallet, commission, payout, invoice, or capture writes.
 */

import {
  revolutProviderAuthorisedTotalPence,
  type RevolutOrder,
} from "./revolutOrders.ts";

export type ModificationPaymentPhase =
  | "MODIFICATION_REQUESTED"
  | "PAYMENT_PENDING"
  | "PROVIDER_CONFIRMED"
  | "MODIFICATION_APPLIED"
  | "PAYMENT_FAILED";

export type ModificationPaymentGateDecision =
  | {
    phase: "PROVIDER_CONFIRMED";
    mayApply: true;
    paymentStatus: "confirmed";
    requestStatus: "payment_confirmed";
    authorisedTotalPence: number;
  }
  | {
    phase: "PAYMENT_PENDING";
    mayApply: false;
    paymentStatus: "pending";
    requestStatus: "payment_pending";
    authorisedTotalPence: number;
    reason: "processing" | "unknown" | "timeout" | "network";
  }
  | {
    phase: "PAYMENT_FAILED";
    mayApply: false;
    paymentStatus: "failed";
    requestStatus: "payment_failed";
    authorisedTotalPence: number;
    reason: "declined" | "insufficient" | "amount_mismatch" | "failed";
  };

/** Pounds→pence exact conversion for money display values (never float fare math). */
export function poundsToPenceExact(pounds: number): number {
  return Math.round(Number(pounds) * 100);
}

/**
 * Modification-apply coverage — stricter than completion-capture MK-260815-020.
 * Processing/pending/initiated increment new_amount must NOT unlock trip mutation.
 * Only issuer-authorised totals (via revolutProviderAuthorisedTotalPence) unlock apply.
 */
export function classifyModificationApplyCoverage(
  order: RevolutOrder | null | undefined,
  targetTotalPence: number,
): { class: "confirmed" | "processing" | "insufficient" | "unknown"; authorisedTotalPence: number } {
  const target = Math.round(Number(targetTotalPence));
  if (!order) return { class: "unknown", authorisedTotalPence: 0 };

  const authorisedTotalPence = revolutProviderAuthorisedTotalPence(order);
  const increments = Array.isArray(order.incremental_authorisations)
    ? order.incremental_authorisations
    : [];
  const unsettled = increments.some((increment) => {
    const s = String(increment?.state ?? "").toLowerCase();
    return s === "processing" || s === "pending"
      || s === "initiated" || s === "requested" || s === "created"
      || s === "unknown";
  });
  const declined = increments.some((increment) => {
    const s = String(increment?.state ?? "").toLowerCase();
    return s === "declined" || s === "failed";
  });

  if (authorisedTotalPence >= target) {
    return { class: "confirmed", authorisedTotalPence };
  }

  if (unsettled) {
    return { class: "processing", authorisedTotalPence };
  }

  if (declined || authorisedTotalPence > 0) {
    return { class: "insufficient", authorisedTotalPence };
  }

  const state = String(order.state ?? "").toUpperCase();
  if (state === "PROCESSING" || state === "PENDING") {
    return { class: "processing", authorisedTotalPence };
  }

  return { class: "unknown", authorisedTotalPence };
}

/**
 * Provider-authoritative coverage for a fare-increasing modification.
 * Original order AUTHORISED alone is never enough when target exceeds current
 * authorised total — the increment itself must be settled (authorised state).
 */
export function decideModificationIncrementCoverage(args: {
  order: RevolutOrder | null | undefined;
  requiredPayablePence: number;
}): ModificationPaymentGateDecision {
  const required = Math.max(0, Math.round(Number(args.requiredPayablePence)));
  const coverage = classifyModificationApplyCoverage(args.order, required);

  if (coverage.class === "confirmed" && coverage.authorisedTotalPence >= required) {
    return {
      phase: "PROVIDER_CONFIRMED",
      mayApply: true,
      paymentStatus: "confirmed",
      requestStatus: "payment_confirmed",
      authorisedTotalPence: coverage.authorisedTotalPence,
    };
  }

  if (coverage.class === "processing") {
    return {
      phase: "PAYMENT_PENDING",
      mayApply: false,
      paymentStatus: "pending",
      requestStatus: "payment_pending",
      authorisedTotalPence: coverage.authorisedTotalPence,
      reason: "processing",
    };
  }

  if (coverage.class === "unknown") {
    return {
      phase: "PAYMENT_PENDING",
      mayApply: false,
      paymentStatus: "pending",
      requestStatus: "payment_pending",
      authorisedTotalPence: coverage.authorisedTotalPence,
      reason: "unknown",
    };
  }

  return {
    phase: "PAYMENT_FAILED",
    mayApply: false,
    paymentStatus: "failed",
    requestStatus: "payment_failed",
    authorisedTotalPence: coverage.authorisedTotalPence,
    reason: coverage.authorisedTotalPence > 0 && coverage.authorisedTotalPence < required
      ? "amount_mismatch"
      : "declined",
  };
}

/** Map update-preauth / executeSameOrderIncrement outcomes onto the gate. */
export function decideFromPreauthInvokeResult(args: {
  success: boolean;
  skipped?: boolean;
  paymentCoverageStatus?: string | null;
  authorisedAmountPence?: number | null;
  requiredPayablePence: number;
  errorCode?: string | null;
  warning?: string | null;
}): ModificationPaymentGateDecision {
  const required = Math.max(0, Math.round(Number(args.requiredPayablePence)));
  const authorised = Math.max(0, Math.round(Number(args.authorisedAmountPence ?? 0)));
  const coverage = String(args.paymentCoverageStatus ?? "").toLowerCase();
  const code = String(args.errorCode ?? "").toUpperCase();
  const warning = String(args.warning ?? "").toLowerCase();

  // Issuer-authoritative hold already covers the revised payable — confirm before
  // any processing/pending hint. Processing new_amount must never invent coverage,
  // but an already-authorised total that meets the target is enough to unlock apply.
  if (
    authorised >= required
    && required > 0
    && !coverage.includes("insufficient")
    && !coverage.includes("under_")
    && !coverage.includes("declined")
  ) {
    return {
      phase: "PROVIDER_CONFIRMED",
      mayApply: true,
      paymentStatus: "confirmed",
      requestStatus: "payment_confirmed",
      authorisedTotalPence: authorised,
    };
  }

  if (args.skipped === true && args.success) {
    // Never invent coverage when skip reports authorised=0 for a positive delta.
    return {
      phase: "PAYMENT_FAILED",
      mayApply: false,
      paymentStatus: "failed",
      requestStatus: "payment_failed",
      authorisedTotalPence: authorised,
      reason: "amount_mismatch",
    };
  }

  const pendingHint =
    coverage.includes("reconciliation_pending")
    || coverage.includes("processing")
    || code === "PROCESSING"
    || code === "AUTHORISATION_RECONCILIATION_PENDING"
    || warning.includes("processing")
    || warning.includes("ambiguous");

  if (pendingHint) {
    return {
      phase: "PAYMENT_PENDING",
      mayApply: false,
      paymentStatus: "pending",
      requestStatus: "payment_pending",
      authorisedTotalPence: authorised,
      reason: code.includes("TIMEOUT") || warning.includes("timeout")
        ? "timeout"
        : code.includes("NETWORK") || warning.includes("network")
        ? "network"
        : coverage.includes("processing") || code === "PROCESSING"
        ? "processing"
        : "unknown",
    };
  }

  if (authorised > 0 && authorised < required) {
    return {
      phase: "PAYMENT_FAILED",
      mayApply: false,
      paymentStatus: "failed",
      requestStatus: "payment_failed",
      authorisedTotalPence: authorised,
      reason: "amount_mismatch",
    };
  }

  return {
    phase: "PAYMENT_FAILED",
    mayApply: false,
    paymentStatus: "failed",
    requestStatus: "payment_failed",
    authorisedTotalPence: authorised,
    reason: "declined",
  };
}

/**
 * Optimistic concurrency: apply only when trip still matches the fare basis
 * the modification was quoted against. Concurrent winners move the fare;
 * losers must not stack a second delta.
 */
export function tripFareBasisMatchesExpectation(args: {
  expectedPreviousFarePence: number | null | undefined;
  currentCommittedFarePence: number | null | undefined;
}): boolean {
  const expected = Math.round(Number(args.expectedPreviousFarePence ?? NaN));
  const current = Math.round(Number(args.currentCommittedFarePence ?? NaN));
  if (!Number.isFinite(expected) || expected < 0) return false;
  if (!Number.isFinite(current) || current < 0) return false;
  return expected === current;
}

/** Duplicate confirm of an already-applied request — return without re-adding delta. */
export function isAlreadyAppliedModification(status: string | null | undefined): boolean {
  const s = String(status ?? "").toLowerCase();
  return s === "applied" || s === "approved";
}

/**
 * Internal simulator for the £5.00→£8.11 class of cases without hard-coding
 * those amounts into production paths. Inputs are arbitrary pence.
 */
export function simulateModificationAuthorisationSequence(args: {
  originalAuthorisedPence: number;
  requiredPayablePence: number;
  providerSnapshots: Array<RevolutOrder | null>;
}): {
  decisions: ModificationPaymentGateDecision[];
  applied: boolean;
  finalAuthorisedPence: number;
} {
  const decisions: ModificationPaymentGateDecision[] = [];
  let applied = false;
  let finalAuthorised = Math.round(Number(args.originalAuthorisedPence));

  for (const snapshot of args.providerSnapshots) {
    const decision = decideModificationIncrementCoverage({
      order: snapshot,
      requiredPayablePence: args.requiredPayablePence,
    });
    decisions.push(decision);
    finalAuthorised = decision.authorisedTotalPence;
    if (decision.mayApply) {
      applied = true;
      break;
    }
    if (decision.phase === "PAYMENT_FAILED") {
      break;
    }
  }

  return { decisions, applied, finalAuthorisedPence: finalAuthorised };
}

/** PLATFORM_COLLECTED isolation — modification auth must not touch these write kinds. */
export const MODIFICATION_AUTH_FORBIDDEN_MUTATIONS = [
  "wallet_ledger_write",
  "commission_wallet_write",
  "payout_ledger_write",
  "invoice_mutation",
  "capture_mutation",
] as const;

export function assertNoForbiddenModificationAuthMutation(kind: string): boolean {
  return !(MODIFICATION_AUTH_FORBIDDEN_MUTATIONS as readonly string[]).includes(kind);
}
