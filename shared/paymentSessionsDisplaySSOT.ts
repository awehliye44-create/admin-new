/**
 * Payment Sessions (SSOT) display normalisation — user-facing labels + evidence rules.
 * Pure; no React money math. Amounts come from Phase 1A columns only.
 */

export type PaymentSessionsCanonicalStatus =
  | "AUTHORISED"
  | "CAPTURE_PENDING"
  | "CAPTURED"
  | "CAPTURED_EVIDENCE_PENDING"
  | "RELEASED"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "FAILED"
  | "UNKNOWN";

export type PaymentSessionsEvidenceStatus =
  | "COMPLETE"
  | "CAPTURE_AMOUNT_MISSING"
  | "AMOUNT_UNCONFIRMED"
  | "PENDING_PROVIDER_FEE"
  | "INCOMPLETE";

export type PaymentSessionsFeeDisplay = {
  label: string;
  badge: "ACTUAL" | "ESTIMATED" | "PENDING" | "UNAVAILABLE" | null;
  amount_pence: number | null;
};

export type PaymentSessionsDisplayInput = {
  raw_session_status: string | null;
  provider_state: string | null;
  provider_verification_status?: "VERIFIED" | "STALE" | "UNKNOWN" | "UNAVAILABLE" | null;
  authorised_amount_pence: number | null;
  captured_amount_pence: number | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
  provider_processing_fee_pence: number | null;
  fee_status: string | null;
  captured_at?: string | null;
  released_at?: string | null;
  refunded_at?: string | null;
  hold_classification?: string | null;
  classification?: "GREEN" | "AMBER" | "RED" | null;
};

export type PaymentSessionsDisplayResult = {
  session_status_display: PaymentSessionsCanonicalStatus;
  session_status_label: string;
  evidence_status: PaymentSessionsEvidenceStatus;
  evidence_label: string;
  reconciliation_status: string;
  classification: "GREEN" | "AMBER" | "RED";
  fee_display: PaymentSessionsFeeDisplay;
  provider_state_label: string;
  technical_status: string | null;
};

function upper(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase();
}

export function isProviderCapturedState(providerState: string | null | undefined): boolean {
  const s = upper(providerState);
  return s === "CAPTURED" || s === "COMPLETED";
}

export function isProviderReleasedState(providerState: string | null | undefined): boolean {
  const s = upper(providerState);
  return s === "CANCELLED" || s === "REVERTED" || s === "CANCELED";
}

export function isProviderRefundedState(providerState: string | null | undefined): boolean {
  return upper(providerState) === "REFUNDED";
}

export function isProviderAuthorisedState(providerState: string | null | undefined): boolean {
  const s = upper(providerState);
  return s === "AUTHORISED" || s === "AUTHORIZED" || s === "ACTIVE_AUTHORISED" || s === "PENDING";
}

/** Map raw DB/session status + provider evidence → user-facing canonical status. */
export function mapCanonicalSessionStatus(input: PaymentSessionsDisplayInput): PaymentSessionsCanonicalStatus {
  const raw = String(input.raw_session_status ?? "").trim().toLowerCase();
  const providerCaptured = isProviderCapturedState(input.provider_state);
  const providerReleased = isProviderReleasedState(input.provider_state);
  const providerRefunded = isProviderRefundedState(input.provider_state);

  if (providerRefunded || raw === "refunded" || (input.refunded_at && input.refunded_amount_pence != null)) {
    if (
      input.captured_amount_pence != null
      && input.refunded_amount_pence != null
      && input.refunded_amount_pence > 0
      && input.refunded_amount_pence < input.captured_amount_pence
    ) {
      return "PARTIALLY_REFUNDED";
    }
    return "REFUNDED";
  }

  if (providerCaptured || input.captured_at || raw === "captured") {
    if (input.captured_amount_pence == null) return "CAPTURED_EVIDENCE_PENDING";
    return "CAPTURED";
  }

  if (raw === "completed_pending_capture") return "CAPTURE_PENDING";

  if (
    providerReleased
    || raw === "released"
    || raw === "cancelled"
    || input.released_at
  ) {
    return providerReleased && upper(input.provider_state) === "REVERTED" ? "RELEASED" : "RELEASED";
  }

  if (
    raw === "payment_authorised"
    || raw === "authorised_hold"
    || raw === "trip_created"
    || isProviderAuthorisedState(input.provider_state)
  ) {
    return "AUTHORISED";
  }

  if (raw.includes("fail") || upper(input.provider_state) === "FAILED") return "FAILED";
  return "UNKNOWN";
}

