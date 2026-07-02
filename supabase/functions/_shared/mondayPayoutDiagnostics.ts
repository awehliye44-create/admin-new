/**
 * Monday payout settlement diagnostics — Financial Reconciliation SSOT.
 */

export const PARTIAL_SETTLEMENT_MESSAGE =
  "ONECAB commission was recovered, but driver payout did not complete.";

export const PROVIDER_FAILURE_REASON_FALLBACK =
  "Provider did not return a failure reason. Check payout provider logs.";

export type MondayPayoutSettlementStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETE"
  | "FAILED"
  | "PARTIAL_SETTLEMENT";

export type PayoutEvidenceType =
  | "local_only"
  | "stripe_transfer"
  | "stripe_payout";

export type MondayPayoutDiagnosticsRow = {
  payout_item_id: string;
  batch_id: string | null;
  batch_kind: string;
  driver_id: string;
  driver_name: string | null;
  /** Current signed wallet balance — negative means driver owes ONECAB. */
  driver_wallet_balance_pence: number | null;
  /** abs(min(wallet, 0)) */
  driver_debt_pence: number | null;
  gross_payable_pence: number;
  cash_commission_recovered_pence: number;
  net_driver_payout_pence: number;
  payout_status: string;
  settlement_status: MondayPayoutSettlementStatus | null;
  payout_evidence_type: PayoutEvidenceType;
  payout_evidence_label: string;
  stripe_transfer_id: string | null;
  stripe_payout_id: string | null;
  retry_blocked_reason: string | null;
  driver_paid_out_pence: number;
  failed_payout_amount_pence: number;
  driver_pending_pence: number;
  returned_to_wallet_pence: number;
  provider_status: string | null;
  provider_reference: string | null;
  failure_reason: string | null;
  failure_code?: string | null;
  failed_at: string | null;
  reconciliation_status: "BALANCED" | "RECONCILIATION_MISMATCH";
  reconciliation_detail: string | null;
  /** Completed payout while driver currently owes ONECAB — should not have been paid. */
  payout_policy_violation: boolean;
  payout_policy_violation_detail: string | null;
  created_at: string;
  completed_at: string | null;
};

export type MondayPayoutTodayCards = {
  onecab_commission_recovered_pence: number;
  driver_payout_sent_pence: number;
  driver_payout_failed_pence: number;
  driver_payout_pending_pence: number;
  returned_to_wallet_pence: number;
};

export function formatProviderFailureReason(
  raw: string | null | undefined,
): string {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : PROVIDER_FAILURE_REASON_FALLBACK;
}

const TERMINAL_FAILED_PAYOUT_STATUSES = new Set([
  "failed",
  "ledger_sync_failed",
  "FAILED_DUPLICATE",
]);

export function deriveSettlementStatus(args: {
  payoutStatus: string;
  cashCommissionRecoveredPence: number;
  driverPaidOutPence: number;
  failedPayoutAmountPence: number;
  returnedToWalletPence: number;
  stripeTransferId?: string | null;
  stripePayoutId?: string | null;
}): MondayPayoutSettlementStatus {
  const { payoutStatus, cashCommissionRecoveredPence } = args;
  if (payoutStatus === "completed") return "COMPLETE";
  if (payoutStatus === "FAILED_DUPLICATE") return "FAILED";
  if (TERMINAL_FAILED_PAYOUT_STATUSES.has(payoutStatus)) {
    if (
      cashCommissionRecoveredPence > 0 &&
      !args.stripeTransferId &&
      !args.stripePayoutId
    ) {
      return "PARTIAL_SETTLEMENT";
    }
    return "FAILED";
  }
  if (payoutStatus === "pending" || payoutStatus === "processing") return "PROCESSING";
  if (
    cashCommissionRecoveredPence > 0 &&
    (args.failedPayoutAmountPence > 0 || args.returnedToWalletPence > 0)
  ) {
    return "PARTIAL_SETTLEMENT";
  }
  return "PENDING";
}

