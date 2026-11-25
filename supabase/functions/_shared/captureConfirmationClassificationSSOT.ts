/**
 * CaptureSSOT classification — exact integer pence (no 1p tolerance).
 *
 * FULLY_CAPTURED: confirmed === payable
 * PARTIALLY_CAPTURED: 0 < confirmed < payable
 * OVERCAPTURE_ANOMALY: confirmed > payable (reconcile; no auto write-off/refund)
 * ZERO_PAYABLE: payable === 0 → use existing no-payment-required contract
 */

export type CaptureConfirmationClass =
  | "NO_PAYMENT_REQUIRED"
  | "NOT_CAPTURED"
  | "PARTIALLY_CAPTURED"
  | "FULLY_CAPTURED"
  | "OVERCAPTURE_ANOMALY";

export type CaptureConfirmationState =
  | "CAPTURE_REQUESTED"
  | "CAPTURE_PENDING"
  | "CAPTURE_UNKNOWN"
  | "PARTIALLY_CAPTURED"
  | "FULLY_CAPTURED"
  | "CAPTURE_FAILED"
  | "RECOVERY_REQUIRED"
  | "OVERCAPTURE_ANOMALY";

function intPence(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Exact classification. Zero payable uses explicit no-payment-required path.
 */
export function classifyCaptureConfirmation(args: {
  payablePence: number;
  confirmedCapturedPence: number | null | undefined;
  /** Existing no-payment / certification / cash-collected contract. */
  noPaymentRequired?: boolean;
}): {
  class: CaptureConfirmationClass;
  outstandingPence: number;
  overcapturePence: number;
  isFullyCaptured: boolean;
  isPartiallyCaptured: boolean;
  settlementEligibleForPolicyA: boolean;
} {
  const payable = intPence(args.payablePence);
  const confirmed = args.confirmedCapturedPence == null
    ? null
    : intPence(args.confirmedCapturedPence);

  if (args.noPaymentRequired === true || payable === 0) {
    return {
      class: "NO_PAYMENT_REQUIRED",
      outstandingPence: 0,
      overcapturePence: 0,
      isFullyCaptured: true,
      isPartiallyCaptured: false,
      // Zero-payable / non-card: existing contracts decide TEN separately.
      settlementEligibleForPolicyA: false,
    };
  }

  if (confirmed == null || confirmed <= 0) {
    return {
      class: "NOT_CAPTURED",
      outstandingPence: payable,
      overcapturePence: 0,
      isFullyCaptured: false,
      isPartiallyCaptured: false,
      settlementEligibleForPolicyA: false,
    };
  }

  if (confirmed === payable) {
    return {
      class: "FULLY_CAPTURED",
      outstandingPence: 0,
      overcapturePence: 0,
      isFullyCaptured: true,
      isPartiallyCaptured: false,
      settlementEligibleForPolicyA: true,
    };
  }

  if (confirmed < payable) {
    return {
      class: "PARTIALLY_CAPTURED",
      outstandingPence: payable - confirmed,
      overcapturePence: 0,
      isFullyCaptured: false,
      isPartiallyCaptured: true,
      // Policy A: TEN on full trip-fare after verified PS capture (existing).
      settlementEligibleForPolicyA: true,
    };
  }

  return {
    class: "OVERCAPTURE_ANOMALY",
    outstandingPence: 0,
    overcapturePence: confirmed - payable,
    isFullyCaptured: false,
    isPartiallyCaptured: false,
    settlementEligibleForPolicyA: false,
  };
}

export function captureConfirmationStateFromClass(
  classification: CaptureConfirmationClass,
  args?: { unknown?: boolean; failed?: boolean; recovery?: boolean },
): CaptureConfirmationState {
  if (args?.failed) return "CAPTURE_FAILED";
  if (args?.recovery) return "RECOVERY_REQUIRED";
  if (args?.unknown) return "CAPTURE_UNKNOWN";
  switch (classification) {
    case "FULLY_CAPTURED":
    case "NO_PAYMENT_REQUIRED":
      return "FULLY_CAPTURED";
    case "PARTIALLY_CAPTURED":
      return "PARTIALLY_CAPTURED";
    case "OVERCAPTURE_ANOMALY":
      return "OVERCAPTURE_ANOMALY";
    default:
      return "CAPTURE_REQUESTED";
  }
}

/**
 * Provider evidence required before any confirmed capture write.
 * HTTP success / requested amount / order total / local status are insufficient.
 */
export function isBoundProviderCaptureEvidence(args: {
  merchantAccountRef?: string | null;
  paymentSessionId?: string | null;
  providerOrderId?: string | null;
  currency?: string | null;
  providerState?: string | null;
  confirmedCapturedPence?: number | null;
  amountFromProviderGet?: boolean;
  payableSnapshotId?: string | null;
}): boolean {
  const state = String(args.providerState ?? "").toUpperCase();
  if (state !== "COMPLETED" && state !== "CAPTURED") return false;
  if (args.amountFromProviderGet !== true) return false;
  if (!String(args.paymentSessionId ?? "").trim()) return false;
  if (!String(args.providerOrderId ?? "").trim()) return false;
  if (intPence(args.confirmedCapturedPence) <= 0) return false;
  // Merchant + currency + snapshot binding preferred; soft-required when present.
  if (args.currency != null && String(args.currency).trim() === "") return false;
  return true;
}

/**
 * Ambiguous provider outcomes never prove failure.
 */
export function isAmbiguousProviderFinancialOutcome(args: {
  providerState?: string | null;
  httpStatus?: number | null;
  timedOut?: boolean;
  pollExpired?: boolean;
}): boolean {
  if (args.timedOut || args.pollExpired) return true;
  const http = args.httpStatus;
  if (http != null && http >= 500) return true;
  const state = String(args.providerState ?? "").toUpperCase();
  return (
    state === "AUTHORISED" ||
    state === "AUTHORIZED" ||
    state === "PROCESSING" ||
    state === "PENDING" ||
    state === ""
  );
}