export function sessionStatusLabel(status: PaymentSessionsCanonicalStatus): string {
  switch (status) {
    case "CAPTURED_EVIDENCE_PENDING":
      return "CAPTURED EVIDENCE PENDING";
    case "CAPTURE_PENDING":
      return "CAPTURE PENDING";
    case "PARTIALLY_REFUNDED":
      return "PARTIALLY REFUNDED";
    default:
      return status;
  }
}

export function derivePaymentSessionsEvidenceStatus(
  input: PaymentSessionsDisplayInput,
): { status: PaymentSessionsEvidenceStatus; label: string } {
  const providerCaptured = isProviderCapturedState(input.provider_state);
  if ((providerCaptured || input.captured_at) && input.captured_amount_pence == null) {
    return {
      status: "CAPTURE_AMOUNT_MISSING",
      label: "Captured amount not recorded",
    };
  }
  if (input.released_at && input.released_amount_pence == null) {
    return { status: "AMOUNT_UNCONFIRMED", label: "Released amount unconfirmed" };
  }
  if (input.refunded_at && input.refunded_amount_pence == null) {
    return { status: "AMOUNT_UNCONFIRMED", label: "Refunded amount unconfirmed" };
  }
  const fee = upper(input.fee_status);
  if (
    (providerCaptured || input.captured_at)
    && input.captured_amount_pence != null
    && (fee === "PENDING" || (input.fee_status == null && input.provider_processing_fee_pence == null))
  ) {
    return { status: "PENDING_PROVIDER_FEE", label: "Pending provider fee" };
  }
  if (
    (providerCaptured || input.captured_at)
    && input.captured_amount_pence != null
  ) {
    return { status: "COMPLETE", label: "COMPLETE" };
  }
  if (input.released_at && input.released_amount_pence != null) {
    return { status: "COMPLETE", label: "COMPLETE" };
  }
  if (input.refunded_at && input.refunded_amount_pence != null) {
    return { status: "COMPLETE", label: "COMPLETE" };
  }
  return { status: "INCOMPLETE", label: "INCOMPLETE" };
}

export function deriveFeeDisplay(input: {
  provider_processing_fee_pence: number | null;
  fee_status: string | null;
}): PaymentSessionsFeeDisplay {
  const status = upper(input.fee_status);
  if (status === "UNAVAILABLE") {
    return { label: "Fee unavailable", badge: "UNAVAILABLE", amount_pence: null };
  }
  if (status === "PENDING" || (input.fee_status == null && input.provider_processing_fee_pence == null)) {
    return { label: "Pending provider fee", badge: "PENDING", amount_pence: null };
  }
  if (input.provider_processing_fee_pence == null) {
    return { label: "Pending provider fee", badge: "PENDING", amount_pence: null };
  }
  if (status === "ESTIMATED") {
    return {
      label: "ESTIMATED",
      badge: "ESTIMATED",
      amount_pence: input.provider_processing_fee_pence,
    };
  }
  return {
    label: "ACTUAL",
    badge: status === "ACTUAL" ? "ACTUAL" : "ACTUAL",
    amount_pence: input.provider_processing_fee_pence,
  };
}

export function derivePaymentSessionsReconciliation(
  input: PaymentSessionsDisplayInput,
  evidence: PaymentSessionsEvidenceStatus,
  canonical: PaymentSessionsCanonicalStatus,
): { reconciliation_status: string; classification: "GREEN" | "AMBER" | "RED" } {
  if (evidence === "CAPTURE_AMOUNT_MISSING") {
    return {
      reconciliation_status: "ATTENTION_CAPTURE_AMOUNT_MISSING",
      classification: "AMBER",
    };
  }
  if (evidence === "PENDING_PROVIDER_FEE") {
    return {
      reconciliation_status: "PENDING_PROVIDER_FEE",
      classification: "AMBER",
    };
  }
  if (evidence === "AMOUNT_UNCONFIRMED") {
    return {
      reconciliation_status: "AMOUNT_UNCONFIRMED",
      classification: "AMBER",
    };
  }
  if (input.provider_verification_status === "STALE") {
    return {
      reconciliation_status: "PROVIDER_VERIFICATION_STALE",
      classification: "AMBER",
    };
  }

  const providerCaptured = isProviderCapturedState(input.provider_state);
  const raw = String(input.raw_session_status ?? "").toLowerCase();
  if (
    providerCaptured
    && (raw === "cancelled" || raw === "released" || raw === "payment_authorised" || raw === "authorised_hold")
    && !input.captured_at
  ) {
    return {
      reconciliation_status: "CONFLICT_PROVIDER_CAPTURED_LOCAL_NOT",
      classification: "RED",
    };
  }

  if (canonical === "CAPTURED" && evidence === "COMPLETE") {
    return {
      reconciliation_status: "OK_CAPTURED",
      classification: "GREEN",
    };
  }
  if (canonical === "RELEASED" || canonical === "CANCELLED") {
    return {
      reconciliation_status: "OK_RELEASED",
      classification: input.released_amount_pence == null ? "AMBER" : "GREEN",
    };
  }
  if (canonical === "REFUNDED" || canonical === "PARTIALLY_REFUNDED") {
    return {
      reconciliation_status: "OK_REFUNDED",
      classification: input.refunded_amount_pence == null ? "AMBER" : "GREEN",
    };
  }
  if (canonical === "AUTHORISED") {
    return {
      reconciliation_status: "OK_AUTHORISED",
      classification: input.classification === "RED" ? "RED" : "AMBER",
    };
  }

  if (input.classification === "RED") {
    return {
      reconciliation_status: input.hold_classification ?? "ATTENTION",
      classification: "RED",
    };
  }
  if (input.classification === "AMBER") {
    return {
      reconciliation_status: input.hold_classification ?? "ATTENTION",
      classification: "AMBER",
    };
  }
  return {
    reconciliation_status: input.hold_classification ?? "OK",
    classification: "GREEN",
  };
}

