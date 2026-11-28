/**
 * Financial Reconciliation — canonical comparison classifiers (audit only).
 * Consumes Payment Sessions / trip settlement / wallet / payout evidence — never invents amounts.
 */

import { readPersistedCaptureBreakdown } from "./paymentSessionsCaptureBreakdownSSOT.ts";
import {
  evaluateFrSettlementCaptureIdentity,
  isFrTripFullyBalanced,
  resolveFrTripAuditStatus,
  FR_TRIP_AUDIT_STATUS,
} from "./frConsumeOnlySSOT.ts";

export {
  evaluateFrSettlementCaptureIdentity as evaluateSettlementCaptureIdentity,
  isFrTripFullyBalanced as isTripAuditFullyBalanced,
  resolveFrTripAuditStatus,
  FR_TRIP_AUDIT_STATUS,
};

export type CaptureReconciliationStatus =
  | "MATCHED"
  | "CAPTURE_PENDING"
  | "CAPTURE_MISSING"
  | "CAPTURE_SHORTFALL"
  | "OVERCAPTURE"
  | "CAPTURE_AMOUNT_UNKNOWN"
  | "NO_PAYMENT_SESSION"
  | "PROVIDER_VERIFICATION_PENDING"
  | "PAYMENT_SESSION_CAPTURE_MISMATCH"
  | "PAYMENT_SESSION_AMBIGUOUS"
  | "CAPTURE_MISMATCH"
  | "PAYMENT_EVIDENCE_UNAVAILABLE";

export type ReleaseReconciliationStatus =
  | "RELEASE_MATCHED"
  | "RELEASE_PENDING"
  | "RELEASE_AMOUNT_UNKNOWN"
  | "RELEASE_AMOUNT_UNCONFIRMED"
  | "MISSING_RELEASE"
  | "RELEASE_SHORTFALL"
  | "OVERRELEASE"
  | "RELEASE_NOT_REQUIRED";

export type RefundReconciliationStatus =
  | "REFUND_MATCHED"
  | "REFUND_PENDING"
  | "REFUND_MISMATCH"
  | "OVERREFUND";

export type WalletReconciliationStatus =
  | "WALLET_MATCHED"
  | "WALLET_PENDING"
  | "WALLET_CREDIT_MISSING"
  | "WALLET_OVER_CREDITED"
  | "WALLET_UNDER_CREDITED"
  | "WALLET_DUPLICATE"
  | "WALLET_EVIDENCE_UNAVAILABLE"
  /** @deprecated Use WALLET_OVER_CREDITED */
  | "WALLET_OVER_CREDIT"
  /** @deprecated Use WALLET_UNDER_CREDITED */
  | "WALLET_UNDER_CREDIT"
  /** @deprecated Use WALLET_DUPLICATE */
  | "DUPLICATE_WALLET_CREDIT"
  /** @deprecated Use WALLET_PENDING */
  | "WALLET_CREDIT_PENDING";

export type PayoutReconciliationStatus =
  | "PAYOUT_NOT_DUE"
  | "PAYOUT_SCHEDULED"
  | "PAYOUT_PROCESSING"
  | "PAYOUT_PAID"
  | "PAYOUT_FAILED"
  | "PAYOUT_MISMATCH"
  | "DUPLICATE_PAYOUT_RISK"
  | "PAYOUT_EVIDENCE_UNAVAILABLE";

export const TOLERANCE_PENCE = 1;
const PROVIDER_VERIFICATION_STALE_MS = 15 * 60 * 1000;

export function classifyProviderVerificationStatus(args: {
  provider_state?: string | null;
  provider_verified_at?: string | null;
  nowMs?: number;
}): "VERIFIED" | "STALE" | "UNKNOWN" {
  if (!args.provider_state) return "UNKNOWN";
  if (!args.provider_verified_at) return "STALE";
  const age = (args.nowMs ?? Date.now()) - Date.parse(args.provider_verified_at);
  if (!Number.isFinite(age) || age > PROVIDER_VERIFICATION_STALE_MS) return "STALE";
  return "VERIFIED";
}

/**
 * expected_release = authorised − captured (audit only).
 * Consumes Payment Sessions release_evidence_status when present.
 * Never treats NULL released amount as £0.
 */
