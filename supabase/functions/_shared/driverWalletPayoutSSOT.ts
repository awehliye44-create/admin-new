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
  "PROVIDER_TRANSFER_CREATED",
  "PROVIDER_PAYOUT_CREATED",
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
  /** provider Connect standard available — physical cash only. */
  provider_available_pence: number | null;
  provider_pending_pence: number | null;
  provider_in_transit_pence?: number | null;
  provider_instant_available_pence?: number | null;
  /** Sum of paid provider_connect_payouts or ledger rows with provider_payout_id. */
  provider_paid_out_total_pence: number;
  recovery_debt_pence: number;
  in_flight_cashout_pence?: number;
  /** ACTIVE driver_payout_reservations — cannot be cash-out or re-batch reserved. */
  reserved_payout_pence?: number;
  payout_blocked?: boolean;
  instant_payout_enabled_by_provider?: boolean;
  early_cashout_enabled_by_service_area?: boolean;
  min_cashout_pence?: number;
  /** Evidence flags for reconciliation */
  provider_payout_without_ledger_debit_pence?: number;
  ledger_debit_without_provider_payout_pence?: number;
  local_only_failed_payout_pence?: number;
  failed_payout_stuck_processing_pence?: number;
  provider_platform_available_pence?: number | null;
  /**
   * Driver payout provider for this service area.
   * Revolut / manual bank: available = finance-cleared wallet unpaid (no Connect cap).
   */
  payout_provider?: string | null;
};

export type DriverWalletPayoutSnapshot = {
  current_onecab_wallet_owed_pence: number;
  finance_cleared_amount_pence: number;
  included_in_payout_batch_amount_pence: number;
  provider_available_pence: number | null;
  provider_pending_pence: number | null;
  provider_in_transit_pence: number | null;
  provider_paid_out_total_pence: number;
  cashout_limit_pence: number;
  scheduled_payout_display_pence: number | null;
  local_only_failed_payout_pence: number;
  failed_payout_stuck_processing_pence: number;
  reconciliation_status: ReconciliationStatus;
  reconciliation_reasons: string[];
  wallet_balance_pence: number;
  recovery_debt_pence: number;
  /** True when automatic payouts / cash-outs must freeze (mismatch, negative, or explicit block). */
  payout_blocked: boolean;
};

export type ReconciliationStatus =
  | "BALANCED"
  | "MISMATCH"
  | "LOCAL_ONLY"
  | "PROVIDER_ONLY"
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

export function sumProviderPaidOutFromConnectPayouts(
  rows: Array<{ amount_pence?: number | null; status?: string | null }>,
): number {
  return rows.reduce((sum, row) => {
    const st = String(row.status ?? "").toLowerCase();
    if (st !== "paid" && st !== "in_transit" && st !== "pending") return sum;
    return sum + Math.max(0, Number(row.amount_pence ?? 0));
  }, 0);
}

/**
 * Available Cash Out — provider Connect after settlement rules.
 * Never uses wallet_balance as provider physical cash (hard SSOT rule).
 */
export function computeAvailableCashOutPence(input: {
  provider_available_pence: number | null | undefined;
  provider_instant_available_pence?: number | null | undefined;
  finance_cleared_pence: number;
  recovery_debt_pence: number;
  in_flight_cashout_pence?: number;
  reserved_payout_pence?: number;
  payout_blocked?: boolean;
  instant_enabled?: boolean;
}): number {
  if (input.payout_blocked || input.instant_enabled === false) return 0;
  const financeCleared = Math.max(0, input.finance_cleared_pence);
  const providerBase = typeof input.provider_instant_available_pence === "number"
    ? Math.max(0, input.provider_instant_available_pence)
    : typeof input.provider_available_pence === "number"
    ? Math.max(0, input.provider_available_pence)
    : 0;
  const recovery = Math.max(0, input.recovery_debt_pence);
  const inFlight = Math.max(0, input.in_flight_cashout_pence ?? 0);
  const reserved = Math.max(0, input.reserved_payout_pence ?? 0);
  const raw = Math.min(providerBase, financeCleared);
  return Math.max(0, raw - recovery - inFlight - reserved);
}

/**
 * Available for manual bank / Revolut driver payouts.
 * Consumes finance-cleared DWL liability — never provider Connect balance.
 */
export function computeManualBankAvailablePence(input: {
  wallet_owed_pence: number;
  finance_cleared_pence: number;
  recovery_debt_pence: number;
  in_flight_cashout_pence?: number;
  reserved_payout_pence?: number;
  payout_blocked?: boolean;
}): number {
  if (input.payout_blocked) return 0;
  const wallet = Math.max(0, input.wallet_owed_pence);
  const cleared = Math.max(0, input.finance_cleared_pence);
  const recovery = Math.max(0, input.recovery_debt_pence);
  const inFlight = Math.max(0, input.in_flight_cashout_pence ?? 0);
  const reserved = Math.max(0, input.reserved_payout_pence ?? 0);
  const unpaid = Math.min(wallet, cleared);
  return Math.max(0, unpaid - recovery - inFlight - reserved);
}

export function isManualBankPayoutProviderName(provider: string | null | undefined): boolean {
  return String(provider ?? "").trim().toLowerCase() === "revolut";
}

