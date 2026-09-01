/**
 * Financial Reconciliation — per-driver wallet vs payable invariants (audit only).
 *
 * Hard rules:
 * - Driver Wallet Ledger owns wallet balance.
 * - Provider Account Balance is reference-only (never reconciliation truth).
 * - No cross-driver netting.
 * - Unknown is never zero for classification / display of provider balance.
 *
 * Same-scope rules (FR must not invent mismatches):
 * - Period payable variance = period TEN credits − period expected stamps.
 *   Payout / cashout debits are excluded from that variance.
 * - Live wallet balance / available / pending are informational (Wallet / Payout pages).
 *   They must never drive DRIVER_WALLET_MISMATCH by themselves.
 * - Pending 27h credits and post-payout TEN rows are not payout mismatches.
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
import {
  FR_EXPECTED_STAMP_STATUS,
  sumFrDriverExpectedEntitlementPence,
  type FrDriverSettlementTripForReconciliation,
} from "./frDriverExpectedEntitlementSSOT.ts";

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

/** FR Drivers tab — credit layer only (never combined with payout). */
export const FR_DRIVER_CREDIT_STATUSES = [
  "DRIVER_CREDIT_OK",
  "DRIVER_UNDER_CREDITED",
  "DRIVER_OVER_CREDITED",
  "DRIVER_CREDIT_UNKNOWN",
  "EXPECTED_STAMP_MISSING",
] as const;

export type FrDriverCreditStatus = (typeof FR_DRIVER_CREDIT_STATUSES)[number];

/** FR Drivers tab — payout ledger vs wallet transfer debits (fees excluded). */
export const FR_PAYOUT_RECONCILIATION_STATUSES = [
  "PAYOUT_OK",
  "PAYOUT_MISMATCH",
] as const;

export type FrPayoutReconciliationStatus = (typeof FR_PAYOUT_RECONCILIATION_STATUSES)[number];

export const FR_QUERY_SCOPE_STATUSES = [
  "PERIOD_SCOPED",
  "LIFETIME",
  "QUERY_SCOPE_MISMATCH",
] as const;

export type FrQueryScopeStatus = (typeof FR_QUERY_SCOPE_STATUSES)[number];

const FR_VERIFIED_STAMP_FIELDS_EMPTY = {
  verified_expected_payable_pence: null as number | null,
  verified_wallet_credits_pence: null as number | null,
  unverified_wallet_credits_pence: 0,
  missing_stamp_trip_count: 0,
  missing_stamp_trip_codes: [] as string[],
};

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
  related_trip_id?: string | null;
};

export type FrDriverSettlementTrip = FrDriverSettlementTripForReconciliation;

