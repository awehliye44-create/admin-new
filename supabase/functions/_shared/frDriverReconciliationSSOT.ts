/**
 * Financial Reconciliation — per-driver wallet vs payable invariants (audit only).
 *
 * Hard rules:
 * - Driver Wallet Ledger owns wallet balance.
 * - Provider Account Balance is reference-only (never reconciliation truth).
 * - No cross-driver netting.
 * - Unknown is never zero for classification / display of provider balance.
 */

import {
  BALANCE_EXCLUDED_LEDGER_TYPES,
  computeLedgerWalletBalancePence,
} from "./onecabFinanceLedger.ts";
import {
  computeAvailableCashOutPence,
  computeManualBankAvailablePence,
  isManualBankPayoutProviderName,
} from "./driverWalletPayoutSSOT.ts";

export const FR_DRIVER_RECONCILIATION_STATUSES = [
  "BALANCED",
  "DRIVER_WALLET_MISMATCH",
  "PAYOUT_MISMATCH",
  "DRIVER_AND_PAYOUT_MISMATCH",
  "PROVIDER_BALANCE_UNAVAILABLE",
  "PENDING_SYNC",
  "ACCOUNT_UNVERIFIED",
  "MISSING_WALLET_EVIDENCE",
  "MISSING_SETTLEMENT_EVIDENCE",
] as const;

export type FrDriverReconciliationStatus = (typeof FR_DRIVER_RECONCILIATION_STATUSES)[number];

export type ProviderAccountBalanceStatus = "AVAILABLE" | "UNAVAILABLE" | "NOT_APPLICABLE";

const TRIP_CREDIT_TYPES = new Set([
  "TRIP_EARNING_NET",
  "TRIP_SETTLEMENT_CORRECTION",
  "SETTLEMENT_CORRECTION",
]);

const ADJUSTMENT_TYPES = new Set([
  "ADJUSTMENT",
  "MANUAL_CREDIT",
  "MANUAL_DEBIT",
  "CORRECTION",
  "ADMIN_CORRECTION",
  "LEDGER_REVERSAL",
]);

const BONUS_TYPES = new Set(["BONUS", "INCENTIVE", "PROMOTION", "DRIVER_TIP_CREDIT"]);

const DEBT_RECOVERY_TYPES = new Set(["DEBT_RECOVERY"]);

const PAYOUT_DEBIT_TYPES = new Set([
  "PAYOUT",
  "WEEKLY_PAYOUT",
  "EARLY_CASHOUT",
  "MANUAL_PAYOUT",
  "CASHOUT_FEE",
]);

const PAYOUT_REVERSAL_TYPES = new Set(["PAYOUT_REVERSAL"]);

const REFUND_DEBIT_TYPES = new Set(["REFUND_DEBIT", "CHARGEBACK", "CUSTOMER_REFUND_DEBIT"]);

export type FrDriverLedgerRow = {
  type: string;
  amount_pence: number | null;
};

export type FrDriverSettlementTrip = {
  trip_id: string | null;
  driver_net_pence: number | null;
  settlement_status?: string | null;
};

export type FrDriverPayoutLedgerItem = {
  status: string | null;
  net_driver_payout_pence?: number | null;
  amount_pence?: number | null;
};

export type FrDriverReconciliationInput = {
  ledger: FrDriverLedgerRow[];
  /** Settled trips with canonical driver_net_pence. */
  settledTrips: FrDriverSettlementTrip[];
  /** Completed / paid payout ledger items for this driver. */
  completedPayoutItems: FrDriverPayoutLedgerItem[];
  /** Wallet evidence loaded successfully (empty array still counts as available). */
  walletEvidenceAvailable: boolean;
  /** Settlement evidence loaded successfully. */
  settlementEvidenceAvailable: boolean;
  /** Identity mapping valid (driver row found). */
  identityMappingValid: boolean;
  accountVerified: boolean | null;
  payout_provider?: string | null;
  finance_cleared_pence: number;
  in_flight_cashout_pence?: number;
  recovery_debt_pence?: number;
  payout_blocked?: boolean;
  /**
   * External provider account balance (Stripe Connect / etc).
   * null + status UNAVAILABLE = fetch failed / unknown — never coerce to 0 for display.
   */
  provider_account_balance_pence: number | null;
  provider_account_balance_status: ProviderAccountBalanceStatus;
  pending_balance_pence?: number | null;
};