export function classifyPayoutEvidence(args: {
  stripeTransferId?: string | null;
  stripePayoutId?: string | null;
  payoutStatus: string;
}): { type: PayoutEvidenceType; label: string } {
  if (args.stripePayoutId) {
    return {
      type: "stripe_payout",
      label: "Stripe payout paid to bank",
    };
  }
  if (args.stripeTransferId) {
    return {
      type: "stripe_transfer",
      label: "Stripe transfer succeeded",
    };
  }
  if (TERMINAL_FAILED_PAYOUT_STATUSES.has(args.payoutStatus)) {
    return {
      type: "local_only",
      label: "Local failed payout item — not Stripe paid",
    };
  }
  return {
    type: "local_only",
    label: "Local pending payout item — not Stripe paid",
  };
}

/** gross - cash_commission = net */
export function grossMinusCommissionBalanced(
  grossPayablePence: number,
  cashCommissionRecoveredPence: number,
  netDriverPayoutPence: number,
  tolerancePence = 1,
): boolean {
  return Math.abs(
    grossPayablePence - cashCommissionRecoveredPence - netDriverPayoutPence,
  ) <= tolerancePence;
}

/** net = paid_out + pending + failed (outstanding) + returned */
export function netPayoutAllocationBalanced(
  netDriverPayoutPence: number,
  driverPaidOutPence: number,
  failedPayoutAmountPence: number,
  driverPendingPence: number,
  returnedToWalletPence: number,
  tolerancePence = 1,
): boolean {
  const outstandingFailed = Math.max(
    0,
    failedPayoutAmountPence - returnedToWalletPence,
  );
  const allocated =
    driverPaidOutPence +
    driverPendingPence +
    outstandingFailed +
    returnedToWalletPence;
  return Math.abs(netDriverPayoutPence - allocated) <= tolerancePence;
}

export function reconcileMondayPayoutRow(row: {
  gross_payable_pence: number;
  cash_commission_recovered_pence: number;
  net_driver_payout_pence: number;
  driver_paid_out_pence: number;
  failed_payout_amount_pence: number;
  driver_pending_pence: number;
  returned_to_wallet_pence: number;
  payout_status: string;
  payout_evidence_type?: PayoutEvidenceType;
  stripe_transfer_id?: string | null;
  stripe_payout_id?: string | null;
}): { status: "BALANCED" | "RECONCILIATION_MISMATCH"; detail: string | null } {
  const localOnlyFailed = row.payout_evidence_type === "local_only" &&
    TERMINAL_FAILED_PAYOUT_STATUSES.has(row.payout_status);

  if (localOnlyFailed) {
    const failedOk = row.failed_payout_amount_pence >= row.net_driver_payout_pence - 1;
    const paidOk = row.driver_paid_out_pence === 0;
    if (failedOk && paidOk) {
      return { status: "BALANCED", detail: null };
    }
    return {
      status: "RECONCILIATION_MISMATCH",
      detail: `local failed item: net(${row.net_driver_payout_pence}) failed(${row.failed_payout_amount_pence}) paid(${row.driver_paid_out_pence})`,
    };
  }

  const grossOk = grossMinusCommissionBalanced(
    row.gross_payable_pence,
    row.cash_commission_recovered_pence,
    row.net_driver_payout_pence,
  );
  const netOk = netPayoutAllocationBalanced(
    row.net_driver_payout_pence,
    row.driver_paid_out_pence,
    row.failed_payout_amount_pence,
    row.driver_pending_pence,
    row.returned_to_wallet_pence,
  );

  if (grossOk && netOk) {
    return { status: "BALANCED", detail: null };
  }

  const parts: string[] = [];
  if (!grossOk) {
    parts.push(
      `gross(${row.gross_payable_pence}) - commission(${row.cash_commission_recovered_pence}) ≠ net(${row.net_driver_payout_pence})`,
    );
  }
  if (!netOk) {
    parts.push(
      `net(${row.net_driver_payout_pence}) ≠ paid(${row.driver_paid_out_pence}) + failed(${row.failed_payout_amount_pence}) + pending(${row.driver_pending_pence}) + returned(${row.returned_to_wallet_pence})`,
    );
  }
  return { status: "RECONCILIATION_MISMATCH", detail: parts.join("; ") };
}

