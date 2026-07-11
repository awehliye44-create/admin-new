/**
 * Financial Reconciliation — canonical comparison classifiers (audit only).
 * Consumes Payment Sessions / trip settlement / wallet / payout evidence — never invents amounts.
 */

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
  | "PAYMENT_EVIDENCE_UNAVAILABLE";

export type ReleaseReconciliationStatus =
  | "RELEASE_MATCHED"
  | "RELEASE_PENDING"
  | "RELEASE_AMOUNT_UNKNOWN"
  | "RELEASE_SHORTFALL"
  | "OVERRELEASE";

export type RefundReconciliationStatus =
  | "REFUND_MATCHED"
  | "REFUND_PENDING"
  | "REFUND_MISMATCH"
  | "OVERREFUND";

export type WalletReconciliationStatus =
  | "WALLET_MATCHED"
  | "WALLET_CREDIT_PENDING"
  | "WALLET_CREDIT_MISSING"
  | "WALLET_OVER_CREDIT"
  | "WALLET_UNDER_CREDIT"
  | "DUPLICATE_WALLET_CREDIT"
  | "WALLET_EVIDENCE_UNAVAILABLE";

export type PayoutReconciliationStatus =
  | "PAYOUT_NOT_DUE"
  | "PAYOUT_SCHEDULED"
  | "PAYOUT_PROCESSING"
  | "PAYOUT_PAID"
  | "PAYOUT_FAILED"
  | "PAYOUT_MISMATCH"
  | "DUPLICATE_PAYOUT_RISK"
  | "PAYOUT_EVIDENCE_UNAVAILABLE";

const TOLERANCE_PENCE = 1;
const PROVIDER_VERIFICATION_STALE_MS = 15 * 60 * 1000;

/** actual_capture - expected_capture (final customer fare). */
export function captureVariancePence(args: {
  captured_pence: number | null;
  final_customer_fare_pence: number | null;
}): number | null {
  if (args.captured_pence == null || args.final_customer_fare_pence == null) return null;
  return args.captured_pence - args.final_customer_fare_pence;
}

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

export function classifyCaptureReconciliation(args: {
  isCash: boolean;
  paymentEvidenceStatus?: string | null;
  captured_pence: number | null;
  final_customer_fare_pence: number | null;
  authorised_pence?: number | null;
  provider_verification_status?: "VERIFIED" | "STALE" | "UNKNOWN" | null;
  /** Completed-trip audit: missing capture is CAPTURE_MISSING not pending. */
  tripCompleted?: boolean;
}): CaptureReconciliationStatus {
  if (args.isCash) return "MATCHED";
  if (args.paymentEvidenceStatus === "PAYMENT_EVIDENCE_UNAVAILABLE") {
    return "PAYMENT_EVIDENCE_UNAVAILABLE";
  }
  if (args.paymentEvidenceStatus === "NO_PAYMENT_SESSION") {
    return "NO_PAYMENT_SESSION";
  }
  if (args.provider_verification_status === "STALE") {
    return "PROVIDER_VERIFICATION_PENDING";
  }
  if (args.captured_pence == null) {
    // Completed-trip audit: PS present but capture £0/unknown → RED mismatch (MK rule).
    if (args.paymentEvidenceStatus === "PAYMENT_SESSIONS") {
      return args.tripCompleted === false ? "CAPTURE_PENDING" : "PAYMENT_SESSION_CAPTURE_MISMATCH";
    }
    if (args.authorised_pence != null && args.authorised_pence > 0) {
      return args.tripCompleted === false ? "CAPTURE_PENDING" : "CAPTURE_MISSING";
    }
    return "CAPTURE_AMOUNT_UNKNOWN";
  }
  if (args.captured_pence <= 0) return "PAYMENT_SESSION_CAPTURE_MISMATCH";
  const expected = args.final_customer_fare_pence;
  if (expected == null) return "CAPTURE_AMOUNT_UNKNOWN";
  const variance = args.captured_pence - expected;
  if (Math.abs(variance) <= TOLERANCE_PENCE) return "MATCHED";
  if (variance < 0) return "CAPTURE_SHORTFALL";
  return "OVERCAPTURE";
}

