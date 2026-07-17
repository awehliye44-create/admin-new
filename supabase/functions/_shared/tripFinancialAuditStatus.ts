/**
 * Trip Financial Audit status badges — derived from live financial records only.
 * Recalculated on every reconciliation request (no cached status text).
 */

import {
  getTripDebtRecoveredPence,
  getTripDriverNetPence
} from "./tripSettlementFinanceSSOT.ts";
import { type TripSSOTRow } from "./financialReconciliationSSOT.ts";

export type TripAuditStatusTone = "green" | "yellow" | "blue" | "orange" | "gray" | "red";

export type TripAuditStatusBadge = {
  label: string;
  tone: TripAuditStatusTone;
};

export type TripAuditPaymentRecord = {
  /** payments.status — stripe payment intent / capture lifecycle */
  status: string | null;
  provider_status: string | null;
  captured_amount_pence: number | null;
  stripe_payment_intent_id?: string | null;
  /** Stripe balance transaction available date (funds settled to balance) */
  provider_available_on?: string | null;
};

export type TripAuditPayoutRecord = {
  status: string;
  driver_amount_pence?: number | null;
  amount_pence?: number | null;
  batch_status?: string | null;
  batch_id?: string | null;
};

export type TripAuditLedgerRecord = {
  type: string;
  amount_pence: number;
  stripe_payout_id?: string | null;
  stripe_transfer_id?: string | null;
};

export type TripAuditStatusTrip = Partial<TripSSOTRow> & {
  id: string;
  payment_status?: string | null;
  financial_outcome?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_charge_id?: string | null;
  stripe_settlement_verified?: boolean | null;
  stripe_settlement_warning?: string | null;
  provider_status?: string | null;
  refunded_at?: string | null;
};

export type TripAuditStatusInput = {
  trip: TripAuditStatusTrip;
  payment?: TripAuditPaymentRecord | null;
  payouts?: TripAuditPayoutRecord[];
  ledger?: TripAuditLedgerRecord[];
};

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}


function paidOutPence(payouts: TripAuditPayoutRecord[]): number {
  let total = 0;
  for (const p of payouts) {
    const status = norm(p.status);
    if (status !== "completed" && status !== "paid") continue;
    total += Math.max(0, p.driver_amount_pence ?? p.amount_pence ?? 0);
  }
  return total;
}

function hasCompletedPayout(payouts: TripAuditPayoutRecord[]): boolean {
  return payouts.some((p) => {
    const s = norm(p.status);
    return s === "completed" || s === "paid";
  });
}

function hasPendingPayout(payouts: TripAuditPayoutRecord[]): boolean {
  return payouts.some((p) => includesAny(norm(p.status), ["pending", "processing", "transfer_created"]));
}

function ledgerTypes(ledger: TripAuditLedgerRecord[]): Set<string> {
  return new Set(ledger.map((e) => String(e.type ?? "").toUpperCase()));
}

function stripePaymentIntentStatus(input: TripAuditStatusInput): string {
  return norm(input.payment?.status) || norm(input.trip.payment_status);
}

function stripeCaptureStatus(input: TripAuditStatusInput): string {
  if (capturedPence(input) > 0) return "captured";
  const s = stripePaymentIntentStatus(input);
  if (includesAny(s, ["captured", "paid", "succeeded", "completed"])) return "captured";
  if (includesAny(s, ["pending_capture", "requires_capture", "authorized", "requires_confirmation"])) {
    return "pending_capture";
  }
  return s;
}

function isDisputed(input: TripAuditStatusInput): boolean {
  const fields = [
    input.trip.payment_status,
    input.trip.financial_outcome,
    input.trip.provider_status,
    input.trip.stripe_settlement_warning,
    input.payment?.status,
    input.payment?.provider_status,
  ].map(norm);
  return fields.some((f) => includesAny(f, ["dispute", "disputed", "chargeback", "under_review"]));
}

function refundPence(input: TripAuditStatusInput): number {
  return Math.max(0, input.trip.refund_amount_pence ?? 0);
}

