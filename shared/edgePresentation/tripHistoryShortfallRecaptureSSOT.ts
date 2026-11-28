/** Admin presentation-only helpers; not part of Edge uploads. */
import { computeOutstandingShortfallPence, isFullyPaidCapturedCoverage, TripShortfallRecaptureUiState, TRIP_SHORTFALL_RECAPTURE_UI_STATE } from "../../supabase/functions/_shared/tripHistoryShortfallRecaptureSSOT.ts";


export function paymentCoverageBadgeLabel(args: {
  customerPayablePence: number | null | undefined;
  verifiedCapturedTotalPence: number | null | undefined;
  netRefundedTotalPence?: number | null | undefined;
  providerSettlementVerified: boolean;
  paymentStatus?: string | null;
  providerStatus?: string | null;
}): {
  label: string;
  tone: "fully_paid" | "partial" | "unpaid" | "unknown" | "canceled";
  outstandingPence: number | null;
} {
  const outstanding = computeOutstandingShortfallPence(args);
  const statusBlob = `${args.paymentStatus ?? ""} ${args.providerStatus ?? ""}`.toLowerCase();
  const looksCanceled = statusBlob.includes("cancel");

  if (isFullyPaidCapturedCoverage(args)) {
    return { label: "Fully paid / Captured", tone: "fully_paid", outstandingPence: 0 };
  }
  if (looksCanceled && (outstanding == null || outstanding > 0)) {
    return {
      label: outstanding != null && outstanding > 0
        ? "Canceled — shortfall unpaid"
        : "Canceled — settlement not verified",
      tone: "canceled",
      outstandingPence: outstanding,
    };
  }
  if (outstanding == null) {
    return { label: "Coverage unknown", tone: "unknown", outstandingPence: null };
  }
  if (outstanding > 0) {
    return { label: "Partially paid / Shortfall", tone: "partial", outstandingPence: outstanding };
  }
  if (!args.providerSettlementVerified) {
    return {
      label: "Provider settlement pending",
      tone: "unknown",
      outstandingPence: 0,
    };
  }
  return { label: "No fare recorded", tone: "unknown", outstandingPence: outstanding };
}


/**
 * Trip History recapture UI priority:
 * 1. Saved card charged
 * 2. Processing / pending provider state
 * 3. Customer action genuinely required
 * 4. Hard failure
 *
 * An open recovery session must not override saved-card success or processing.
 */
export function resolveRecaptureAttemptUi(args: {
  attemptState: TripShortfallRecaptureUiState | null;
  hasOpenRecoverySession: boolean;
  openRecoverySavedCardCharged?: boolean;
  openRecoverySavedCardPending?: boolean;
  gateUiState: TripShortfallRecaptureUiState;
}): {
  ui_state: TripShortfallRecaptureUiState;
  show_payment_link: boolean;
} {
  const attempt = args.attemptState;
  if (attempt === TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID) {
    return { ui_state: attempt, show_payment_link: false };
  }
  if (attempt === TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED) {
    return { ui_state: attempt, show_payment_link: false };
  }
  if (attempt === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING) {
    return { ui_state: attempt, show_payment_link: false };
  }
  if (attempt === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_FAILED) {
    return { ui_state: attempt, show_payment_link: false };
  }
  if (attempt === TRIP_SHORTFALL_RECAPTURE_UI_STATE.PAYMENT_METHOD_UNAVAILABLE) {
    return { ui_state: attempt, show_payment_link: false };
  }
  if (attempt === TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED) {
    return { ui_state: attempt, show_payment_link: true };
  }
  if (args.openRecoverySavedCardCharged === true) {
    return {
      ui_state: args.openRecoverySavedCardPending === true
        ? TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING
        : TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED,
      show_payment_link: false,
    };
  }
  if (attempt == null && args.hasOpenRecoverySession) {
    return {
      ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED,
      show_payment_link: true,
    };
  }
  return {
    ui_state: attempt ?? args.gateUiState,
    show_payment_link: false,
  };
}


export function recaptureAttemptBadgeLabel(uiState: TripShortfallRecaptureUiState): string {
  if (uiState === TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED) {
    return "Saved card charged";
  }
  if (uiState === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING) {
    return "Recapture processing";
  }
  if (uiState === TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED) {
    return "Customer action required";
  }
  if (uiState === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_FAILED) {
    return "Recapture failed";
  }
  if (uiState === TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID) {
    return "Fully paid";
  }
  return uiState;
}


export function recaptureActionLabel(outstandingPence: number, currencySymbol = "£"): string {
  const major = (Math.round(outstandingPence) / 100).toFixed(2);
  return `Recapture ${currencySymbol}${major}`;
}

export * from "../../supabase/functions/_shared/tripHistoryShortfallRecaptureSSOT.ts";