/** expected_release = authorised − captured; never invent when either side unknown. */
export function classifyReleaseReconciliation(args: {
  authorised_pence: number | null;
  captured_pence: number | null;
  released_pence: number | null;
}): ReleaseReconciliationStatus {
  if (args.authorised_pence == null || args.captured_pence == null) {
    return "RELEASE_AMOUNT_UNKNOWN";
  }
  const expected = Math.max(0, args.authorised_pence - args.captured_pence);
  if (expected === 0) {
    if (args.released_pence == null || args.released_pence === 0) return "RELEASE_MATCHED";
    return "OVERRELEASE";
  }
  if (args.released_pence == null) return "RELEASE_PENDING";
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

export function classifyWalletReconciliation(args: {
  walletEvidenceAvailable: boolean;
  expected_driver_net_pence: number | null;
  actual_wallet_credit_pence: number | null;
  duplicate_wallet_credit?: boolean;
}): WalletReconciliationStatus {
  if (!args.walletEvidenceAvailable) return "WALLET_EVIDENCE_UNAVAILABLE";
  if (args.duplicate_wallet_credit) return "DUPLICATE_WALLET_CREDIT";
  if (args.actual_wallet_credit_pence == null) {
    if (args.expected_driver_net_pence != null && args.expected_driver_net_pence > 0) {
      return "WALLET_CREDIT_MISSING";
    }
    return "WALLET_CREDIT_PENDING";
  }
  if (args.expected_driver_net_pence == null) return "WALLET_CREDIT_PENDING";
  const variance = args.actual_wallet_credit_pence - args.expected_driver_net_pence;
  if (Math.abs(variance) <= TOLERANCE_PENCE) return "WALLET_MATCHED";
  if (variance > 0) return "WALLET_OVER_CREDIT";
  return "WALLET_UNDER_CREDIT";
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

/** Sum TRIP_EARNING_NET credits for a trip — actual wallet credit from Driver Wallet Ledger. */
export function sumTripWalletEarningCreditPence(
  ledger: Array<{ type: string; amount_pence: number }>,
): { credit_pence: number | null; entry_count: number } {
  let total = 0;
  let count = 0;
  for (const entry of ledger) {
    if (entry.type !== "TRIP_EARNING_NET") continue;
    if (entry.amount_pence < 0) continue;
    total += entry.amount_pence;
    count += 1;
  }
  if (count === 0) return { credit_pence: null, entry_count: 0 };
  return { credit_pence: total, entry_count: count };
}

export function onecabNetFromSessionFee(args: {
  gross_commission_pence: number;
  provider_processing_fee_pence: number | null;
  sessionsMapPresent: boolean;
}): number | null {
  if (!args.sessionsMapPresent) {
    return Math.max(0, args.gross_commission_pence);
  }
  if (args.provider_processing_fee_pence == null) return null;
  return Math.max(0, args.gross_commission_pence - args.provider_processing_fee_pence);
}

/** Trip is fully balanced only when capture + wallet agree and payout is not inconsistent. */
export function isTripAuditFullyBalanced(args: {
  capture_reconciliation_status?: string | null;
  wallet_reconciliation_status?: string | null;
  payout_reconciliation_status?: string | null;
  fee_status?: string | null;
}): boolean {
  const captureOk = args.capture_reconciliation_status === "MATCHED";
  const walletOk =
    args.wallet_reconciliation_status === "WALLET_MATCHED"
    || args.wallet_reconciliation_status === "WALLET_CREDIT_PENDING";
  const payoutBad =
    args.payout_reconciliation_status === "PAYOUT_MISMATCH"
    || args.payout_reconciliation_status === "PAYOUT_FAILED"
    || args.payout_reconciliation_status === "DUPLICATE_PAYOUT_RISK";
  const feeBlocks =
    args.fee_status === "PENDING_PROVIDER_FEE"
    || args.fee_status === "PENDING"
    || args.fee_status === "UNAVAILABLE";
  return captureOk && walletOk && !payoutBad && !feeBlocks;
}

export type FrAuditOverviewKpis = {
  completed_trip_fare_total_pence: number;
  confirmed_provider_captured_total_pence: number;
  refunded_total_pence: number;
  provider_fee_total_pence: number;
  onecab_gross_commission_pence: number;
  onecab_net_commission_pence: number | null;
  driver_net_total_pence: number;
  wallet_credits_total_pence: number;
  payouts_completed_pence: number;
  capture_shortfall_pence: number;
  overcapture_pence: number;
  missing_wallet_credits_count: number;
  payout_mismatches_count: number;
  balanced_trips_count: number;
  unresolved_mismatches_count: number;
  trip_count: number;
};

/** Backend-only overview totals from canonical trip audit rows (no React sums). */
export function buildFrAuditOverviewKpis(
  rows: Array<{
    final_fare_pence?: number | null;
    final_customer_fare_pence?: number | null;
    settlement_total_pence?: number | null;
    captured_pence?: number | null;
    refunded_pence?: number | null;
    processing_fee_pence?: number | null;
    onecab_gross_commission_pence?: number | null;
    onecab_net_pence?: number | null;
    driver_net_pence?: number | null;
    wallet_credit_pence?: number | null;
    capture_variance_pence?: number | null;
    capture_reconciliation_status?: string | null;
    wallet_reconciliation_status?: string | null;
    payout_reconciliation_status?: string | null;
    fee_status?: string | null;
    payout_amount_pence?: number | null;
    reconciliation_status?: { label?: string | null; tone?: string | null } | null;
    capture_mismatch?: boolean | null;
  }>,
): FrAuditOverviewKpis {
  let fare = 0;
  let captured = 0;
  let refunded = 0;
  let fees = 0;
  let gross = 0;
  let netSum = 0;
  let netKnown = true;
  let driverNet = 0;
  let walletCredits = 0;
  let payoutsCompleted = 0;
  let shortfall = 0;
  let overcapture = 0;
  let missingWallet = 0;
  let payoutMismatch = 0;
  let balanced = 0;
  let unresolved = 0;

  for (const row of rows) {
    const farePence = row.final_customer_fare_pence ?? row.final_fare_pence ?? row.settlement_total_pence;
    if (farePence != null) fare += Math.max(0, farePence);
    if (row.captured_pence != null && row.captured_pence > 0) {
      captured += row.captured_pence;
    }
    if (row.refunded_pence != null) refunded += Math.max(0, row.refunded_pence);
    if (row.processing_fee_pence != null) fees += Math.max(0, row.processing_fee_pence);
    if (row.onecab_gross_commission_pence != null) {
      gross += Math.max(0, row.onecab_gross_commission_pence);
    }
    if (row.onecab_net_pence == null) netKnown = false;
    else netSum += Math.max(0, row.onecab_net_pence);
    if (row.driver_net_pence != null) driverNet += Math.max(0, row.driver_net_pence);
    if (row.wallet_credit_pence != null) walletCredits += Math.max(0, row.wallet_credit_pence);
    if (String(row.payout_reconciliation_status ?? "") === "PAYOUT_PAID") {
      payoutsCompleted += Math.max(0, Number(row.payout_amount_pence ?? 0));
    }
    const cv = row.capture_variance_pence;
    if (cv != null && cv < 0) shortfall += Math.abs(cv);
    if (cv != null && cv > 0) overcapture += cv;
    if (row.wallet_reconciliation_status === "WALLET_CREDIT_MISSING") missingWallet += 1;
    if (
      row.payout_reconciliation_status === "PAYOUT_MISMATCH"
      || row.payout_reconciliation_status === "PAYOUT_FAILED"
      || row.payout_reconciliation_status === "DUPLICATE_PAYOUT_RISK"
    ) {
      payoutMismatch += 1;
    }
    if (isTripAuditFullyBalanced(row)) {
      balanced += 1;
    } else if (
      row.capture_mismatch
      || row.capture_reconciliation_status === "CAPTURE_SHORTFALL"
      || row.capture_reconciliation_status === "OVERCAPTURE"
      || row.capture_reconciliation_status === "CAPTURE_MISSING"
      || row.capture_reconciliation_status === "PAYMENT_SESSION_CAPTURE_MISMATCH"
      || row.capture_reconciliation_status === "NO_PAYMENT_SESSION"
      || row.wallet_reconciliation_status === "WALLET_CREDIT_MISSING"
      || row.wallet_reconciliation_status === "WALLET_OVER_CREDIT"
      || row.wallet_reconciliation_status === "WALLET_UNDER_CREDIT"
      || row.wallet_reconciliation_status === "DUPLICATE_WALLET_CREDIT"
      || row.payout_reconciliation_status === "PAYOUT_MISMATCH"
      || row.payout_reconciliation_status === "PAYOUT_FAILED"
      || row.payout_reconciliation_status === "DUPLICATE_PAYOUT_RISK"
    ) {
      unresolved += 1;
    }
  }

  return {
    completed_trip_fare_total_pence: fare,
    confirmed_provider_captured_total_pence: captured,
    refunded_total_pence: refunded,
    provider_fee_total_pence: fees,
    onecab_gross_commission_pence: gross,
    onecab_net_commission_pence: netKnown ? netSum : null,
    driver_net_total_pence: driverNet,
    wallet_credits_total_pence: walletCredits,
    payouts_completed_pence: payoutsCompleted,
    capture_shortfall_pence: shortfall,
    overcapture_pence: overcapture,
    missing_wallet_credits_count: missingWallet,
    payout_mismatches_count: payoutMismatch,
    balanced_trips_count: balanced,
    unresolved_mismatches_count: unresolved,
    trip_count: rows.length,
  };
}