function hasRefundStatus(input: TripAuditStatusInput): boolean {
  if (refundPence(input) > 0) return true;
  if (input.trip.refunded_at) return true;
  const fields = [norm(input.trip.payment_status), norm(input.payment?.status)].filter(Boolean);
  return fields.some((f) => includesAny(f, ["refund", "refunded", "partially_refunded"]));
}

function capturedPence(input: TripAuditStatusInput): number {
  // Never invent from trips.capture_amount_pence — Payment Sessions / payment evidence only.
  return Math.max(0, input.payment?.captured_amount_pence ?? 0);
}

function isFullyRefunded(input: TripAuditStatusInput): boolean {
  const refunded = refundPence(input);
  const captured = capturedPence(input);
  return refunded > 0 && captured > 0 && refunded >= captured;
}

function hasRefund(input: TripAuditStatusInput): boolean {
  return hasRefundStatus(input);
}

function isCardCaptured(input: TripAuditStatusInput): boolean {
  return stripeCaptureStatus(input) === "captured";
}

function stripeBalanceTransactionSettled(input: TripAuditStatusInput): boolean {
  if (input.trip.stripe_settlement_verified === true) return true;
  if (input.payment?.provider_available_on) {
    const availableOn = new Date(input.payment.provider_available_on).getTime();
    if (!Number.isNaN(availableOn) && availableOn <= Date.now()) return true;
  }
  return false;
}

function isProviderSettled(input: TripAuditStatusInput): boolean {
  if (stripeBalanceTransactionSettled(input)) return true;
  const providerFields = [
    norm(input.trip.provider_status),
    norm(input.payment?.provider_status),
  ];
  return providerFields.some((s) =>
    includesAny(s, ["settled", "available", "paid", "succeeded", "balance_available"])
  );
}

function payoutStatus(input: TripAuditStatusInput): string {
  const payouts = input.payouts ?? [];
  if (payouts.some((p) => norm(p.status) === "completed" || norm(p.status) === "paid")) {
    return "completed";
  }
  if (payouts.some((p) => includesAny(norm(p.status), ["pending", "processing", "transfer_created"]))) {
    return "pending";
  }
  if (payouts.some((p) => includesAny(norm(p.batch_status ?? ""), ["completed", "paid", "processing"]))) {
    return norm(payouts.find((p) => p.batch_status)?.batch_status ?? "") || "batched";
  }
  return payouts[0]?.status ? norm(payouts[0].status) : "";
}

function commissionStatus(input: TripAuditStatusInput): string {
  if (isCardCaptured(input) || isProviderSettled(input)) return "earned";
  return Math.max(0, input.trip.commission_pence ?? 0) > 0 ? "earned" : "pending";
}

export function deriveDriverPayoutAuditStatus(input: TripAuditStatusInput): TripAuditStatusBadge {
  if (isDisputed(input)) {
    return { label: "On Hold", tone: "orange" };
  }

  if (hasRefund(input)) {
    return { label: "Reversed", tone: "red" };
  }

  const payout = payoutStatus(input);
  if (payout === "completed" || hasCompletedPayout(input.payouts ?? []) || paidOutPence(input.payouts ?? []) > 0) {
    return { label: "Paid Out", tone: "green" };
  }

  const driverNet = getTripDriverNetPence({
    driver_net_pence: input.trip.driver_net_pence,
    ledger: input.ledger ?? [],
  });
  const debtRecovered = getTripDebtRecoveredPence(input.ledger ?? []);
  if (
    isCardCaptured(input)
    && driverNet != null
    && driverNet > 0
    && debtRecovered >= driverNet
  ) {
    return { label: "Debt recovered / No payout due", tone: "blue" };
  }

  if (isCardCaptured(input) || hasPendingPayout(input.payouts ?? []) || payout === "pending" || payout === "batched") {
    return { label: "Awaiting Payout", tone: "yellow" };
  }

  if (isCardCaptured(input)) {
    return { label: "Awaiting Payout", tone: "yellow" };
  }

  return { label: "Awaiting Payout", tone: "yellow" };
}