export type FrDriverReconciliationRow = {
  expected_payable_pence: number | null;
  actual_wallet_trip_credits_pence: number | null;
  wallet_adjustments_pence: number;
  debt_recovery_pence: number;
  payouts_debited_pence: number;
  current_wallet_balance_pence: number | null;
  available_for_payout_pence: number | null;
  pending_balance_pence: number | null;
  provider_account_balance_pence: number | null;
  provider_account_balance_status: ProviderAccountBalanceStatus;
  wallet_variance_pence: number | null;
  payout_variance_pence: number | null;
  reconciliation_status: FrDriverReconciliationStatus;
  reconciliation_reasons: string[];
  /** Reference-only — never used as wallet truth. */
  provider_balance_is_reference_only: true;
};

export type FrDriverAuditOverviewCounts = {
  drivers_balanced_count: number;
  driver_wallet_mismatches_count: number;
  payout_mismatches_count: number;
  provider_balance_unavailable_count: number;
  pending_sync_count: number;
  drivers_audited_count: number;
  driver_audit_complete: boolean;
  overview_driver_audit_status:
    | "BALANCED"
    | "SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING"
    | "PARTIAL"
    | "DRIVER_AUDIT_MISMATCH";
};

function toLedgerRows(ledger: FrDriverLedgerRow[]): Array<{ type: string; amount_pence: number }> {
  return ledger.map((r) => ({
    type: String(r.type ?? ""),
    amount_pence: Math.round(Number(r.amount_pence ?? 0)),
  }));
}

function isBalanceAffecting(type: string): boolean {
  return !(BALANCE_EXCLUDED_LEDGER_TYPES as readonly string[]).includes(type);
}

function sumByTypes(ledger: FrDriverLedgerRow[], types: Set<string>): number {
  let sum = 0;
  for (const row of ledger) {
    const t = String(row.type ?? "").toUpperCase();
    if (!types.has(t)) continue;
    if (!isBalanceAffecting(t) && !TRIP_CREDIT_TYPES.has(t)) continue;
    sum += Math.round(Number(row.amount_pence ?? 0));
  }
  return sum;
}

/** Trip credits: TRIP_EARNING_NET + settlement corrections (balance-affecting). */
export function sumActualWalletTripCreditsPence(ledger: FrDriverLedgerRow[]): number {
  let sum = 0;
  for (const row of ledger) {
    const t = String(row.type ?? "").toUpperCase();
    if (!TRIP_CREDIT_TYPES.has(t)) continue;
    if (t !== "TRIP_EARNING_NET" && !isBalanceAffecting(t)) continue;
    sum += Math.round(Number(row.amount_pence ?? 0));
  }
  return sum;
}

/** Adjustments excluding trip credits / payouts / debt / bonuses. */
export function sumWalletAdjustmentsPence(ledger: FrDriverLedgerRow[]): number {
  return sumByTypes(ledger, ADJUSTMENT_TYPES);
}

export function sumDebtRecoveryDebitsPence(ledger: FrDriverLedgerRow[]): number {
  // Debits are negative; report absolute recovered amount for display.
  let sum = 0;
  for (const row of ledger) {
    const t = String(row.type ?? "").toUpperCase();
    if (!DEBT_RECOVERY_TYPES.has(t)) continue;
    sum += Math.abs(Math.round(Number(row.amount_pence ?? 0)));
  }
  return sum;
}

export function sumPayoutsDebitedPence(ledger: FrDriverLedgerRow[]): number {
  let sum = 0;
  for (const row of ledger) {
    const t = String(row.type ?? "").toUpperCase();
    if (PAYOUT_DEBIT_TYPES.has(t)) {
      sum += Math.abs(Math.round(Number(row.amount_pence ?? 0)));
    } else if (PAYOUT_REVERSAL_TYPES.has(t)) {
      sum -= Math.abs(Math.round(Number(row.amount_pence ?? 0)));
    }
  }
  return Math.max(0, sum);
}