export function classifyReleaseReconciliation(args: {
  authorised_pence: number | null;
  captured_pence: number | null;
  released_pence: number | null;
  release_evidence_status?: string | null;
  /** Provider order state — terminal COMPLETED/CAPTURED residual ≠ actionable MISSING_RELEASE. */
  provider_state?: string | null;
}): ReleaseReconciliationStatus {
  const evidence = String(args.release_evidence_status ?? "").toUpperCase();
  const providerState = String(args.provider_state ?? "").toUpperCase();
  const providerTerminalCapture =
    providerState === "COMPLETED" || providerState === "CAPTURED";
  const providerAuthStillLive =
    providerState === "AUTHORISED"
    || providerState === "AUTHORIZED"
    || providerState === "PROCESSING";

  if (evidence === "NOT_REQUIRED") return "RELEASE_NOT_REQUIRED";
  if (evidence === "AMOUNT_UNCONFIRMED") return "RELEASE_AMOUNT_UNCONFIRMED";
  if (evidence === "CONFIRMED" && args.released_pence != null) {
    if (args.authorised_pence == null || args.captured_pence == null) {
      return "RELEASE_MATCHED";
    }
    const expected = Math.max(0, args.authorised_pence - args.captured_pence);
    if (expected === 0) return "RELEASE_MATCHED";
    const variance = args.released_pence - expected;
    if (Math.abs(variance) <= TOLERANCE_PENCE) return "RELEASE_MATCHED";
    if (variance < 0) return "RELEASE_SHORTFALL";
    return "OVERRELEASE";
  }
  if (
    evidence === "PENDING_PROVIDER_CONFIRMATION"
    || evidence === "PROVIDER_STATE_UNAVAILABLE"
    || evidence === "FAILED"
  ) {
    return "RELEASE_PENDING";
  }

  if (args.authorised_pence == null || args.captured_pence == null) {
    return "RELEASE_AMOUNT_UNKNOWN";
  }
  const expected = Math.max(0, args.authorised_pence - args.captured_pence);
  if (expected === 0) {
    if (args.released_pence == null || args.released_pence === 0) return "RELEASE_MATCHED";
    return "OVERRELEASE";
  }
  // Residual expected but no confirmed release amount.
  if (args.released_pence == null) {
    // #75A: terminal capture with residual voided → amount unconfirmed, not actionable missing.
    if (providerTerminalCapture) return "RELEASE_AMOUNT_UNCONFIRMED";
    // Live authorisation still holding residual → outstanding / pending.
    if (providerAuthStillLive) return "RELEASE_PENDING";
    return "MISSING_RELEASE";
  }
  const variance = args.released_pence - expected;
  if (Math.abs(variance) <= TOLERANCE_PENCE) return "RELEASE_MATCHED";
  if (variance < 0) return "RELEASE_SHORTFALL";
  return "OVERRELEASE";
}

/**
 * Compare PS cumulative refund to approved refund evidence when available.
 * Without approved evidence, non-zero refunds stay REFUND_PENDING (never invent match).
 */
export function classifyRefundReconciliation(args: {
  refunded_pence: number | null;
  approved_refund_pence?: number | null;
}): RefundReconciliationStatus {
  if (args.refunded_pence == null) return "REFUND_PENDING";
  if (args.approved_refund_pence == null) {
    return args.refunded_pence === 0 ? "REFUND_MATCHED" : "REFUND_PENDING";
  }
  const variance = args.refunded_pence - args.approved_refund_pence;
  if (Math.abs(variance) <= TOLERANCE_PENCE) return "REFUND_MATCHED";
  if (variance > 0) return "OVERREFUND";
  return "REFUND_MISMATCH";
}

export function classifyPayoutReconciliation(args: {
  payoutEvidenceAvailable: boolean;
  payout_status_label?: string | null;
  payout_amount_pence?: number | null;
  eligible_amount_pence?: number | null;
}): PayoutReconciliationStatus {
  if (!args.payoutEvidenceAvailable) return "PAYOUT_EVIDENCE_UNAVAILABLE";
  const label = String(args.payout_status_label ?? "").toLowerCase();
  if (label.includes("fail")) return "PAYOUT_FAILED";
  if (label.includes("duplicate")) return "DUPLICATE_PAYOUT_RISK";
  if (label.includes("mismatch") || label.includes("error")) return "PAYOUT_MISMATCH";
  if (label.includes("process") || label.includes("in_transit") || label.includes("transfer")) {
    return "PAYOUT_PROCESSING";
  }
  if (label.includes("schedul") || label.includes("pending") || label.includes("queued")) {
    return "PAYOUT_SCHEDULED";
  }
  if (label.includes("paid") || label.includes("complete") || label.includes("settled")) {
    if (
      args.payout_amount_pence != null
      && args.eligible_amount_pence != null
      && Math.abs(args.payout_amount_pence - args.eligible_amount_pence) > TOLERANCE_PENCE
    ) {
      return "PAYOUT_MISMATCH";
    }
    return "PAYOUT_PAID";
  }
  return "PAYOUT_NOT_DUE";
}

