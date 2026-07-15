/**
 * Payment Sessions (SSOT) display normalisation — user-facing labels + evidence rules.
 * Pure; no React money math. Amounts come from Phase 1A columns only.
 */

export type PaymentSessionsCanonicalStatus =
  | "AUTHORISED"
  | "CAPTURE_PENDING"
  | "CAPTURED"
  | "CAPTURED_EVIDENCE_PENDING"
  | "CAPTURE_FAILED"
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

  // CANCELLED is distinct from RELEASED (spec status vocabulary).
  if (
    raw === "cancelled"
    || upper(input.provider_state) === "CANCELLED"
    || upper(input.provider_state) === "CANCELED"
  ) {
    return "CANCELLED";
  }

  if (providerReleased || raw === "released" || input.released_at) {
    return "RELEASED";
  }

  if (
    raw === "payment_authorised"
    || raw === "authorised_hold"
    || raw === "trip_created"
    || isProviderAuthorisedState(input.provider_state)
  ) {
    return "AUTHORISED";
  }

  if (
    raw.includes("capture_fail")
    || raw === "capture_failed"
    || (raw.includes("fail") && raw.includes("capture"))
    || (upper(input.provider_state) === "FAILED" && input.captured_amount_pence == null)
  ) {
    return "CAPTURE_FAILED";
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
    case "CAPTURE_FAILED":
      return "CAPTURE FAILED";
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

/** Tab membership — Captured = confirmed captures only (amount present). Stripe Payments style. */
export function rowBelongsInCapturedTab(row: {
  captured_at?: string | null;
  captured_amount_pence?: number | null;
  provider_state?: string | null;
  provider_verification_status?: string | null;
  attention_class?: string | null;
}): boolean {
  if (row.captured_amount_pence == null || !Number.isFinite(Number(row.captured_amount_pence))) {
    return false;
  }
  if (Number(row.captured_amount_pence) < 0) return false;
  if (row.captured_at) return true;
  if (isProviderCapturedState(row.provider_state)) return true;
  return row.attention_class === "CAPTURED";
}

/** Released tab = released holds only — never Cancelled (Cancelled stays in History). */
export function rowBelongsInReleasedTab(row: {
  released_at?: string | null;
  released_amount_pence?: number | null;
  release_evidence_status?: string | null;
  provider_state?: string | null;
  attention_class?: string | null;
  session_status?: string | null;
  session_status_display?: string | null;
}): boolean {
  const display = upper(row.session_status_display);
  const provider = upper(row.provider_state);
  const evidence = upper(row.release_evidence_status);
  if (display === "CANCELLED" || provider === "CANCELLED" || provider === "CANCELED") {
    return false;
  }
  if (row.attention_class === "RESOLVED_PROVIDER_CANCELLED") return false;
  if (row.released_at) return true;
  if (
    evidence === "CONFIRMED"
    || evidence === "AMOUNT_UNCONFIRMED"
  ) {
    return true;
  }
  if (provider === "REVERTED") return true;
  if (row.attention_class === "RESOLVED_PROVIDER_REVERTED") return true;
  return Boolean(row.session_status && /releas/i.test(row.session_status) && !/cancel/i.test(row.session_status));
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

/** Active Holds = all live authorisations — never captured / released / refunded / cancelled. */
export function rowBelongsInActiveHoldsTab(row: {
  in_active_queue?: boolean;
  classification?: string | null;
  provider_state?: string | null;
  captured_at?: string | null;
  released_at?: string | null;
  refunded_at?: string | null;
  attention_class?: string | null;
  captured_amount_pence?: number | null;
  authorised_amount_pence?: number | null;
  session_status_display?: string | null;
}): boolean {
  if (row.captured_at || isProviderCapturedState(row.provider_state)) return false;
  if (row.captured_amount_pence != null) return false;
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
  const display = upper(row.session_status_display);
  if (
    display === "CAPTURED"
    || display === "RELEASED"
    || display === "CANCELLED"
    || display === "REFUNDED"
    || display === "PARTIALLY_REFUNDED"
    || display === "CAPTURE_FAILED"
  ) {
    return false;
  }
  // Include healthy trip-linked auths (OK_ACTIVE_TRIP / GREEN) — not attention-queue only.
  if (isProviderAuthorisedState(row.provider_state)) return true;
  if (display === "AUTHORISED" || display === "CAPTURE_PENDING") return true;
  if (row.in_active_queue) return true;
  return row.authorised_amount_pence != null && Number(row.authorised_amount_pence) > 0;
}

/** Confirmed capture amount for revenue KPIs — never invent £0; never treat 0 as confirmed. */
export function confirmedCapturedRevenuePence(row: {
  captured_amount_pence?: number | null;
}): number | null {
  if (row.captured_amount_pence == null) return null;
  const n = Number(row.captured_amount_pence);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/** Display helper: never render £0.00 as a normal confirmed capture. */
export function formatCapturedAmountDisplay(args: {
  captured_amount_pence: number | null | undefined;
  currencyFormatter: (pence: number | null) => string;
}): string {
  if (confirmedCapturedRevenuePence({ captured_amount_pence: args.captured_amount_pence }) == null) {
    return "Not recorded locally";
  }
  return args.currencyFormatter(Math.round(Number(args.captured_amount_pence)));
}

/**
 * Slice 9 display bridge: DB enum remains AMOUNT_UNCONFIRMED (never invent amount).
 * Operator-facing primary label aligns to MANUAL_REVIEW_REQUIRED.
 */
export function formatReleasedAmountDisplay(args: {
  released_amount_pence: number | null | undefined;
  released_at?: string | null;
  release_evidence_status?: string | null;
  currencyFormatter: (pence: number | null) => string;
}): { primary: string; secondary: string | null } {
  const evidence = String(args.release_evidence_status ?? "").toUpperCase();
  const amountUnconfirmed =
    evidence === "AMOUNT_UNCONFIRMED"
    || Boolean(args.released_at && args.released_amount_pence == null);
  if (amountUnconfirmed) {
    return {
      primary: "MANUAL_REVIEW_REQUIRED",
      secondary: "DB: AMOUNT_UNCONFIRMED · amount NULL (fail-closed)",
    };
  }
  if (args.released_amount_pence == null) {
    return { primary: "—", secondary: null };
  }
  return {
    primary: args.currencyFormatter(Math.round(Number(args.released_amount_pence))),
    secondary: null,
  };
}

/** Released Buffer Total — post-capture buffer releases only (never full uncaptured hold cancels). */
export function sumReleasedBufferTotalPence(
  providerRows: Array<{
    authorised_amount_pence?: number | null;
    captured_amount_pence?: number | null;
    released_amount_pence?: number | null;
  }>,
): number | null {
  let releasedBuffer: number | null = null;
  for (const row of providerRows) {
    const cap = confirmedCapturedRevenuePence(row);
    const authRaw = row.authorised_amount_pence == null ? null : Number(row.authorised_amount_pence);
    const auth = authRaw != null && Number.isFinite(authRaw) && authRaw > 0
      ? Math.round(authRaw)
      : null;
    if (cap == null || auth == null || auth <= cap) continue;
    const releasedRaw = row.released_amount_pence == null ? null : Number(row.released_amount_pence);
    if (releasedRaw == null || !Number.isFinite(releasedRaw) || releasedRaw <= 0) continue;
    releasedBuffer = (releasedBuffer ?? 0) + Math.round(releasedRaw);
  }
  return releasedBuffer;
}