export function sumExpectedPayablePence(trips: FrDriverSettlementTrip[]): number | null {
  if (trips.length === 0) return 0;
  let sum = 0;
  let anyKnown = false;
  for (const trip of trips) {
    if (trip.driver_net_pence == null) continue;
    anyKnown = true;
    sum += Math.max(0, Math.round(Number(trip.driver_net_pence)));
  }
  // Settlements present but every net missing → evidence incomplete.
  if (!anyKnown && trips.some((t) => t.trip_id)) return null;
  return sum;
}

export function sumCompletedPayoutLedgerPence(items: FrDriverPayoutLedgerItem[]): number {
  const done = new Set(["completed", "paid", "succeeded"]);
  return items.reduce((s, row) => {
    const st = String(row.status ?? "").toLowerCase();
    if (!done.has(st)) return s;
    return s + Math.max(0, Math.round(Number(row.net_driver_payout_pence ?? row.amount_pence ?? 0)));
  }, 0);
}

/**
 * Classify one driver independently. Never nets across drivers.
 * Provider Connect balance is never compared to expected payable.
 */
export function computeFrDriverReconciliation(
  input: FrDriverReconciliationInput,
): FrDriverReconciliationRow {
  const reasons: string[] = [];
  const manualBank = isManualBankPayoutProviderName(input.payout_provider);

  if (!input.identityMappingValid) {
    return {
      expected_payable_pence: null,
      actual_wallet_trip_credits_pence: null,
      wallet_adjustments_pence: 0,
      debt_recovery_pence: 0,
      payouts_debited_pence: 0,
      current_wallet_balance_pence: null,
      available_for_payout_pence: null,
      pending_balance_pence: null,
      provider_account_balance_pence: input.provider_account_balance_pence,
      provider_account_balance_status: input.provider_account_balance_status,
      wallet_variance_pence: null,
      payout_variance_pence: null,
      reconciliation_status: "MISSING_SETTLEMENT_EVIDENCE",
      reconciliation_reasons: ["Driver identity mapping missing"],
      provider_balance_is_reference_only: true,
    };
  }

  if (!input.walletEvidenceAvailable) {
    return {
      expected_payable_pence: null,
      actual_wallet_trip_credits_pence: null,
      wallet_adjustments_pence: 0,
      debt_recovery_pence: 0,
      payouts_debited_pence: 0,
      current_wallet_balance_pence: null,
      available_for_payout_pence: null,
      pending_balance_pence: null,
      provider_account_balance_pence: input.provider_account_balance_pence,
      provider_account_balance_status: input.provider_account_balance_status,
      wallet_variance_pence: null,
      payout_variance_pence: null,
      reconciliation_status: "MISSING_WALLET_EVIDENCE",
      reconciliation_reasons: ["Driver wallet ledger evidence unavailable"],
      provider_balance_is_reference_only: true,
    };
  }

  if (!input.settlementEvidenceAvailable) {
    return {
      expected_payable_pence: null,
      actual_wallet_trip_credits_pence: sumActualWalletTripCreditsPence(input.ledger),
      wallet_adjustments_pence: sumWalletAdjustmentsPence(input.ledger),
      debt_recovery_pence: sumDebtRecoveryDebitsPence(input.ledger),
      payouts_debited_pence: sumPayoutsDebitedPence(input.ledger),
      current_wallet_balance_pence: computeLedgerWalletBalancePence(toLedgerRows(input.ledger)),
      available_for_payout_pence: null,
      pending_balance_pence: input.pending_balance_pence ?? null,
      provider_account_balance_pence: input.provider_account_balance_pence,
      provider_account_balance_status: input.provider_account_balance_status,
      wallet_variance_pence: null,
      payout_variance_pence: null,
      reconciliation_status: "MISSING_SETTLEMENT_EVIDENCE",
      reconciliation_reasons: ["Settlement evidence unavailable"],
      provider_balance_is_reference_only: true,
    };
  }

  if (input.accountVerified === false) {
    reasons.push("Driver payout account not verified");
  }

  const expected = sumExpectedPayablePence(input.settledTrips);
  const actualCredits = sumActualWalletTripCreditsPence(input.ledger);
  const adjustments = sumWalletAdjustmentsPence(input.ledger);
  const debtRecovery = sumDebtRecoveryDebitsPence(input.ledger);
  const payoutsDebited = sumPayoutsDebitedPence(input.ledger);
  const bonuses = sumByTypes(input.ledger, BONUS_TYPES);
  const refundDebits = (() => {
    let s = 0;
    for (const row of input.ledger) {
      const t = String(row.type ?? "").toUpperCase();
      if (!REFUND_DEBIT_TYPES.has(t)) continue;
      s += Math.abs(Math.round(Number(row.amount_pence ?? 0)));
    }
    return s;
  })();

  const walletBalance = computeLedgerWalletBalancePence(toLedgerRows(input.ledger));
  const completedPayoutLedger = sumCompletedPayoutLedgerPence(input.completedPayoutItems);

  const walletVariance = expected == null ? null : actualCredits - expected;
  const payoutVariance = payoutsDebited - completedPayoutLedger;

  const recovery = Math.max(0, Math.round(input.recovery_debt_pence ?? debtRecovery));
  const inFlight = Math.max(0, Math.round(input.in_flight_cashout_pence ?? 0));
  const financeCleared = Math.max(0, Math.round(input.finance_cleared_pence));
  const walletOwed = Math.max(0, walletBalance);

  const availableForPayout = manualBank
    ? computeManualBankAvailablePence({
      wallet_owed_pence: walletOwed,
      finance_cleared_pence: financeCleared,
      recovery_debt_pence: recovery,
      in_flight_cashout_pence: inFlight,
      payout_blocked: input.payout_blocked,
    })
    : computeAvailableCashOutPence({
      // Eligibility may treat unknown Connect as 0 capacity — display stays null separately.
      stripe_connect_available_pence:
        input.provider_account_balance_status === "AVAILABLE"
          ? input.provider_account_balance_pence
          : null,
      finance_cleared_pence: financeCleared,
      recovery_debt_pence: recovery,
      in_flight_cashout_pence: inFlight,
      payout_blocked: input.payout_blocked,
    });

  const pending =
    input.pending_balance_pence != null
      ? Math.max(0, Math.round(input.pending_balance_pence))
      : Math.max(0, financeCleared - availableForPayout);

  // Identity check (informational): trip credits + bonuses + adjustments − debt − refunds − payouts
  const reconstructed =
    actualCredits + bonuses + adjustments - debtRecovery - refundDebits - payoutsDebited;
  if (reconstructed !== walletBalance) {
    // Soft note only — balance SSOT remains computeLedgerWalletBalancePence.
    reasons.push(
      `Wallet composition note: reconstructed ${reconstructed}p vs ledger SSOT ${walletBalance}p`,
    );
  }

  const walletMismatch = expected == null || walletVariance == null || walletVariance !== 0;
  // Payout evidence required when either side has activity.
  const payoutActivity = payoutsDebited > 0 || completedPayoutLedger > 0;
  const payoutMismatch = payoutActivity && payoutVariance !== 0;

  if (expected == null) {
    return {
      expected_payable_pence: null,
      actual_wallet_trip_credits_pence: actualCredits,
      wallet_adjustments_pence: adjustments,
      debt_recovery_pence: debtRecovery,
      payouts_debited_pence: payoutsDebited,
      current_wallet_balance_pence: walletBalance,
      available_for_payout_pence: availableForPayout,
      pending_balance_pence: pending,
      provider_account_balance_pence: input.provider_account_balance_pence,
      provider_account_balance_status: input.provider_account_balance_status,
      wallet_variance_pence: null,
      payout_variance_pence: payoutVariance,
      reconciliation_status: "PENDING_SYNC",
      reconciliation_reasons: ["Expected driver payable not yet available"],
      provider_balance_is_reference_only: true,
    };
  }

  if (walletMismatch && walletVariance !== 0) {
    reasons.push(
      `Wallet variance ${walletVariance}p (credits ${actualCredits}p vs payable ${expected}p)`,
    );
  }
  if (payoutMismatch) {
    reasons.push(
      `Payout variance ${payoutVariance}p (wallet debits ${payoutsDebited}p vs payout ledger ${completedPayoutLedger}p)`,
    );
  }

  let status: FrDriverReconciliationStatus;
  if (walletMismatch && walletVariance !== 0 && payoutMismatch) {
    status = "DRIVER_AND_PAYOUT_MISMATCH";
  } else if (walletMismatch && walletVariance !== 0) {
    status = "DRIVER_WALLET_MISMATCH";
  } else if (payoutMismatch) {
    status = "PAYOUT_MISMATCH";
  } else if (input.accountVerified === false) {
    status = "ACCOUNT_UNVERIFIED";
  } else if (
    input.provider_account_balance_status === "UNAVAILABLE"
    && !manualBank
  ) {
    // Stripe-mode: provider reference missing — do not fake BALANCED on Connect success path.
    // Wallet invariants hold; surface provider unavailable as dedicated status.
    status = "PROVIDER_BALANCE_UNAVAILABLE";
    reasons.push("Provider account balance unavailable — not treated as £0.00");
  } else {
    status = "BALANCED";
  }

  // Revolut: provider Connect may be UNAVAILABLE / leftover — never blocks BALANCED when wallet matches.
  if (
    manualBank
    && status === "PROVIDER_BALANCE_UNAVAILABLE"
    && !walletMismatch
    && !payoutMismatch
    && input.accountVerified !== false
  ) {
    status = "BALANCED";
    reasons.push("Provider Connect balance is reference-only for Revolut payout mode");
  }

  return {
    expected_payable_pence: expected,
    actual_wallet_trip_credits_pence: actualCredits,
    wallet_adjustments_pence: adjustments,
    debt_recovery_pence: debtRecovery,
    payouts_debited_pence: payoutsDebited,
    current_wallet_balance_pence: walletBalance,
    available_for_payout_pence: availableForPayout,
    pending_balance_pence: pending,
    provider_account_balance_pence:
      input.provider_account_balance_status === "UNAVAILABLE"
        ? null
        : input.provider_account_balance_pence,
    provider_account_balance_status: input.provider_account_balance_status,
    wallet_variance_pence: walletVariance,
    payout_variance_pence: payoutVariance,
    reconciliation_status: status,
    reconciliation_reasons: reasons,
    provider_balance_is_reference_only: true,
  };
}