export function deriveOnecabCommissionAuditStatus(input: TripAuditStatusInput): TripAuditStatusBadge {
  if (isDisputed(input)) {
    return { label: "Under Review", tone: "orange" };
  }

  if (hasRefund(input)) {
    return { label: "Reversed", tone: "red" };
  }

  if (commissionStatus(input) === "earned") {
    return { label: "Earned", tone: "green" };
  }

  if (isCardCaptured(input)) {
    return { label: "Earned", tone: "green" };
  }

  return { label: "Earned", tone: "green" };
}

export function deriveProviderAuditStatus(input: TripAuditStatusInput): TripAuditStatusBadge {
  if (isDisputed(input)) {
    return { label: "Disputed", tone: "orange" };
  }

  if (hasRefund(input)) {
    return { label: isFullyRefunded(input) ? "Refunded" : "Refunded", tone: "red" };
  }

  if (isProviderSettled(input)) {
    return { label: "Settled", tone: "green" };
  }

  const capture = stripeCaptureStatus(input);
  if (capture === "captured") {
    return { label: "Captured", tone: "blue" };
  }

  const ps = stripePaymentIntentStatus(input);
  if (includesAny(ps, ["recovery_required"])) {
    return { label: "Recovery required", tone: "orange" };
  }
  if (includesAny(ps, ["failed", "canceled", "cancelled"])) {
    return { label: "Capture Failed", tone: "red" };
  }

  if (includesAny(ps, ["pending_capture", "requires_capture", "authorized", "processing"])) {
    return { label: "Pending Capture", tone: "yellow" };
  }

  if (input.trip.stripe_payment_intent_id || input.payment?.stripe_payment_intent_id) {
    return { label: "Pending Capture", tone: "yellow" };
  }

  return { label: "Pending Capture", tone: "yellow" };
}

export function deriveTripFinancialAuditStatuses(
  input: TripAuditStatusInput,
): {
  driver_payout: TripAuditStatusBadge;
  onecab_commission: TripAuditStatusBadge;
  provider: TripAuditStatusBadge;
} {
  return {
    driver_payout: deriveDriverPayoutAuditStatus(input),
    onecab_commission: deriveOnecabCommissionAuditStatus(input),
    provider: deriveProviderAuditStatus(input),
  };
}