export function buildPaymentSessionsDisplay(
  input: PaymentSessionsDisplayInput,
): PaymentSessionsDisplayResult {
  const canonical = mapCanonicalSessionStatus(input);
  const evidence = derivePaymentSessionsEvidenceStatus(input);
  const recon = derivePaymentSessionsReconciliation(input, evidence.status, canonical);
  const fee = deriveFeeDisplay(input);
  const verified = input.provider_verification_status === "VERIFIED" ? "VERIFIED" : (
    input.provider_verification_status ?? "UNKNOWN"
  );
  const providerState = upper(input.provider_state) || "UNKNOWN";

  return {
    session_status_display: canonical,
    session_status_label: sessionStatusLabel(canonical),
    evidence_status: evidence.status,
    evidence_label: evidence.label,
    reconciliation_status: recon.reconciliation_status,
    classification: recon.classification,
    fee_display: fee,
    provider_state_label: `${providerState} — ${verified}`,
    technical_status: input.raw_session_status,
  };
}

/** Tab membership — Captured includes provider-verified capture even when amount is null. */
export function rowBelongsInCapturedTab(row: {
  captured_at?: string | null;
  captured_amount_pence?: number | null;
  provider_state?: string | null;
  provider_verification_status?: string | null;
  attention_class?: string | null;
}): boolean {
  if (row.captured_at) return true;
  if (isProviderCapturedState(row.provider_state)) return true;
  return row.attention_class === "CAPTURED";
}

export function rowBelongsInReleasedTab(row: {
  released_at?: string | null;
  released_amount_pence?: number | null;
  provider_state?: string | null;
  attention_class?: string | null;
  session_status?: string | null;
}): boolean {
  if (row.released_at) return true;
  if (isProviderReleasedState(row.provider_state)) return true;
  if (
    row.attention_class === "RESOLVED_PROVIDER_CANCELLED"
    || row.attention_class === "RESOLVED_PROVIDER_REVERTED"
  ) {
    return true;
  }
  return Boolean(row.session_status && /releas|cancel/i.test(row.session_status));
}

export function rowBelongsInRefundedTab(row: {
  refunded_at?: string | null;
  refunded_amount_pence?: number | null;
  provider_state?: string | null;
  attention_class?: string | null;
}): boolean {
  if (row.refunded_at) return true;
  if (row.refunded_amount_pence != null) return true;
  if (isProviderRefundedState(row.provider_state)) return true;
  return row.attention_class === "REFUNDED";
}

export function rowBelongsInActiveHoldsTab(row: {
  in_active_queue?: boolean;
  classification?: string | null;
  provider_state?: string | null;
  captured_at?: string | null;
  released_at?: string | null;
  refunded_at?: string | null;
  attention_class?: string | null;
}): boolean {
  if (row.captured_at || isProviderCapturedState(row.provider_state)) return false;
  if (row.released_at || isProviderReleasedState(row.provider_state)) return false;
  if (row.refunded_at || isProviderRefundedState(row.provider_state)) return false;
  if (
    row.attention_class === "CAPTURED"
    || row.attention_class === "REFUNDED"
    || row.attention_class === "RESOLVED_PROVIDER_CANCELLED"
    || row.attention_class === "RESOLVED_PROVIDER_REVERTED"
  ) {
    return false;
  }
  return Boolean(row.in_active_queue && row.classification !== "GREEN");
}