/** Aggregate per-driver statuses — no cross-driver amount netting. */
export function aggregateFrDriverAuditOverview(
  rows: Array<{ reconciliation_status: FrDriverReconciliationStatus }>,
  args?: { settlementIdentityBalanced?: boolean },
): FrDriverAuditOverviewCounts {
  let balanced = 0;
  let walletMismatch = 0;
  let payoutMismatch = 0;
  let providerUnavailable = 0;
  let pendingSync = 0;

  for (const row of rows) {
    const s = row.reconciliation_status;
    if (s === "BALANCED") balanced += 1;
    if (
      s === "DRIVER_WALLET_MISMATCH"
      || s === "DRIVER_AND_PAYOUT_MISMATCH"
      || s === "MISSING_WALLET_EVIDENCE"
    ) {
      walletMismatch += 1;
    }
    if (s === "PAYOUT_MISMATCH" || s === "DRIVER_AND_PAYOUT_MISMATCH") {
      payoutMismatch += 1;
    }
    if (s === "PROVIDER_BALANCE_UNAVAILABLE") providerUnavailable += 1;
    if (
      s === "PENDING_SYNC"
      || s === "MISSING_SETTLEMENT_EVIDENCE"
      || s === "ACCOUNT_UNVERIFIED"
    ) {
      pendingSync += 1;
    }
  }

  const audited = rows.length;
  const mismatchAny = walletMismatch > 0 || payoutMismatch > 0;
  const incomplete = pendingSync > 0 || providerUnavailable > 0;
  const settlementOk = args?.settlementIdentityBalanced === true;

  let overview: FrDriverAuditOverviewCounts["overview_driver_audit_status"];
  if (audited === 0) {
    overview = "SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING";
  } else if (mismatchAny) {
    overview = "DRIVER_AUDIT_MISMATCH";
  } else if (incomplete) {
    overview = settlementOk
      ? "SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING"
      : "PARTIAL";
  } else if (balanced === audited) {
    overview = "BALANCED";
  } else {
    overview = "PARTIAL";
  }

  return {
    drivers_balanced_count: balanced,
    driver_wallet_mismatches_count: walletMismatch,
    payout_mismatches_count: payoutMismatch,
    provider_balance_unavailable_count: providerUnavailable,
    pending_sync_count: pendingSync,
    drivers_audited_count: audited,
    driver_audit_complete: audited > 0 && !incomplete && !mismatchAny,
    overview_driver_audit_status: overview,
  };
}
