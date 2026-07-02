/**
 * Driver Wallet / Payout / Reconciliation SSOT — pure calculations (no I/O).
 *
 * NON-NEGOTIABLE: wallet_balance_pence is ONECAB accounting liability only.
 * Never use it directly as scheduled payout, cash-out, or paid-out.
 */

export const PAYOUT_LIFECYCLE = [
  "CAPTURED_TRIP",
  "DRIVER_WALLET_LEDGER",
  "FINANCE_CLEARED",
  "INCLUDED_IN_PAYOUT_BATCH",
  "STRIPE_TRANSFER_CREATED",
  "STRIPE_PAYOUT_CREATED",
  "PAID",
] as const;

export type PayoutLifecycleStage = (typeof PAYOUT_LIFECYCLE)[number];

export type DriverWalletPayoutSnapshotInput = {
  /** Σ driver_wallet_ledger (excl. reporting-only types). Signed. */
  wallet_balance_pence: number;
  /** Sum of finance-cleared settlement rows still payable. */
  finance_cleared_pence: number;
  /** Sum of net on payout_items in active batch (pending/processing). */
  included_in_payout_batch_pence: number;
  /** Stripe Connect standard available — physical cash only. */
  stripe_connect_available_pence: number | null;
  stripe_connect_pending_pence: number | null;
  stripe_in_transit_pence?: number | null;
  stripe_connect_instant_available_pence?: number | null;
  /** Sum of paid stripe_connect_payouts or ledger rows with stripe_payout_id. */
  stripe_paid_out_total_pence: number;
  recovery_debt_pence: number;
  in_flight_cashout_pence?: number;
  payout_blocked?: boolean;
  instant_payout_enabled_by_stripe?: boolean;
  early_cashout_enabled_by_service_area?: boolean;
  min_cashout_pence?: number;
  /** Evidence flags for reconciliation */
  stripe_payout_without_ledger_debit_pence?: number;
  ledger_debit_without_stripe_payout_pence?: number;
  local_only_failed_payout_pence?: number;
  failed_payout_stuck_processing_pence?: number;
  provider_platform_available_pence?: number | null;
};

export type DriverWalletPayoutSnapshot = {
  current_onecab_wallet_owed_pence: number;
  finance_cleared_amount_pence: number;
  included_in_payout_batch_amount_pence: number;
  stripe_connect_available_pence: number | null;
  stripe_connect_pending_pence: number | null;
  stripe_in_transit_pence: number | null;
  stripe_paid_out_total_pence: number;
  cashout_limit_pence: number;
  scheduled_payout_display_pence: number | null;
  reconciliation_status: ReconciliationStatus;
  reconciliation_reasons: string[];
  wallet_balance_pence: number;
  recovery_debt_pence: number;
};

export type ReconciliationStatus =
  | "BALANCED"
  | "MISMATCH"
  | "LOCAL_ONLY"
  | "STRIPE_ONLY"
  | "PROVIDER_NEGATIVE";

const ACTIVE_BATCH_STATUSES = new Set(["pending", "processing"]);

export function sumIncludedInPayoutBatchPence(
  items: Array<{ status: string; net_driver_payout_pence?: number | null; amount_pence?: number | null }>,
): number {
  return items.reduce((sum, row) => {
    if (!ACTIVE_BATCH_STATUSES.has(String(row.status ?? "").toLowerCase())) return sum;
    const net = Number(row.net_driver_payout_pence ?? row.amount_pence ?? 0);
    return sum + Math.max(0, net);
  }, 0);
}

export function sumStripePaidOutFromConnectPayouts(
  rows: Array<{ amount_pence?: number | null; status?: string | null }>,
): number {
  return rows.reduce((sum, row) => {
    const st = String(row.status ?? "").toLowerCase();
    if (st !== "paid" && st !== "in_transit" && st !== "pending") return sum;
    return sum + Math.max(0, Number(row.amount_pence ?? 0));
  }, 0);
}

/**
 * Cash-out limit = min(wallet owed, finance cleared, Stripe instant available)
 * minus recovery debt and in-flight holds.
 */
export function computeCashoutLimitPence(input: {
  wallet_owed_pence: number;
  finance_cleared_pence: number;
  stripe_instant_available_pence: number | null | undefined;
  recovery_debt_pence: number;
  in_flight_cashout_pence?: number;
  payout_blocked?: boolean;
  instant_enabled?: boolean;
}): number {
  if (input.payout_blocked || input.instant_enabled === false) return 0;
  const walletOwed = Math.max(0, input.wallet_owed_pence);
  const financeCleared = Math.max(0, input.finance_cleared_pence);
  const instant = typeof input.stripe_instant_available_pence === "number"
    ? Math.max(0, input.stripe_instant_available_pence)
    : 0;
  const recovery = Math.max(0, input.recovery_debt_pence);
  const inFlight = Math.max(0, input.in_flight_cashout_pence ?? 0);
  const raw = Math.min(walletOwed, financeCleared, instant);
  return Math.max(0, raw - recovery - inFlight);
}