export type FrDriverPayoutLedgerItem = {
  status: string | null;
  net_driver_payout_pence?: number | null;
  amount_pence?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type FrDriverLedgerRowWithTrip = FrDriverLedgerRow & {
  related_trip_id?: string | null;
  created_at?: string | null;
};

export type FrDriverSettlementTripWithCompleted = FrDriverSettlementTrip & {
  completed_at?: string | null;
  trip_code?: string | null;
  financial_settled_at?: string | null;
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
  /** PERIOD_SCOPED when FR Drivers tab supplied from/to; LIFETIME otherwise. */
  query_scope_status?: FrQueryScopeStatus;
  /**
   * External provider account balance (provider Connect / etc).
   * null + status UNAVAILABLE = fetch failed / unknown — never coerce to 0 for display.
   */
  provider_account_balance_pence: number | null;
  provider_account_balance_status: ProviderAccountBalanceStatus;
  pending_balance_pence?: number | null;
};

export type FrDriverReconciliationRow = {
  expected_payable_pence: number | null;
  actual_wallet_trip_credits_pence: number | null;
  /** Evaluable trips only — same basis as wallet_variance when stamps are missing. */
  verified_expected_payable_pence: number | null;
  verified_wallet_credits_pence: number | null;
  /** Wallet TEN on trips with EXPECTED_STAMP_MISSING — informational, not variance. */
  unverified_wallet_credits_pence: number;
  missing_stamp_trip_count: number;
  missing_stamp_trip_codes: string[];
  wallet_adjustments_pence: number;
  debt_recovery_pence: number;
  /** Lifetime wallet payout debits incl. fees — not the Paid out column. */
  payouts_debited_pence: number;
  /** Completed Payout Ledger items — Paid out column SSOT. */
  payout_ledger_completed_pence: number;
  current_wallet_balance_pence: number | null;
  available_for_payout_pence: number | null;
  pending_balance_pence: number | null;
  provider_account_balance_pence: number | null;
  provider_account_balance_status: ProviderAccountBalanceStatus;
  wallet_variance_pence: number | null;
  payout_variance_pence: number | null;
  reconciliation_status: FrDriverReconciliationStatus;
  driver_credit_status: FrDriverCreditStatus;
  payout_status: FrPayoutReconciliationStatus;
  query_scope_status: FrQueryScopeStatus;
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
export function sumActualWalletTripCreditsPence(
  ledger: FrDriverLedgerRow[],
  tripIds?: Set<string> | null,
): number {
  let sum = 0;
  for (const row of ledger) {
    const t = String(row.type ?? "").toUpperCase();
    if (!TRIP_CREDIT_TYPES.has(t)) continue;
    if (t !== "TRIP_EARNING_NET" && !isBalanceAffecting(t)) continue;
    const tripId = row.related_trip_id == null ? null : String(row.related_trip_id);
    if (tripIds && tripIds.size > 0 && (!tripId || !tripIds.has(tripId))) continue;
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

/** Wallet transfer debits matched to Payout Ledger — excludes CASHOUT_FEE. */
export function sumPayoutWalletTransfersPence(ledger: FrDriverLedgerRow[]): number {
  let sum = 0;
  for (const row of ledger) {
    const t = String(row.type ?? "").toUpperCase();
    if (t === "CASHOUT_FEE") continue;
    if (PAYOUT_DEBIT_TYPES.has(t)) {
      sum += Math.abs(Math.round(Number(row.amount_pence ?? 0)));
    } else if (PAYOUT_REVERSAL_TYPES.has(t)) {
      sum -= Math.abs(Math.round(Number(row.amount_pence ?? 0)));
    }
  }
  return Math.max(0, sum);
}

export function isInstantInFinancePeriod(
  iso: string | null | undefined,
  periodFrom: string,
  periodTo: string,
): boolean {
  if (!iso?.trim()) return false;
  const t = new Date(iso).getTime();
  const from = new Date(periodFrom).getTime();
  const to = new Date(periodTo).getTime();
  if (Number.isNaN(t) || Number.isNaN(from) || Number.isNaN(to)) return false;
  return t >= from && t <= to;
}

/**
 * Same-scope period filter for FR Drivers tab.
 * Expected + wallet credits are tied to trips completed in the selected period.
 * Payout ledger items are filtered by updated_at (fallback created_at).
 */
export function buildPeriodScopedFrDriverInputs(args: {
  periodFrom: string;
  periodTo: string;
  ledger: FrDriverLedgerRowWithTrip[];
  settledTrips: FrDriverSettlementTripWithCompleted[];
  completedPayoutItems: FrDriverPayoutLedgerItem[];
}): {
  ledger: FrDriverLedgerRow[];
  settledTrips: FrDriverSettlementTrip[];
  completedPayoutItems: FrDriverPayoutLedgerItem[];
  period_trip_ids: string[];
} {
  const periodTripIds = new Set(
    args.settledTrips
      .filter((trip) => {
        if (!trip.trip_id) return false;
        const earnedAt = trip.financial_settled_at ?? trip.completed_at;
        return isInstantInFinancePeriod(earnedAt, args.periodFrom, args.periodTo);
      })
      .map((trip) => String(trip.trip_id)),
  );

  const periodSettledTrips = args.settledTrips.filter(
    (trip) => trip.trip_id && periodTripIds.has(String(trip.trip_id)),
  );

  const periodLedger = args.ledger.filter((row) => {
    const type = String(row.type ?? "").toUpperCase();
    if (!TRIP_CREDIT_TYPES.has(type)) return false;
    const tripId = row.related_trip_id;
    return Boolean(tripId && periodTripIds.has(String(tripId)));
  });

  const periodPayoutItems = args.completedPayoutItems.filter((item) =>
    isInstantInFinancePeriod(item.updated_at ?? item.created_at, args.periodFrom, args.periodTo)
  );

  return {
    ledger: periodLedger,
    settledTrips: periodSettledTrips,
    completedPayoutItems: periodPayoutItems,
    period_trip_ids: [...periodTripIds],
  };
}

export function classifyFrDriverCreditStatus(args: {
  wallet_variance_pence: number | null;
  expected_payable_pence: number | null;
  missing_stamp_trip_count?: number;
  evaluable_trip_count?: number;
}): FrDriverCreditStatus {
  if ((args.missing_stamp_trip_count ?? 0) > 0) {
    return "EXPECTED_STAMP_MISSING";
  }
  if (args.expected_payable_pence == null || args.wallet_variance_pence == null) {
    return "DRIVER_CREDIT_UNKNOWN";
  }
  if ((args.evaluable_trip_count ?? 0) === 0) {
    return "DRIVER_CREDIT_UNKNOWN";
  }
  if (args.wallet_variance_pence === 0) return "DRIVER_CREDIT_OK";
  if (args.wallet_variance_pence < 0) return "DRIVER_UNDER_CREDITED";
  return "DRIVER_OVER_CREDITED";
}

export function classifyFrPayoutStatus(payout_variance_pence: number, payoutActivity: boolean): FrPayoutReconciliationStatus {
  if (!payoutActivity || payout_variance_pence === 0) return "PAYOUT_OK";
  return "PAYOUT_MISMATCH";
}

export function sumExpectedPayablePence(trips: FrDriverSettlementTrip[]): number | null {
  return sumFrDriverExpectedEntitlementPence(trips).expected_payable_pence;
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
 * Same-scope period payable variance.
 * Payout / cashout / fee debits must not enter this comparison.
 */
export function periodPayableVariancePence(args: {
  expected_payable_pence: number | null;
  actual_ten_credits_pence: number | null;
}): number | null {
  if (args.expected_payable_pence == null || args.actual_ten_credits_pence == null) return null;
  return Math.round(args.actual_ten_credits_pence) - Math.round(args.expected_payable_pence);
}

/** Live wallet balance is never the FR reconciliation-status input. */
export function frReconciliationStatusIgnoresLiveWalletBalance(): true {
  return true;
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
      ...FR_VERIFIED_STAMP_FIELDS_EMPTY,
      expected_payable_pence: null,
      actual_wallet_trip_credits_pence: null,
      wallet_adjustments_pence: 0,
      debt_recovery_pence: 0,
      payouts_debited_pence: 0,
      payout_ledger_completed_pence: 0,
      current_wallet_balance_pence: null,
      available_for_payout_pence: null,
      pending_balance_pence: null,
      provider_account_balance_pence: input.provider_account_balance_pence,
      provider_account_balance_status: input.provider_account_balance_status,
      wallet_variance_pence: null,
      payout_variance_pence: null,
      reconciliation_status: "MISSING_SETTLEMENT_EVIDENCE",
      driver_credit_status: "DRIVER_CREDIT_UNKNOWN",
      payout_status: "PAYOUT_OK",
      query_scope_status: input.query_scope_status ?? "LIFETIME",
      reconciliation_reasons: ["Driver identity mapping missing"],
      provider_balance_is_reference_only: true,
    };
  }

  if (!input.walletEvidenceAvailable) {
    return {
      ...FR_VERIFIED_STAMP_FIELDS_EMPTY,
      expected_payable_pence: null,
      actual_wallet_trip_credits_pence: null,
      wallet_adjustments_pence: 0,
      debt_recovery_pence: 0,
      payouts_debited_pence: 0,
      payout_ledger_completed_pence: 0,
      current_wallet_balance_pence: null,
      available_for_payout_pence: null,
      pending_balance_pence: null,
      provider_account_balance_pence: input.provider_account_balance_pence,
      provider_account_balance_status: input.provider_account_balance_status,
      wallet_variance_pence: null,
      payout_variance_pence: null,
      reconciliation_status: "MISSING_WALLET_EVIDENCE",
      driver_credit_status: "DRIVER_CREDIT_UNKNOWN",
      payout_status: "PAYOUT_OK",
      query_scope_status: input.query_scope_status ?? "LIFETIME",
      reconciliation_reasons: ["Driver wallet ledger evidence unavailable"],
      provider_balance_is_reference_only: true,
    };
  }

  if (!input.settlementEvidenceAvailable) {
    return {
      ...FR_VERIFIED_STAMP_FIELDS_EMPTY,
      expected_payable_pence: null,
      actual_wallet_trip_credits_pence: sumActualWalletTripCreditsPence(input.ledger),
      wallet_adjustments_pence: sumWalletAdjustmentsPence(input.ledger),
      debt_recovery_pence: sumDebtRecoveryDebitsPence(input.ledger),
      payouts_debited_pence: sumPayoutsDebitedPence(input.ledger),
      payout_ledger_completed_pence: sumCompletedPayoutLedgerPence(input.completedPayoutItems),
      current_wallet_balance_pence: computeLedgerWalletBalancePence(toLedgerRows(input.ledger)),
      available_for_payout_pence: null,
      pending_balance_pence: input.pending_balance_pence ?? null,
      provider_account_balance_pence: input.provider_account_balance_pence,
      provider_account_balance_status: input.provider_account_balance_status,
      wallet_variance_pence: null,
      payout_variance_pence: null,
      reconciliation_status: "MISSING_SETTLEMENT_EVIDENCE",
      driver_credit_status: "DRIVER_CREDIT_UNKNOWN",
      payout_status: "PAYOUT_OK",
      query_scope_status: input.query_scope_status ?? "LIFETIME",
      reconciliation_reasons: ["Settlement evidence unavailable"],
      provider_balance_is_reference_only: true,
    };
  }

  if (input.accountVerified === false) {
    reasons.push("Driver payout account not verified");
  }

  const entitlementSummary = sumFrDriverExpectedEntitlementPence(input.settledTrips);
  const evaluableTrips = input.settledTrips.filter(
    (trip) =>
      trip.expected_stamp_status !== FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING
      && trip.expected_entitlement_pence != null
      && trip.trip_id,
  );
  const evaluableTripIds = new Set(evaluableTrips.map((trip) => String(trip.trip_id)));
  const missingStampTrips = input.settledTrips.filter((trip) => {
    if (!trip.trip_id) return false;
    const explicitStatus = trip.expected_stamp_status;
    if (explicitStatus === FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING) return true;
    const entitlement = trip.expected_entitlement_pence ?? (
      trip.driver_net_pence == null
        ? null
        : Math.max(0, Math.round(Number(trip.driver_net_pence)))
    );
    return entitlement == null;
  });
  const missingStampTripIds = new Set(missingStampTrips.map((trip) => String(trip.trip_id)));
  const unverifiedWalletCredits = sumActualWalletTripCreditsPence(input.ledger, missingStampTripIds);
  const missingStampTripCodes = missingStampTrips
    .map((trip) => trip.trip_code?.trim())
    .filter((code): code is string => Boolean(code));
  const expected = entitlementSummary.missing_stamp_trip_count > 0
    ? sumFrDriverExpectedEntitlementPence(evaluableTrips).expected_payable_pence
    : entitlementSummary.expected_payable_pence;
  const actualCredits = entitlementSummary.missing_stamp_trip_count > 0
    ? sumActualWalletTripCreditsPence(input.ledger, evaluableTripIds)
    : sumActualWalletTripCreditsPence(input.ledger);
  const adjustments = sumWalletAdjustmentsPence(input.ledger);
  const debtRecovery = sumDebtRecoveryDebitsPence(input.ledger);
  const payoutsDebited = sumPayoutsDebitedPence(input.ledger);
  const payoutTransfers = sumPayoutWalletTransfersPence(input.ledger);
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

  // Same-scope: TEN credits vs expected stamps only — never live balance vs period payable,
  // and never subtract payout debits from this variance.
  const walletVariance = periodPayableVariancePence({
    expected_payable_pence: expected,
    actual_ten_credits_pence: actualCredits,
  });
  // Fees (CASHOUT_FEE) are wallet debits but not Payout Ledger paid-out amounts.
  const payoutVariance = payoutTransfers - completedPayoutLedger;
  const queryScopeStatus = input.query_scope_status ?? "LIFETIME";

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
      provider_available_pence:
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
  // Post-payout TEN that still matches expected stamps is not a payout mismatch.
  const payoutActivity = payoutTransfers > 0 || completedPayoutLedger > 0;
  const payoutMismatch = payoutActivity && payoutVariance !== 0;

  // Pending 27h / available split is informational — never flip wallet mismatch alone.
  if ((input.pending_balance_pence ?? 0) > 0 && walletVariance === 0) {
    reasons.push(
      "Pending 27h credits and post-payout credits are not payout mismatches.",
    );
  }

  if (expected == null) {
    return {
      ...FR_VERIFIED_STAMP_FIELDS_EMPTY,
      missing_stamp_trip_count: entitlementSummary.missing_stamp_trip_count,
      missing_stamp_trip_codes: missingStampTripCodes,
      unverified_wallet_credits_pence: unverifiedWalletCredits,
      expected_payable_pence: null,
      actual_wallet_trip_credits_pence: actualCredits,
      wallet_adjustments_pence: adjustments,
      debt_recovery_pence: debtRecovery,
      payouts_debited_pence: payoutsDebited,
      payout_ledger_completed_pence: completedPayoutLedger,
      current_wallet_balance_pence: walletBalance,
      available_for_payout_pence: availableForPayout,
      pending_balance_pence: pending,
      provider_account_balance_pence: input.provider_account_balance_pence,
      provider_account_balance_status: input.provider_account_balance_status,
      wallet_variance_pence: null,
      payout_variance_pence: payoutVariance,
      reconciliation_status: "PENDING_SYNC",
      driver_credit_status: "DRIVER_CREDIT_UNKNOWN",
      payout_status: classifyFrPayoutStatus(payoutVariance, payoutActivity),
      query_scope_status: queryScopeStatus,
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
      `Payout variance ${payoutVariance}p (wallet transfers ${payoutTransfers}p vs payout ledger ${completedPayoutLedger}p; fees excluded)`,
    );
  }

  if (entitlementSummary.missing_stamp_trip_count > 0) {
    reasons.push(
      `${entitlementSummary.missing_stamp_trip_count} trip(s) with EXPECTED_STAMP_MISSING — excluded from variance`,
    );
  }

  const driverCreditStatus = classifyFrDriverCreditStatus({
    wallet_variance_pence: walletVariance,
    expected_payable_pence: expected,
    missing_stamp_trip_count: entitlementSummary.missing_stamp_trip_count,
    evaluable_trip_count: entitlementSummary.evaluable_trip_count,
  });
  const payoutStatus = classifyFrPayoutStatus(payoutVariance, payoutActivity);

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
    // provider-mode: provider reference missing — do not fake BALANCED on Connect success path.
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
    verified_expected_payable_pence: expected,
    verified_wallet_credits_pence: actualCredits,
    unverified_wallet_credits_pence: unverifiedWalletCredits,
    missing_stamp_trip_count: entitlementSummary.missing_stamp_trip_count,
    missing_stamp_trip_codes: missingStampTripCodes,
    expected_payable_pence: expected,
    actual_wallet_trip_credits_pence: actualCredits,
    wallet_adjustments_pence: adjustments,
    debt_recovery_pence: debtRecovery,
    payouts_debited_pence: payoutsDebited,
    payout_ledger_completed_pence: completedPayoutLedger,
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
    driver_credit_status: driverCreditStatus,
    payout_status: payoutStatus,
    query_scope_status: queryScopeStatus,
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
    const credit = (row as { driver_credit_status?: FrDriverCreditStatus }).driver_credit_status;
    const payout = (row as { payout_status?: FrPayoutReconciliationStatus }).payout_status;
    if (s === "BALANCED") balanced += 1;
    if (
      s === "DRIVER_WALLET_MISMATCH"
      || s === "DRIVER_AND_PAYOUT_MISMATCH"
      || s === "MISSING_WALLET_EVIDENCE"
      || credit === "DRIVER_UNDER_CREDITED"
      || credit === "DRIVER_OVER_CREDITED"
      || credit === "EXPECTED_STAMP_MISSING"
    ) {
      walletMismatch += 1;
    }
    if (
      s === "PAYOUT_MISMATCH"
      || s === "DRIVER_AND_PAYOUT_MISMATCH"
      || payout === "PAYOUT_MISMATCH"
    ) {
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