export function buildMondayPayoutDiagnosticsRow(args: {
  item: Record<string, unknown>;
  batchKind: string;
  driverName: string | null;
  driverWalletBalancePence?: number | null;
  platformAvailablePence?: number | null;
}): MondayPayoutDiagnosticsRow {
  const item = args.item;
  const payoutStatus = String(item.status ?? "pending");
  const stripeTransferId = (item.stripe_transfer_id as string | null) ?? null;
  const stripePayoutId = (item.stripe_payout_id as string | null) ?? null;
  const cashCommission = Number(item.cash_commission_recovered_pence ?? 0);
  const netPayout = Number(
    item.net_driver_payout_pence ?? item.amount_pence ?? 0,
  );
  const grossPayable = Number(item.gross_payable_pence ?? 0) ||
    (netPayout + cashCommission) ||
    netPayout;
  const driverPaidOut = payoutStatus === "completed"
    ? Number(item.driver_paid_out_pence ?? netPayout)
    : Number(item.driver_paid_out_pence ?? 0);
  const failedAmountRaw = Number(item.failed_payout_amount_pence ?? 0);
  const failedAmount = TERMINAL_FAILED_PAYOUT_STATUSES.has(payoutStatus)
    ? (failedAmountRaw > 0 ? failedAmountRaw : netPayout)
    : failedAmountRaw;
  const returned = Number(item.returned_to_wallet_pence ?? 0);
  const driverPending =
    payoutStatus === "pending" || payoutStatus === "processing" ? netPayout : 0;

  const evidence = classifyPayoutEvidence({
    stripeTransferId,
    stripePayoutId,
    payoutStatus,
  });

  const settlementStatus = deriveSettlementStatus({
    payoutStatus,
    cashCommissionRecoveredPence: cashCommission,
    driverPaidOutPence: driverPaidOut,
    failedPayoutAmountPence: failedAmount,
    returnedToWalletPence: returned,
    stripeTransferId,
    stripePayoutId,
  });

  const recon = reconcileMondayPayoutRow({
    gross_payable_pence: grossPayable,
    cash_commission_recovered_pence: cashCommission,
    net_driver_payout_pence: netPayout,
    driver_paid_out_pence: driverPaidOut,
    failed_payout_amount_pence: failedAmount,
    driver_pending_pence: driverPending,
    returned_to_wallet_pence: returned,
    payout_status: payoutStatus,
    payout_evidence_type: evidence.type,
    stripe_transfer_id: stripeTransferId,
    stripe_payout_id: stripePayoutId,
  });

  const providerRef =
    (item.provider_reference as string | null) ??
    stripeTransferId ??
    stripePayoutId;

  const walletBalance =
    typeof args.driverWalletBalancePence === "number"
      ? args.driverWalletBalancePence
      : null;
  const driverDebt =
    walletBalance != null ? Math.max(0, -walletBalance) : null;
  const payoutPolicyViolation =
    payoutStatus === "completed" &&
    driverPaidOut > 0 &&
    walletBalance != null &&
    walletBalance < 0;
  const payoutPolicyViolationDetail = payoutPolicyViolation
    ? `Driver wallet is ${walletBalance}p (debt ${driverDebt}p) — payout should have been blocked.`
    : null;

  let retryBlockedReason: string | null = null;
  if (
    TERMINAL_FAILED_PAYOUT_STATUSES.has(payoutStatus) &&
    !providerRef &&
    typeof args.platformAvailablePence === "number" &&
    args.platformAvailablePence < netPayout
  ) {
    retryBlockedReason =
      "Cannot retry: Stripe provider balance is negative / insufficient funds.";
  }

  return {
    payout_item_id: String(item.id),
    batch_id: (item.batch_id as string | null) ?? null,
    batch_kind: args.batchKind,
    driver_id: String(item.driver_id),
    driver_name: args.driverName,
    driver_wallet_balance_pence: walletBalance,
    driver_debt_pence: driverDebt,
    gross_payable_pence: grossPayable,
    cash_commission_recovered_pence: cashCommission,
    net_driver_payout_pence: netPayout,
    payout_status: payoutStatus,
    settlement_status: settlementStatus,
    payout_evidence_type: evidence.type,
    payout_evidence_label: evidence.label,
    stripe_transfer_id: stripeTransferId,
    stripe_payout_id: stripePayoutId,
    retry_blocked_reason: retryBlockedReason,
    driver_paid_out_pence: driverPaidOut,
    failed_payout_amount_pence: failedAmount,
    driver_pending_pence: driverPending,
    returned_to_wallet_pence: returned,
    provider_status: (item.provider_status as string | null) ?? null,
    provider_reference: providerRef,
    failure_reason: formatProviderFailureReason(
      (item.failure_reason as string | null) ??
        (item.error_message as string | null) ??
        (item.ledger_sync_error as string | null),
    ),
    failure_code: (item.failure_code as string | null) ?? null,
    failed_at: (item.failed_at as string | null) ??
      (payoutStatus === "failed" ? (item.updated_at as string | null) : null),
    reconciliation_status: recon.status,
    reconciliation_detail: recon.detail,
    payout_policy_violation: payoutPolicyViolation,
    payout_policy_violation_detail: payoutPolicyViolationDetail,
    created_at: String(item.created_at ?? ""),
    completed_at: (item.completed_at as string | null) ?? null,
  };
}