export function computeDriverWalletPayoutSnapshot(
  input: DriverWalletPayoutSnapshotInput,
): DriverWalletPayoutSnapshot {
  const walletSigned = Math.round(input.wallet_balance_pence);
  const walletOwed = Math.max(0, walletSigned);
  const financeCleared = Math.max(0, Math.round(input.finance_cleared_pence));
  const includedBatch = Math.max(0, Math.round(input.included_in_payout_batch_pence));
  const recoveryDebt = Math.max(0, Math.round(input.recovery_debt_pence));
  const inFlight = Math.max(0, Math.round(input.in_flight_cashout_pence ?? 0));

  const stripeAvailable = typeof input.stripe_connect_available_pence === "number"
    ? Math.max(0, Math.round(input.stripe_connect_available_pence))
    : null;
  const stripePending = typeof input.stripe_connect_pending_pence === "number"
    ? Math.max(0, Math.round(input.stripe_connect_pending_pence))
    : null;
  const stripeInTransit = typeof input.stripe_in_transit_pence === "number"
    ? Math.max(0, Math.round(input.stripe_in_transit_pence))
    : null;

  const instantEnabled = input.instant_payout_enabled_by_stripe !== false
    && input.early_cashout_enabled_by_service_area !== false;

  const cashoutLimit = computeCashoutLimitPence({
    wallet_owed_pence: walletOwed,
    finance_cleared_pence: financeCleared,
    stripe_instant_available_pence: input.stripe_connect_instant_available_pence,
    recovery_debt_pence: recoveryDebt,
    in_flight_cashout_pence: inFlight,
    payout_blocked: input.payout_blocked,
    instant_enabled: instantEnabled,
  });

  // Scheduled display: only when valid batch evidence exists — NOT wallet_balance.
  const scheduledDisplay = includedBatch > 0 ? includedBatch : null;

  const reasons: string[] = [];
  let status: ReconciliationStatus = "BALANCED";

  const providerAvail = input.provider_platform_available_pence;
  if (typeof providerAvail === "number" && providerAvail < 0) {
    status = "PROVIDER_NEGATIVE";
    reasons.push("Stripe platform available balance is negative");
  }

  const stripeWithoutLedger = Math.max(0, input.stripe_payout_without_ledger_debit_pence ?? 0);
  const ledgerWithoutStripe = Math.max(0, input.ledger_debit_without_stripe_payout_pence ?? 0);
  const localFailed = Math.max(0, input.local_only_failed_payout_pence ?? 0);
  const stuckProcessing = Math.max(0, input.failed_payout_stuck_processing_pence ?? 0);

  if (stripeWithoutLedger > 0) {
    status = status === "BALANCED" ? "STRIPE_ONLY" : "MISMATCH";
    reasons.push(`Stripe payout £${(stripeWithoutLedger / 100).toFixed(2)} missing ledger debit`);
  }
  if (ledgerWithoutStripe > 0) {
    status = "MISMATCH";
    reasons.push(`Ledger debit £${(ledgerWithoutStripe / 100).toFixed(2)} missing Stripe payout`);
  }
  if (localFailed > 0) {
    status = status === "BALANCED" ? "LOCAL_ONLY" : "MISMATCH";
    reasons.push(`Local failed payout £${(localFailed / 100).toFixed(2)} without Stripe evidence`);
  }
  if (stuckProcessing > 0) {
    status = "MISMATCH";
    reasons.push(`Failed payout £${(stuckProcessing / 100).toFixed(2)} stuck in processing/ready`);
  }
  if (stripeAvailable != null && walletOwed > stripeAvailable + 50 && includedBatch === 0) {
    reasons.push(
      `ONECAB owes £${(walletOwed / 100).toFixed(2)} but Connect available is £${(stripeAvailable / 100).toFixed(2)}`,
    );
    if (status === "BALANCED") status = "MISMATCH";
  }

  return {
    current_onecab_wallet_owed_pence: walletOwed,
    finance_cleared_amount_pence: financeCleared,
    included_in_payout_batch_amount_pence: includedBatch,
    stripe_connect_available_pence: stripeAvailable,
    stripe_connect_pending_pence: stripePending,
    stripe_in_transit_pence: stripeInTransit,
    stripe_paid_out_total_pence: Math.max(0, Math.round(input.stripe_paid_out_total_pence)),
    cashout_limit_pence: cashoutLimit,
    scheduled_payout_display_pence: scheduledDisplay,
    reconciliation_status: status,
    reconciliation_reasons: reasons,
    wallet_balance_pence: walletSigned,
    recovery_debt_pence: recoveryDebt,
  };
}
