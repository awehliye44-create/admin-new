/**
 * Trip History shortfall recapture — pure SSOT.
 *
 * Fully paid / Captured is allowed ONLY when:
 *   effective_paid_total >= customer_payable
 *   AND provider settlement is verified
 *   AND no unresolved reversal/refund reduces coverage below payable
 *
 * Never derive payment coverage from trip status alone.
 * Never treat provider "canceled" as fully paid.
 */

export const TRIP_SHORTFALL_RECAPTURE_UI_STATE = {
  RECAPTURE_AVAILABLE: "recapture_available",
  RECAPTURE_PROCESSING: "recapture_processing",
  CUSTOMER_ACTION_REQUIRED: "customer_action_required",
  SAVED_CARD_CHARGED: "saved_card_charged",
  RECAPTURE_SUCCEEDED: "recapture_succeeded",
  RECAPTURE_FAILED: "recapture_failed",
  PAYMENT_METHOD_UNAVAILABLE: "payment_method_unavailable",
  PROVIDER_SETTLEMENT_PENDING: "provider_settlement_pending",
  FULLY_PAID: "fully_paid",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
  NOT_ELIGIBLE: "not_eligible",
} as const;

export type TripShortfallRecaptureUiState =
  typeof TRIP_SHORTFALL_RECAPTURE_UI_STATE[keyof typeof TRIP_SHORTFALL_RECAPTURE_UI_STATE];

const TERMINAL_FAILED_CAPTURE_STATUSES = new Set([
  "canceled",
  "cancelled",
  "failed",
  "voided",
  "expired",
  "refunded",
  "reversed",
  "recovery_cancelled",
  "recovery_declined",
  "recovery_expired",
]);

const VERIFIED_CAPTURE_PROVIDER_STATES = new Set([
  "completed",
  "captured",
]);

const VERIFIED_CAPTURE_SESSION_STATUSES = new Set([
  "captured",
  "paid",
  "succeeded",
  "recovery_completed",
]);