/** @deprecated Use computeAvailableCashOutPence — wallet must not cap cash-out. */
export function computeCashoutLimitPence(input: {
  wallet_owed_pence: number;
  finance_cleared_pence: number;
  provider_instant_available_pence: number | null | undefined;
  recovery_debt_pence: number;
  in_flight_cashout_pence?: number;
  payout_blocked?: boolean;
  instant_enabled?: boolean;
  provider_available_pence?: number | null;
}): number {
  return computeAvailableCashOutPence({
    provider_available_pence: input.provider_available_pence ?? null,
    provider_instant_available_pence: input.provider_instant_available_pence,
    finance_cleared_pence: input.finance_cleared_pence,
    recovery_debt_pence: input.recovery_debt_pence,
    in_flight_cashout_pence: input.in_flight_cashout_pence,
    payout_blocked: input.payout_blocked,
    instant_enabled: input.instant_enabled,
  });
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
  const reservedPayout = Math.max(0, Math.round(input.reserved_payout_pence ?? 0));

  const providerAvailable = typeof input.provider_available_pence === "number"
    ? Math.max(0, Math.round(input.provider_available_pence))
    : null;
  const providerPending = typeof input.provider_pending_pence === "number"
    ? Math.max(0, Math.round(input.provider_pending_pence))
    : null;
  const providerInTransit = typeof input.provider_in_transit_pence === "number"
    ? Math.max(0, Math.round(input.provider_in_transit_pence))
    : null;

  const instantEnabled = input.instant_payout_enabled_by_provider !== false
    && input.early_cashout_enabled_by_service_area !== false;

  const manualBank = isManualBankPayoutProviderName(input.payout_provider);

  const cashoutLimitRaw = manualBank
    ? computeManualBankAvailablePence({
      wallet_owed_pence: walletOwed,
      finance_cleared_pence: financeCleared,
      recovery_debt_pence: recoveryDebt,
      in_flight_cashout_pence: inFlight,
      reserved_payout_pence: reservedPayout,
      payout_blocked: input.payout_blocked,
    })
    : computeAvailableCashOutPence({
      provider_available_pence: providerAvailable,
      provider_instant_available_pence: input.provider_instant_available_pence,
      finance_cleared_pence: financeCleared,
      recovery_debt_pence: recoveryDebt,
      in_flight_cashout_pence: inFlight,
      reserved_payout_pence: reservedPayout,
      payout_blocked: input.payout_blocked,
      instant_enabled: instantEnabled,
    });

  // Scheduled display: only when valid batch evidence exists — NOT wallet_balance.
  const scheduledDisplay = includedBatch > 0 ? includedBatch : null;

  const reasons: string[] = [];
  let status: ReconciliationStatus = "BALANCED";

  const providerAvail = input.provider_platform_available_pence;
  if (!manualBank && typeof providerAvail === "number" && providerAvail < 0) {
    status = "PROVIDER_NEGATIVE";
    reasons.push("provider platform available balance is negative");
  }

  const providerWithoutLedger = Math.max(0, input.provider_payout_without_ledger_debit_pence ?? 0);
  const ledgerWithoutProvider = Math.max(0, input.ledger_debit_without_provider_payout_pence ?? 0);
  const localFailed = Math.max(0, input.local_only_failed_payout_pence ?? 0);
  const stuckProcessing = Math.max(0, input.failed_payout_stuck_processing_pence ?? 0);

  // provider Connect reconciliation evidence — never freezes Revolut/manual bank available.
  if (!manualBank) {
    if (providerWithoutLedger > 0) {
      status = status === "BALANCED" ? "PROVIDER_ONLY" : "MISMATCH";
      reasons.push(`provider payout £${(providerWithoutLedger / 100).toFixed(2)} missing ledger debit`);
    }
    if (ledgerWithoutProvider > 0) {
      status = "MISMATCH";
      reasons.push(`Ledger debit £${(ledgerWithoutProvider / 100).toFixed(2)} missing provider payout`);
    }
    if (localFailed > 0) {
      status = status === "BALANCED" ? "LOCAL_ONLY" : "MISMATCH";
      reasons.push(`Local failed payout £${(localFailed / 100).toFixed(2)} without provider evidence`);
    }
    if (stuckProcessing > 0) {
      status = "MISMATCH";
      reasons.push(`Failed payout £${(stuckProcessing / 100).toFixed(2)} stuck in processing/ready`);
    }
  }
  if (walletSigned < 0) {
    reasons.push("Wallet balance negative — automatic payouts frozen until debt cleared");
  }

  // Hard rule: mismatch / negative wallet freezes automatic payout + cash-out.
  // Manual bank: only explicit block or negative wallet (never provider Connect mismatch).
  const freezeAutomaticPayout = input.payout_blocked === true
    || walletSigned < 0
    || (!manualBank && status !== "BALANCED");
  const cashoutLimit = freezeAutomaticPayout ? 0 : cashoutLimitRaw;

  return {
    current_onecab_wallet_owed_pence: walletOwed,
    finance_cleared_amount_pence: financeCleared,
    included_in_payout_batch_amount_pence: includedBatch,
    provider_available_pence: providerAvailable,
    provider_pending_pence: providerPending,
    provider_in_transit_pence: providerInTransit,
    provider_paid_out_total_pence: Math.max(0, Math.round(input.provider_paid_out_total_pence)),
    cashout_limit_pence: cashoutLimit,
    scheduled_payout_display_pence: scheduledDisplay,
    local_only_failed_payout_pence: localFailed,
    failed_payout_stuck_processing_pence: stuckProcessing,
    reconciliation_status: status,
    reconciliation_reasons: reasons,
    wallet_balance_pence: walletSigned,
    recovery_debt_pence: recoveryDebt,
    payout_blocked: freezeAutomaticPayout,
  };
}
