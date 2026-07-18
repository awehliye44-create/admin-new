/**
 * Payment Sessions (SSOT) — capture confirmation vs canonical payable.
 * Provider evidence wins over stale/null local projections.
 * MANUAL_REVIEW only for real unresolved contradictions.
 */

import {
  confirmedPositiveCapturePence,
  isValidConfirmedCapturePence,
} from "./paymentCaptureEvidenceSSOT";

export const PAYMENT_SESSION_CAPTURE_CLASSIFICATION = {
  AUTHORISED_ACTIVE: "AUTHORISED_ACTIVE",
  CAPTURED_CONFIRMED: "CAPTURED_CONFIRMED",
  PARTIALLY_CAPTURED_CONFIRMED: "PARTIALLY_CAPTURED_CONFIRMED",
  UNDERCAPTURED_RECOVERY_REQUIRED: "UNDERCAPTURED_RECOVERY_REQUIRED",
  OVERCAPTURED_REFUND_REQUIRED: "OVERCAPTURED_REFUND_REQUIRED",
  RELEASED_CONFIRMED: "RELEASED_CONFIRMED",
  REFUNDED_CONFIRMED: "REFUNDED_CONFIRMED",
  PAYMENT_LINK_PENDING: "PAYMENT_LINK_PENDING",
  RECOVERY_IN_PROGRESS: "RECOVERY_IN_PROGRESS",
  MANUAL_REVIEW_REQUIRED: "MANUAL_REVIEW_REQUIRED",
} as const;

export type PaymentSessionCaptureClassificationStatus =
  typeof PAYMENT_SESSION_CAPTURE_CLASSIFICATION[keyof typeof PAYMENT_SESSION_CAPTURE_CLASSIFICATION];

export const PAYMENT_LINK_STATE = {
  CREATED: "CREATED",
  SENT: "SENT",
  OPENED: "OPENED",
  AUTHORISED: "AUTHORISED",
  CAPTURED: "CAPTURED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
} as const;

export type PaymentLinkState = typeof PAYMENT_LINK_STATE[keyof typeof PAYMENT_LINK_STATE];

const TOLERANCE_PENCE = 1;

function upper(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase();
}