/** Per-trip reconciliation badge — informational only; never used to filter trip list. */
export function deriveTripReconciliationBadge(args: {
  capture_mismatch: boolean;
  captured_pence: number | null;
  refunded_pence: number | null;
  settlement_total_pence: number;
  provider: TripAuditStatusBadge;
  financial_outcome?: string | null;
  trip_status?: string | null;
  payment_status?: string | null;
  capture_reconciliation_status?: string | null;
  release_reconciliation_status?: string | null;
  wallet_reconciliation_status?: string | null;
  payout_reconciliation_status?: string | null;
  fee_status?: string | null;
}): TripAuditStatusBadge {
  const outcome = norm(args.financial_outcome);
  const tripStatus = norm(args.trip_status);
  const paymentStatus = norm(args.payment_status);
  if (
    outcome.includes("cancel")
    || tripStatus.includes("cancel")
    || paymentStatus.includes("cancel")
  ) {
    return { label: "Cancelled", tone: "gray" };
  }
  const captureStatus = String(args.capture_reconciliation_status ?? "");
  const walletStatus = String(args.wallet_reconciliation_status ?? "");
  const payoutStatus = String(args.payout_reconciliation_status ?? "");
  if (
    captureStatus === "PAYMENT_SESSION_CAPTURE_MISMATCH"
    || captureStatus === "CAPTURE_MISMATCH"
    || captureStatus === "CAPTURE_SHORTFALL"
    || captureStatus === "OVERCAPTURE"
    || captureStatus === "CAPTURE_MISSING"
    || captureStatus === "NO_PAYMENT_SESSION"
  ) {
    return {
      label: captureStatus === "PAYMENT_SESSION_CAPTURE_MISMATCH"
        || captureStatus === "CAPTURE_MISMATCH"
        ? "CAPTURE_MISMATCH"
        : "Mismatch",
      tone: "red",
    };
  }
  const releaseStatus = String(args.release_reconciliation_status ?? "");
  if (releaseStatus === "RELEASE_AMOUNT_UNCONFIRMED") {
    return { label: "RELEASE_AMOUNT_UNCONFIRMED", tone: "yellow" };
  }
  if (
    releaseStatus === "MISSING_RELEASE"
    || releaseStatus === "RELEASE_PENDING"
    || releaseStatus === "RELEASE_SHORTFALL"
  ) {
    return { label: "MISSING_RELEASE", tone: "yellow" };
  }
  if (
    walletStatus === "WALLET_CREDIT_MISSING"
    || walletStatus === "WALLET_OVER_CREDIT"
    || walletStatus === "WALLET_UNDER_CREDIT"
    || walletStatus === "DUPLICATE_WALLET_CREDIT"
  ) {
    return { label: "Wallet Mismatch", tone: "red" };
  }
  if (
    payoutStatus === "PAYOUT_MISMATCH"
    || payoutStatus === "PAYOUT_FAILED"
    || payoutStatus === "DUPLICATE_PAYOUT_RISK"
  ) {
    return { label: "Payout Mismatch", tone: "red" };
  }
  if (args.captured_pence != null && args.captured_pence > 0
    && args.refunded_pence != null && args.refunded_pence >= args.captured_pence) {
    return { label: "Refunded", tone: "red" };
  }
  if (args.capture_mismatch) {
    return { label: "Mismatch", tone: "red" };
  }
  if (
    captureStatus === "PROVIDER_VERIFICATION_PENDING"
    || captureStatus === "CAPTURE_PENDING"
    || captureStatus === "PAYMENT_EVIDENCE_UNAVAILABLE"
    || walletStatus === "WALLET_EVIDENCE_UNAVAILABLE"
    || payoutStatus === "PAYOUT_EVIDENCE_UNAVAILABLE"
    || args.fee_status === "PENDING_PROVIDER_FEE"
    || args.fee_status === "PENDING"
    || args.fee_status === "UNAVAILABLE"
  ) {
    return { label: "Evidence Pending", tone: "yellow" };
  }
  if (args.captured_pence == null) {
    return { label: "Pending Capture", tone: "yellow" };
  }
  const providerLabel = norm(args.provider.label);
  if (includesAny(providerLabel, ["pending capture", "requires_capture", "authorized", "processing"])) {
    return { label: "Pending Capture", tone: "yellow" };
  }
  if (
    includesAny(providerLabel, ["awaiting", "pending"])
    || args.provider.tone === "yellow"
    || payoutStatus === "PAYOUT_SCHEDULED"
    || payoutStatus === "PAYOUT_PROCESSING"
  ) {
    return { label: "Pending Settlement", tone: "yellow" };
  }
  // GREEN only when capture matched AND wallet matched — never WALLET_CREDIT_PENDING.
  if (
    captureStatus === "MATCHED"
    && walletStatus === "WALLET_MATCHED"
    && payoutStatus !== "PAYOUT_MISMATCH"
    && releaseStatus !== "MISSING_RELEASE"
    && releaseStatus !== "RELEASE_AMOUNT_UNCONFIRMED"
    && releaseStatus !== "RELEASE_PENDING"
    && releaseStatus !== "RELEASE_SHORTFALL"
  ) {
    return { label: "BALANCED", tone: "green" };
  }
  // Never invent Balanced when classifiers disagree or are absent.
  return { label: "PARTIAL", tone: "yellow" };
}

export function deriveTripCaptureStatusLabel(
  input: TripAuditStatusInput,
  captureMismatch: boolean,
): string {
  if (captureMismatch) return "Capture mismatch";
  if (hasRefund(input)) {
    return isFullyRefunded(input) ? "Fully refunded" : "Partially refunded";
  }
  const capture = stripeCaptureStatus(input);
  if (capture === "captured") return "Captured";
  const ps = stripePaymentIntentStatus(input);
  if (includesAny(ps, ["failed", "canceled", "cancelled"])) return "Capture failed";
  if (includesAny(ps, ["pending_capture", "requires_capture", "authorized", "processing"])) {
    return "Pending capture";
  }
  return deriveProviderAuditStatus(input).label;
}