export function aggregateMondayPayoutTodayCards(
  rows: MondayPayoutDiagnosticsRow[],
): MondayPayoutTodayCards {
  return rows.reduce(
    (acc, row) => {
      acc.onecab_commission_recovered_pence += row.cash_commission_recovered_pence;
      acc.driver_payout_sent_pence += row.driver_paid_out_pence;
      acc.driver_payout_failed_pence += row.failed_payout_amount_pence;
      acc.driver_payout_pending_pence += row.driver_pending_pence;
      acc.returned_to_wallet_pence += row.returned_to_wallet_pence;
      return acc;
    },
    {
      onecab_commission_recovered_pence: 0,
      driver_payout_sent_pence: 0,
      driver_payout_failed_pence: 0,
      driver_payout_pending_pence: 0,
      returned_to_wallet_pence: 0,
    },
  );
}

/** Start of current calendar day in Europe/London as ISO string. */
export function londonTodayStartIso(): string {
  const now = new Date();
  const london = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/London" }),
  );
  london.setHours(0, 0, 0, 0);
  return london.toISOString();
}

/** True when a payout row's activity falls on the current London calendar day. */
export function isMondayPayoutRowActivityToday(
  row: Pick<
    MondayPayoutDiagnosticsRow,
    "completed_at" | "created_at" | "failed_at" | "payout_status"
  >,
  todayStartIso: string,
): boolean {
  const todayStart = new Date(todayStartIso).getTime();
  const activityAt =
    row.completed_at ??
    row.failed_at ??
    (row.payout_status === "pending" || row.payout_status === "processing"
      ? row.created_at
      : null);
  if (!activityAt) return false;
  return new Date(activityAt).getTime() >= todayStart;
}

export function filterMondayPayoutRowsForLondonToday(
  rows: MondayPayoutDiagnosticsRow[],
  todayStartIso = londonTodayStartIso(),
): MondayPayoutDiagnosticsRow[] {
  return rows.filter((row) => isMondayPayoutRowActivityToday(row, todayStartIso));
}

function payoutRowActivityAt(
  row: Pick<
    MondayPayoutDiagnosticsRow,
    "completed_at" | "created_at" | "failed_at" | "payout_status"
  >,
): string | null {
  return row.completed_at ??
    row.failed_at ??
    (row.payout_status === "pending" || row.payout_status === "processing"
      ? row.created_at
      : null) ??
    row.created_at ??
    null;
}

/** Payout rows with activity within [periodFrom, periodTo] (inclusive ISO). */
export function filterMondayPayoutRowsForPeriod(
  rows: MondayPayoutDiagnosticsRow[],
  periodFrom: string,
  periodTo: string,
): MondayPayoutDiagnosticsRow[] {
  const fromMs = new Date(periodFrom).getTime();
  const toMs = new Date(periodTo).getTime();
  return rows.filter((row) => {
    const activityAt = payoutRowActivityAt(row);
    if (!activityAt) return false;
    const t = new Date(activityAt).getTime();
    return t >= fromMs && t <= toMs;
  });
}