function nonNegPence(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function isProviderCaptureTerminalState(providerState: string | null | undefined): boolean {
  const s = upper(providerState);
  return s === "COMPLETED" || s === "CAPTURED";
}

/**
 * Canonical customer payable — never prefer original estimate when final/lifecycle
 * charges are available.
 */
export function resolveCanonicalCustomerPayablePence(args: {
  finalCustomerFarePence?: number | null;
  finalFarePence?: number | null;
  noShowChargePence?: number | null;
  cancellationFeePence?: number | null;
  outstandingBalancePence?: number | null;
  estimatedTotalPence?: number | null;
}): { payable_pence: number | null; source: string } {
  const candidates: Array<{ pence: number | null; source: string }> = [
    { pence: nonNegPence(args.finalCustomerFarePence), source: "final_customer_fare_pence" },
    { pence: nonNegPence(args.finalFarePence), source: "final_fare_pence" },
    { pence: nonNegPence(args.noShowChargePence), source: "no_show_charge_pence" },
    { pence: nonNegPence(args.cancellationFeePence), source: "cancellation_fee_pence" },
    { pence: nonNegPence(args.outstandingBalancePence), source: "outstanding_balance_pence" },
    { pence: nonNegPence(args.estimatedTotalPence), source: "estimated_total_pence" },
  ];
  for (const c of candidates) {
    if (c.pence != null && c.pence > 0) {
      return { payable_pence: c.pence, source: c.source };
    }
  }
  if (nonNegPence(args.finalCustomerFarePence) === 0 || nonNegPence(args.finalFarePence) === 0) {
    return { payable_pence: 0, source: "zero_charge" };
  }
  return { payable_pence: null, source: "unresolvable" };
}

/**
 * outstanding = payable − all confirmed captures − confirmed recovery captures.
 */
export function computeOutstandingBalancePence(args: {
  canonicalPayablePence: number | null | undefined;
  confirmedCapturePence?: number | null;
  confirmedRecoveryCapturePence?: number | null;
}): number | null {
  const payable = nonNegPence(args.canonicalPayablePence);
  if (payable == null) return null;
  const captured = Math.max(0, confirmedPositiveCapturePence(args.confirmedCapturePence) ?? 0);
  const recovered = Math.max(
    0,
    confirmedPositiveCapturePence(args.confirmedRecoveryCapturePence) ?? 0,
  );
  return Math.max(0, payable - captured - recovered);
}

/**
 * difference_pence = provider_captured - canonical_payable
 */
export function captureDifferencePence(args: {
  providerCapturedPence: number | null | undefined;
  canonicalPayablePence: number | null | undefined;
}): number | null {
  const captured = confirmedPositiveCapturePence(args.providerCapturedPence);
  const payable = nonNegPence(args.canonicalPayablePence);
  if (captured == null || payable == null) return null;
  return captured - payable;
}

export type CaptureContradictionReason =
  | "CURRENCY_MISMATCH"
  | "OWNERSHIP_UNPROVEN"
  | "DUPLICATE_PROVIDER_CAPTURE"
  | "PROVIDER_ORDER_UNRETRIEVABLE"
  | "REFUND_RELEASE_CONTRADICTS_CAPTURE"
  | "PAYABLE_UNRESOLVABLE_ON_COMPLETED_TRIP"
  | "LEDGER_AMOUNT_MISMATCH"
  | "RECOVERY_AND_ORIGINAL_BOTH_CAPTURED_AMBIGUOUS"
  | "PROVIDER_EVIDENCE_CONTRADICTORY"
  | "EXPLICIT_CONTRADICTION";

export function classifyCaptureConfirmation(args: {
  providerState?: string | null;
  providerCapturedPence?: number | null;
  localCapturedPence?: number | null;
  canonicalPayablePence?: number | null;
  authorisedPence?: number | null;
  releasedAmountPence?: number | null;
  refundedAmountPence?: number | null;
  purpose?: string | null;
  paymentLinkState?: string | null;
  tripCompleted?: boolean;
  hasTripOwnership?: boolean;
  currencyMismatch?: boolean;
  duplicateCaptureDetected?: boolean;
  providerOrderUnretrievable?: boolean;
  ledgerAmountMismatch?: boolean;
  recoveryAmbiguousDoubleCapture?: boolean;
  hasContradictoryEvidence?: boolean;
  contradictionReason?: CaptureContradictionReason | null;
}): {
  classification: PaymentSessionCaptureClassificationStatus;
  difference_pence: number | null;
  outstanding_pence: number | null;
  confirmed_capture_pence: number | null;
  label: string;
  requires_manual_review: boolean;
  manual_review_reason: string | null;
} {
  const contradiction =
    args.hasContradictoryEvidence
    || args.currencyMismatch
    || args.duplicateCaptureDetected
    || args.providerOrderUnretrievable
    || args.ledgerAmountMismatch
    || args.recoveryAmbiguousDoubleCapture
    || (args.hasTripOwnership === false && isValidConfirmedCapturePence(
      args.providerCapturedPence ?? args.localCapturedPence,
    ))
    || (args.tripCompleted === true
      && args.canonicalPayablePence == null
      && isProviderCaptureTerminalState(args.providerState));

  if (contradiction) {
    const reason = args.contradictionReason
      ?? (args.currencyMismatch
        ? "CURRENCY_MISMATCH"
        : args.duplicateCaptureDetected
        ? "DUPLICATE_PROVIDER_CAPTURE"
        : args.providerOrderUnretrievable
        ? "PROVIDER_ORDER_UNRETRIEVABLE"
        : args.ledgerAmountMismatch
        ? "LEDGER_AMOUNT_MISMATCH"
        : args.recoveryAmbiguousDoubleCapture
        ? "RECOVERY_AND_ORIGINAL_BOTH_CAPTURED_AMBIGUOUS"
        : args.hasTripOwnership === false
        ? "OWNERSHIP_UNPROVEN"
        : args.tripCompleted === true && args.canonicalPayablePence == null
        ? "PAYABLE_UNRESOLVABLE_ON_COMPLETED_TRIP"
        : "EXPLICIT_CONTRADICTION");
    return {
      classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.MANUAL_REVIEW_REQUIRED,
      difference_pence: null,
      outstanding_pence: null,
      confirmed_capture_pence: null,
      label: "MANUAL REVIEW REQUIRED",
      requires_manual_review: true,
      manual_review_reason: reason,
    };
  }

  const linkState = upper(args.paymentLinkState);
  if (
    linkState === PAYMENT_LINK_STATE.CREATED
    || linkState === PAYMENT_LINK_STATE.SENT
    || linkState === PAYMENT_LINK_STATE.OPENED
    || linkState === PAYMENT_LINK_STATE.AUTHORISED
  ) {
    return {
      classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.PAYMENT_LINK_PENDING,
      difference_pence: null,
      outstanding_pence: computeOutstandingBalancePence({
        canonicalPayablePence: args.canonicalPayablePence,
        confirmedCapturePence: args.providerCapturedPence ?? args.localCapturedPence,
      }),
      confirmed_capture_pence: confirmedPositiveCapturePence(
        args.providerCapturedPence ?? args.localCapturedPence,
      ),
      label: "PAYMENT LINK PENDING",
      requires_manual_review: false,
      manual_review_reason: null,
    };
  }

  const purpose = upper(args.purpose);
  if (
    purpose === "PAYMENT_RECOVERY"
    && !isProviderCaptureTerminalState(args.providerState)
    && !isValidConfirmedCapturePence(args.providerCapturedPence ?? args.localCapturedPence)
  ) {
    return {
      classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.RECOVERY_IN_PROGRESS,
      difference_pence: null,
      outstanding_pence: null,
      confirmed_capture_pence: null,
      label: "RECOVERY IN PROGRESS",
      requires_manual_review: false,
      manual_review_reason: null,
    };
  }

  const refunded = nonNegPence(args.refundedAmountPence);
  if (refunded != null && refunded > 0) {
    return {
      classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.REFUNDED_CONFIRMED,
      difference_pence: null,
      outstanding_pence: 0,
      confirmed_capture_pence: confirmedPositiveCapturePence(
        args.providerCapturedPence ?? args.localCapturedPence,
      ),
      label: "REFUNDED — CONFIRMED",
      requires_manual_review: false,
      manual_review_reason: null,
    };
  }

  const released = nonNegPence(args.releasedAmountPence);
  const confirmed = confirmedPositiveCapturePence(
    args.providerCapturedPence ?? args.localCapturedPence,
  );
  if (
    released != null
    && released > 0
    && confirmed == null
    && !isProviderCaptureTerminalState(args.providerState)
  ) {
    return {
      classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.RELEASED_CONFIRMED,
      difference_pence: null,
      outstanding_pence: 0,
      confirmed_capture_pence: null,
      label: "RELEASED — CONFIRMED",
      requires_manual_review: false,
      manual_review_reason: null,
    };
  }

  const providerTerminal = isProviderCaptureTerminalState(args.providerState);
  const diff = captureDifferencePence({
    providerCapturedPence: confirmed,
    canonicalPayablePence: args.canonicalPayablePence,
  });

  if (confirmed != null && (providerTerminal || isValidConfirmedCapturePence(args.localCapturedPence))) {
    const auth = nonNegPence(args.authorisedPence);
    const partialVsAuth =
      auth != null
      && auth > confirmed
      && (diff == null || Math.abs(diff) <= TOLERANCE_PENCE);

    if (diff == null) {
      return {
        classification: partialVsAuth
          ? PAYMENT_SESSION_CAPTURE_CLASSIFICATION.PARTIALLY_CAPTURED_CONFIRMED
          : PAYMENT_SESSION_CAPTURE_CLASSIFICATION.CAPTURED_CONFIRMED,
        difference_pence: null,
        outstanding_pence: null,
        confirmed_capture_pence: confirmed,
        label: partialVsAuth ? "PARTIALLY CAPTURED — CONFIRMED" : "CAPTURED — CONFIRMED",
        requires_manual_review: false,
        manual_review_reason: null,
      };
    }
    if (Math.abs(diff) <= TOLERANCE_PENCE) {
      return {
        classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.CAPTURED_CONFIRMED,
        difference_pence: 0,
        outstanding_pence: 0,
        confirmed_capture_pence: confirmed,
        label: "CAPTURED — CONFIRMED",
        requires_manual_review: false,
        manual_review_reason: null,
      };
    }
    if (diff < 0) {
      const outstanding = Math.abs(diff);
      return {
        classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.UNDERCAPTURED_RECOVERY_REQUIRED,
        difference_pence: diff,
        outstanding_pence: outstanding,
        confirmed_capture_pence: confirmed,
        label: `OUTSTANDING £${(outstanding / 100).toFixed(2)}`,
        requires_manual_review: false,
        manual_review_reason: null,
      };
    }
    return {
      classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.OVERCAPTURED_REFUND_REQUIRED,
      difference_pence: diff,
      outstanding_pence: null,
      confirmed_capture_pence: confirmed,
      label: `OVERCHARGED £${(diff / 100).toFixed(2)}`,
      requires_manual_review: false,
      manual_review_reason: null,
    };
  }

  const auth = nonNegPence(args.authorisedPence);
  if (auth != null && auth > 0 && !providerTerminal) {
    return {
      classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.AUTHORISED_ACTIVE,
      difference_pence: null,
      outstanding_pence: null,
      confirmed_capture_pence: null,
      label: "AUTHORISED — ACTIVE",
      requires_manual_review: false,
      manual_review_reason: null,
    };
  }

  if (providerTerminal && confirmed == null) {
    return {
      classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.MANUAL_REVIEW_REQUIRED,
      difference_pence: null,
      outstanding_pence: null,
      confirmed_capture_pence: null,
      label: "MANUAL REVIEW REQUIRED",
      requires_manual_review: true,
      manual_review_reason: "PROVIDER_EVIDENCE_CONTRADICTORY",
    };
  }

  return {
    classification: PAYMENT_SESSION_CAPTURE_CLASSIFICATION.AUTHORISED_ACTIVE,
    difference_pence: null,
    outstanding_pence: null,
    confirmed_capture_pence: null,
    label: "PROVIDER RECONCILIATION PENDING",
    requires_manual_review: false,
    manual_review_reason: null,
  };
}

/**
 * Residual release after successful capture (auth − capture) with null explicit
 * provider cancel amount is NOT a financial discrepancy.
 */
export function isHealthyPostCaptureResidualRelease(args: {
  providerState?: string | null;
  capturedAmountPence?: number | null;
  releasedAt?: string | null;
  releasedAmountPence?: number | null;
  releaseEvidenceStatus?: string | null;
}): boolean {
  if (!isValidConfirmedCapturePence(args.capturedAmountPence)) return false;
  if (!isProviderCaptureTerminalState(args.providerState) && !args.releasedAt) return false;
  const evidence = upper(args.releaseEvidenceStatus);
  const amountMissing = args.releasedAmountPence == null;
  if (!amountMissing) return false;
  return (
    evidence === "AMOUNT_UNCONFIRMED"
    || evidence === ""
    || Boolean(args.releasedAt)
  );
}

export function shouldOfferCollectOutstanding(args: {
  classification: PaymentSessionCaptureClassificationStatus;
  outstandingPence: number | null | undefined;
}): boolean {
  return (
    args.classification === PAYMENT_SESSION_CAPTURE_CLASSIFICATION.UNDERCAPTURED_RECOVERY_REQUIRED
    && args.outstandingPence != null
    && args.outstandingPence > 0
  );
}

export function shouldOfferSendPaymentLink(args: {
  classification: PaymentSessionCaptureClassificationStatus;
  outstandingPence: number | null | undefined;
}): boolean {
  return shouldOfferCollectOutstanding(args);
}

export function collectOutstandingActionLabel(outstandingPence: number): string {
  const major = (Math.round(outstandingPence) / 100).toFixed(2);
  return `Collect Outstanding £${major}`;
}

export function sendPaymentLinkActionLabel(outstandingPence: number): string {
  const major = (Math.round(outstandingPence) / 100).toFixed(2);
  return `Send Payment Link £${major}`;
}

export function refundDifferenceActionLabel(overcapturePence: number): string {
  const major = (Math.round(overcapturePence) / 100).toFixed(2);
  return `Refund Difference £${major}`;
}

/** Admin action safety gates (pure). */
export function validateCollectOutstandingOrPaymentLinkAction(args: {
  outstandingPence: number | null | undefined;
  requestedAmountPence?: number | null;
  alreadyFullyCaptured?: boolean;
  zeroChargeCancellation?: boolean;
  idempotencyKey?: string | null;
}): { ok: true; charge_pence: number } | { ok: false; error_code: string; message: string } {
  if (args.zeroChargeCancellation) {
    return {
      ok: false,
      error_code: "ZERO_CHARGE_CANCELLATION",
      message: "Capture/recovery blocked after canonical zero-charge cancellation",
    };
  }
  if (args.alreadyFullyCaptured) {
    return {
      ok: false,
      error_code: "ALREADY_FULLY_CAPTURED",
      message: "Full-fare recapture blocked — session is already fully captured",
    };
  }
  const outstanding = nonNegPence(args.outstandingPence);
  if (outstanding == null || outstanding <= 0) {
    return {
      ok: false,
      error_code: "NO_OUTSTANDING_BALANCE",
      message: "Payment link / collect outstanding requires outstanding > £0.00",
    };
  }
  const requested = args.requestedAmountPence == null
    ? outstanding
    : nonNegPence(args.requestedAmountPence);
  if (requested == null || requested <= 0) {
    return {
      ok: false,
      error_code: "INVALID_REQUESTED_AMOUNT",
      message: "Requested amount must be a positive outstanding balance",
    };
  }
  if (requested > outstanding) {
    return {
      ok: false,
      error_code: "AMOUNT_EXCEEDS_OUTSTANDING",
      message: "Payment link must not exceed outstanding balance",
    };
  }
  if (!args.idempotencyKey || String(args.idempotencyKey).trim() === "") {
    return {
      ok: false,
      error_code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "Idempotency key required before capture/recovery/payment-link action",
    };
  }
  return { ok: true, charge_pence: requested };
}

/**
 * CAPTURED_CONFIRMED ≠ SETTLED_CONFIRMED.
 * Early Cash Out must use finance-cleared / settled earnings — never capture alone.
 */
export function earlyCashOutRequiresSettledNotMerelyCaptured(args: {
  captureClassification: PaymentSessionCaptureClassificationStatus;
  financeClearedPence?: number | null;
  settledConfirmed?: boolean;
}): {
  capture_confirmed: boolean;
  settled_confirmed: boolean;
  early_cash_out_may_use_capture_alone: false;
  early_cash_out_eligible_from_settlement: boolean;
} {
  const captureConfirmed =
    args.captureClassification === PAYMENT_SESSION_CAPTURE_CLASSIFICATION.CAPTURED_CONFIRMED
    || args.captureClassification === PAYMENT_SESSION_CAPTURE_CLASSIFICATION.PARTIALLY_CAPTURED_CONFIRMED;
  const settled = args.settledConfirmed === true
    || (confirmedPositiveCapturePence(args.financeClearedPence) != null);
  return {
    capture_confirmed: captureConfirmed,
    settled_confirmed: settled,
    early_cash_out_may_use_capture_alone: false,
    early_cash_out_eligible_from_settlement: settled,
  };
}

/** Recovery must not double-credit driver wallet when original earning already posted. */
export function recoveryWalletCreditDecision(args: {
  originalDriverEarningAlreadyCredited: boolean;
  recoveryCaptureConfirmed: boolean;
  driverEarningWithheldPendingRecovery: boolean;
}): {
  write_driver_credit: boolean;
  clear_finance_risk_only: boolean;
  release_withheld_earning: boolean;
} {
  if (!args.recoveryCaptureConfirmed) {
    return {
      write_driver_credit: false,
      clear_finance_risk_only: false,
      release_withheld_earning: false,
    };
  }
  if (args.originalDriverEarningAlreadyCredited) {
    return {
      write_driver_credit: false,
      clear_finance_risk_only: true,
      release_withheld_earning: false,
    };
  }
  if (args.driverEarningWithheldPendingRecovery) {
    return {
      write_driver_credit: true,
      clear_finance_risk_only: true,
      release_withheld_earning: true,
    };
  }
  return {
    write_driver_credit: true,
    clear_finance_risk_only: true,
    release_withheld_earning: false,
  };
}

/** Trip payment projection patch after confirmed capture / recovery. */
export function buildTripPaymentProjectionAfterCapture(args: {
  canonicalPayablePence: number | null | undefined;
  totalAuthorisedPence?: number | null;
  totalCapturedPence: number | null | undefined;
  paymentProvider?: string | null;
  paymentMethod?: string | null;
}): {
  payment_status: string;
  capture_amount_pence: number | null;
  authorised_amount_pence: number | null;
  outstanding_balance_pence: number;
  payment_coverage_status: string;
  payment_provider: string | null;
  payment_method: string | null;
} {
  const captured = confirmedPositiveCapturePence(args.totalCapturedPence);
  const payable = nonNegPence(args.canonicalPayablePence);
  const outstanding = computeOutstandingBalancePence({
    canonicalPayablePence: payable,
    confirmedCapturePence: captured,
  }) ?? 0;
  const coverage = captured == null
    ? "unknown"
    : outstanding <= TOLERANCE_PENCE
    ? "captured"
    : "partial";
  return {
    payment_status: captured != null ? "captured" : "pending",
    capture_amount_pence: captured,
    authorised_amount_pence: nonNegPence(args.totalAuthorisedPence),
    outstanding_balance_pence: outstanding,
    payment_coverage_status: coverage,
    payment_provider: args.paymentProvider ?? null,
    payment_method: args.paymentMethod ?? null,
  };
}