export function onecabNetFromSessionFee(args: {
  gross_commission_pence: number;
  provider_processing_fee_pence: number | null;
  sessionsMapPresent: boolean;
}): number | null {
  // Unknown fee is not £0 — never invent onecab_net = gross.
  if (!args.sessionsMapPresent) return null;
  if (args.provider_processing_fee_pence == null) return null;
  return Math.max(0, args.gross_commission_pence - args.provider_processing_fee_pence);
}

/** @deprecated Use isFrTripFullyBalanced / evaluateFrSettlementCaptureIdentity (re-exported). */

export type FrAuditOverviewKpis = {
  /** Payment Sessions expected capture (Completed Trips Paid) — never raw trip fare. */
  completed_trip_fare_total_pence: number;
  confirmed_provider_captured_total_pence: number;
  /** Sum of PS authorised amounts (nullable rows skipped). */
  total_authorised_pence: number;
  /** Audit-only expected residual = max(0, auth − capture) when both known. */
  expected_released_pence: number;
  /** Provider-confirmed released only (NULL never counted as £0). */
  released_total_pence: number;
  release_amount_unconfirmed_count: number;
  refunded_total_pence: number;
  waiting_charges_total_pence: number;
  provider_fee_total_pence: number;
  onecab_gross_commission_pence: number;
  onecab_net_commission_pence: number | null;
  /** Tip-exclusive fare net. */
  driver_net_total_pence: number;
  driver_fare_net_total_pence?: number;
  driver_entitlement_total_pence?: number;
  wallet_credits_total_pence: number;
  payouts_completed_pence: number;
  /** Non-commissionable — Payment Sessions capture breakdown. */
  airport_charges_total_pence: number;
  /** Non-commissionable — Payment Sessions capture breakdown. */
  driver_tips_total_pence: number;
  commissionable_fare_total_pence: number;
  /** Exact: captured − (driver_net + gross_commission + airport + tips). Null when not evaluable. */
  settlement_identity_variance_pence: number | null;
  settlement_identity_balanced: boolean;
  unallocated_pence: number | null;
  /** PS classification CAPTURE_SHORTFALL / UNEXPLAINED_SHORTFALL only. */
  capture_shortfall_pence: number;
  /** PS classification UNEXPLAINED_OVERCAPTURE only — never waiting charges. */
  overcapture_pence: number;
  missing_captures_count: number;
  missing_releases_count: number;
    missing_wallet_credits_count: number;
    payout_mismatches_count: number;
    wallet_mismatches_count: number;
    driver_credit_exception_trip_count?: number;
    driver_credit_exception_difference_pence?: number;
    balanced_trips_count: number;
  unresolved_mismatches_count: number;
  trip_count: number;
};

export function isPsUnexplainedOvercapture(row: {
  capture_reconciliation_status?: string | null;
  capture_classification?: string | null;
}): boolean {
  return row.capture_reconciliation_status === "OVERCAPTURE"
    || row.capture_classification === "UNEXPLAINED_OVERCAPTURE";
}

export function isPsCaptureShortfall(row: {
  capture_reconciliation_status?: string | null;
  capture_classification?: string | null;
}): boolean {
  return row.capture_reconciliation_status === "CAPTURE_SHORTFALL"
    || row.capture_classification === "CAPTURE_SHORTFALL"
    || row.capture_classification === "UNEXPLAINED_SHORTFALL";
}

export function isMissingCaptureRow(row: {
  payment_method?: string | null;
  capture_reconciliation_status?: string | null;
  captured_pence?: number | null;
  capture_mismatch?: boolean | null;
}): boolean {
  const method = String(row.payment_method ?? "").toLowerCase();
  if (method === "cash" || method.includes("cash")) return false;
  // CAPTURE_AMOUNT_UNKNOWN = PS breakdown pending — not a missing capture.
  if (row.capture_reconciliation_status === "CAPTURE_AMOUNT_UNKNOWN") return false;
  return row.capture_reconciliation_status === "CAPTURE_MISSING"
    || row.capture_reconciliation_status === "CAPTURE_PENDING"
    || row.capture_reconciliation_status === "PAYMENT_SESSION_CAPTURE_MISMATCH"
    || row.captured_pence == null
    || Boolean(row.capture_mismatch);
}

export function isMissingReleaseRow(row: {
  release_reconciliation_status?: string | null;
}): boolean {
  // AMOUNT_UNCONFIRMED = residual proven gone, amount not explicit — counted separately.
  // NOT_REQUIRED / MATCHED = closed.
  return row.release_reconciliation_status === "MISSING_RELEASE"
    || row.release_reconciliation_status === "RELEASE_PENDING"
    || row.release_reconciliation_status === "RELEASE_SHORTFALL"
    || row.release_reconciliation_status === "RELEASE_AMOUNT_UNKNOWN";
}