function nonNegPence(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function upper(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase();
}

export function isDriverCollectedFinancialModel(
  financialModel: string | null | undefined,
): boolean {
  const m = String(financialModel ?? "").trim().toUpperCase();
  return m.includes("DRIVER_COLLECTED");
}

/** PLATFORM_COLLECTED or unset (UK/EU default). Explicit DRIVER_COLLECTED fails. */
export function isPlatformCollectedEligible(
  financialModel: string | null | undefined,
): boolean {
  if (isDriverCollectedFinancialModel(financialModel)) return false;
  const m = upper(financialModel);
  if (!m) return true;
  return m === "PLATFORM_COLLECTED";
}

function confirmedPositiveCaptureLike(amount: number | null | undefined): number | null {
  if (amount == null) return null;
  const n = Math.round(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Only count successfully settled provider captures.
 * Excludes canceled / failed / voided / expired / refunded / reversed amounts.
 */
export function isVerifiedSettledCaptureSession(args: {
  status?: string | null;
  provider_state?: string | null;
  captured_amount_pence?: number | null;
}): boolean {
  const amt = confirmedPositiveCaptureLike(args.captured_amount_pence);
  if (amt == null) return false;
  const status = String(args.status ?? "").trim().toLowerCase();
  const provider = String(args.provider_state ?? "").trim().toLowerCase();
  if (TERMINAL_FAILED_CAPTURE_STATUSES.has(status) || TERMINAL_FAILED_CAPTURE_STATUSES.has(provider)) {
    return false;
  }
  if (VERIFIED_CAPTURE_SESSION_STATUSES.has(status)) return true;
  if (VERIFIED_CAPTURE_PROVIDER_STATES.has(provider)) return true;
  return false;
}

export function sumVerifiedCapturedFromSessions(
  sessions: Array<{
    purpose?: string | null;
    status?: string | null;
    provider_state?: string | null;
    captured_amount_pence?: number | null;
  }>,
): { original_captured_pence: number; recaptured_pence: number; total_verified_captured_pence: number } {
  let original = 0;
  let recovery = 0;
  for (const s of sessions) {
    if (!isVerifiedSettledCaptureSession(s)) continue;
    const amt = confirmedPositiveCaptureLike(s.captured_amount_pence) ?? 0;
    if (upper(s.purpose) === "PAYMENT_RECOVERY") recovery += amt;
    else original += amt;
  }
  return {
    original_captured_pence: original,
    recaptured_pence: recovery,
    total_verified_captured_pence: original + recovery,
  };
}

/** Sum verified provider refunds that reduce paid coverage. */
export function sumVerifiedRefundedFromSessions(
  sessions: Array<{
    refunded_amount_pence?: number | null;
  }>,
): number {
  let refunded = 0;
  for (const s of sessions) {
    const amt = confirmedPositiveCaptureLike(s.refunded_amount_pence);
    if (amt != null) refunded += amt;
  }
  return refunded;
}

/** Effective paid = verified captures − net refunds (floored at 0). */
export function computeEffectivePaidTotalPence(args: {
  verifiedCapturedTotalPence: number | null | undefined;
  netRefundedTotalPence?: number | null | undefined;
}): number {
  const captured = Math.max(0, nonNegPence(args.verifiedCapturedTotalPence) ?? 0);
  const refunded = Math.max(0, nonNegPence(args.netRefundedTotalPence) ?? 0);
  return Math.max(0, captured - refunded);
}

export function computeOutstandingShortfallPence(args: {
  customerPayablePence: number | null | undefined;
  verifiedCapturedTotalPence: number | null | undefined;
  netRefundedTotalPence?: number | null | undefined;
}): number | null {
  const payable = nonNegPence(args.customerPayablePence);
  if (payable == null) return null;
  const paid = computeEffectivePaidTotalPence(args);
  return Math.max(0, payable - paid);
}

/**
 * Hard rule 11 — Fully paid / Captured gate.
 * Unknown outstanding (null) is NEVER treated as fully paid.
 */
export function isFullyPaidCapturedCoverage(args: {
  customerPayablePence: number | null | undefined;
  verifiedCapturedTotalPence: number | null | undefined;
  netRefundedTotalPence?: number | null | undefined;
  providerSettlementVerified: boolean;
  paymentStatus?: string | null;
  providerStatus?: string | null;
}): boolean {
  const payable = nonNegPence(args.customerPayablePence);
  if (payable == null || payable <= 0) return false;
  if (!args.providerSettlementVerified) return false;

  const statusBlob = `${args.paymentStatus ?? ""} ${args.providerStatus ?? ""}`.toLowerCase();
  if (
    statusBlob.includes("cancel")
    || statusBlob.includes("fail")
    || statusBlob.includes("void")
    || statusBlob.includes("expired")
  ) {
    return false;
  }

  const paid = computeEffectivePaidTotalPence(args);
  if (paid <= 0) return false;
  return paid >= payable;
}

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
 * Trip History may initiate recapture only when all gates pass.
 * Client never supplies the charge amount — backend recomputes shortfall.
 */
export function evaluateTripHistoryShortfallRecaptureEligibility(args: {
  tripStatus: string | null | undefined;
  financialModel?: string | null;
  paymentMethod?: string | null;
  customerPayablePence: number | null | undefined;
  verifiedCapturedTotalPence: number | null | undefined;
  netRefundedTotalPence?: number | null | undefined;
  providerSettlementVerified?: boolean;
  hasOpenRecoveryAttempt?: boolean;
  paymentMethodAvailable?: boolean;
  adminPermitted?: boolean;
}): {
  eligible: boolean;
  ui_state: TripShortfallRecaptureUiState;
  outstanding_shortfall_pence: number | null;
  reject_reason: string | null;
} {
  const outstanding = computeOutstandingShortfallPence(args);

  if (args.adminPermitted === false) {
    return {
      eligible: false,
      ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.NOT_ELIGIBLE,
      outstanding_shortfall_pence: outstanding,
      reject_reason: "admin_not_permitted",
    };
  }

  if (String(args.tripStatus ?? "").toLowerCase() !== "completed") {
    return {
      eligible: false,
      ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.NOT_ELIGIBLE,
      outstanding_shortfall_pence: outstanding,
      reject_reason: "trip_not_completed",
    };
  }

  if (!isPlatformCollectedEligible(args.financialModel)) {
    return {
      eligible: false,
      ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.NOT_ELIGIBLE,
      outstanding_shortfall_pence: outstanding,
      reject_reason: "driver_collected_not_allowed",
    };
  }

  const method = String(args.paymentMethod ?? "").toLowerCase();
  if (method.includes("cash")) {
    return {
      eligible: false,
      ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.NOT_ELIGIBLE,
      outstanding_shortfall_pence: outstanding,
      reject_reason: "payment_method_not_provider_capture",
    };
  }

  if (args.hasOpenRecoveryAttempt) {
    return {
      eligible: false,
      ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING,
      outstanding_shortfall_pence: outstanding,
      reject_reason: "recapture_already_processing",
    };
  }

  if (args.paymentMethodAvailable === false) {
    return {
      eligible: false,
      ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.PAYMENT_METHOD_UNAVAILABLE,
      outstanding_shortfall_pence: outstanding,
      reject_reason: "payment_method_unavailable",
    };
  }

  if (outstanding == null) {
    return {
      eligible: false,
      ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.PROVIDER_SETTLEMENT_PENDING,
      outstanding_shortfall_pence: null,
      reject_reason: "outstanding_unresolvable",
    };
  }

  if (outstanding <= 0) {
    if (
      isFullyPaidCapturedCoverage({
        ...args,
        providerSettlementVerified: args.providerSettlementVerified === true,
      })
    ) {
      return {
        eligible: false,
        ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID,
        outstanding_shortfall_pence: 0,
        reject_reason: "already_fully_paid",
      };
    }
    if (args.providerSettlementVerified !== true) {
      return {
        eligible: false,
        ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.PROVIDER_SETTLEMENT_PENDING,
        outstanding_shortfall_pence: 0,
        reject_reason: "provider_settlement_pending",
      };
    }
    return {
      eligible: false,
      ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID,
      outstanding_shortfall_pence: 0,
      reject_reason: "no_shortfall",
    };
  }

  return {
    eligible: true,
    ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_AVAILABLE,
    outstanding_shortfall_pence: outstanding,
    reject_reason: null,
  };
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

export type AdminRecaptureRecoveryInput = {
  saved_card_charged?: unknown;
  requires_customer_action?: unknown;
  checkout_url?: unknown;
  status?: unknown;
  already_completed?: unknown;
  reused?: unknown;
  message?: unknown;
};

export type AdminRecaptureOutcome = {
  saved_card_charged: boolean;
  requires_customer_action: boolean;
  status: TripShortfallRecaptureUiState;
  show_payment_link: boolean;
  already_completed: boolean;
  reused: boolean;
  message: string | null;
};

/**
 * Classify create-payment-recovery output for Trip History recapture.
 * A leftover checkout_url must never override a confirmed saved-card charge.
 */
export function deriveAdminRecaptureOutcome(
  recovery: AdminRecaptureRecoveryInput,
): AdminRecaptureOutcome {
  const alreadyCompleted = recovery.already_completed === true;
  const savedCardCharged = recovery.saved_card_charged === true;
  const reused = recovery.reused === true;
  const checkoutUrl = asNonEmptyString(recovery.checkout_url);
  const recoveryStatus = asNonEmptyString(recovery.status);
  const explicitRequiresAction = recovery.requires_customer_action === true
    || recoveryStatus === "CUSTOMER_ACTION_REQUIRED"
    || recoveryStatus === TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED;

  const requiresCustomerAction = alreadyCompleted
    ? false
    : savedCardCharged && recovery.requires_customer_action !== true
      ? false
      : explicitRequiresAction
        || (!savedCardCharged && (
          Boolean(checkoutUrl)
          || recoveryStatus === "RECOVERY_CHECKOUT_CREATED"
        ));

  let status: TripShortfallRecaptureUiState =
    TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING;
  if (alreadyCompleted) {
    status = TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID;
  } else if (savedCardCharged && !requiresCustomerAction) {
    status = TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED;
  } else if (requiresCustomerAction) {
    status = TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED;
  }

  return {
    saved_card_charged: savedCardCharged && !requiresCustomerAction,
    requires_customer_action: requiresCustomerAction,
    status,
    show_payment_link: requiresCustomerAction,
    already_completed: alreadyCompleted,
    reused,
    message: asNonEmptyString(recovery.message),
  };
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

/** Payment Sessions list label for recovery capture rows. */
export function recapturedAmountDisplayLabel(
  recapturedPence: number,
  currencySymbol = "£",
): string {
  const major = (Math.round(recapturedPence) / 100).toFixed(2);
  return `Recaptured ${currencySymbol}${major}`;
}

/** Reject arbitrary client charge amounts (backend-only shortfall). */
export function rejectClientChargeAmountFields(body: Record<string, unknown>): {
  ok: true;
} | { ok: false; code: string; message: string } {
  if (body.amount_pence != null || body.amount != null || body.charge_pence != null) {
    return {
      ok: false,
      code: "AMOUNT_NOT_ALLOWED",
      message: "Arbitrary charge amounts are not accepted. Backend calculates the outstanding shortfall.",
    };
  }
  if (
    body.customer_id != null
    || body.payment_method_id != null
    || body.provider_transaction_id != null
  ) {
    return {
      ok: false,
      code: "EXTRA_FIELDS_NOT_ALLOWED",
      message: "Only trip_id is accepted for shortfall recapture",
    };
  }
  return { ok: true };
}
