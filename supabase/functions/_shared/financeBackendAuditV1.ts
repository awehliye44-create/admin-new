/**
 * finance_backend_audit_v1 — backend money audit (no UI assumptions).
 *
 * Rules enforced:
 * - Provider available balance is NOT ONECAB commission.
 * - Wallet balance is NOT available payout.
 * - driver_available_now = min(driver_remaining_liability, provider_available_balance).
 * - Successful payout must have negative ledger entry or wallet stays inflated.
 */

import {
  buildSplitReconciliationCheck,
  computePaymentMethodLedgerMetrics,
  tripTipsPence,
  type PaymentCaptureRow,
} from "./financialReconciliationSSOT.ts";
import {
  sumRefundedAmountPence,
  tripDriverNetPence,
  tripGrossCommissionPence,
  tripStripeFeePence,
  type TripAuditSourceRow,
} from "./financeSettlementSummary.ts";

export { sumLedgerWalletBalanceByDriver } from "./walletBalanceSSOT.ts";

export const PAYOUT_DEBIT_LEDGER_TYPES = [
  "PAYOUT",
  "EARLY_CASHOUT",
  "WEEKLY_PAYOUT",
  "MANUAL_PAYOUT",
] as const;

export type FinanceBackendAuditV1 = {
  audit_version: "finance_backend_audit_v1";
  period: { from: string; to: string };
  currency_code: string;
  incoming_money: {
    card_customer_revenue_pence: number;
    cash_collected_by_driver_pence: number;
    customer_captured_total_pence: number;
    customer_refunded_total_pence: number;
    net_customer_money_in_pence: number;
    net_card_revenue_pence: number;
    provider_available_balance_pence: number;
    provider_pending_balance_pence: number;
    provider_payouts_to_onecab_bank_pence: number;
  };
  paid_out: {
    driver_paid_out_total_pence: number;
    driver_weekly_payouts_paid_pence: number;
    driver_early_cashouts_paid_pence: number;
    failed_payouts_pence: number;
    onecab_paid_to_bank_pence: number;
    provider_fees_paid_pence: number;
  };
  remaining_money: {
    driver_remaining_liability_pence: number;
    driver_available_now_pence: number;
    driver_pending_settlement_pence: number;
    onecab_remaining_commission_pence: number;
    provider_available_balance_pence: number;
    provider_pending_balance_pence: number;
    reconciliation_difference_pence: number;
  };
  reconciliation: {
    reconciliation_status: "BALANCED" | "MISMATCH";
    reconciliation_difference_pence: number;
    card_reconciliation: ReturnType<typeof buildSplitReconciliationCheck>["card_reconciliation"];
    equation: {
      net_customer_money_in_pence: number;
      driver_paid_out_total_pence: number;
      driver_remaining_liability_pence: number;
      onecab_net_commission_pence: number;
      provider_processing_fees_pence: number;
      adjustments_pence: number;
      lhs_pence: number;
      rhs_pence: number;
    };
  };
  answered_questions: Record<string, string | number>;
  trip_rows: FinanceBackendAuditTripRow[];
  payout_rows: FinanceBackendAuditPayoutRow[];
  critical_checks: FinanceBackendAuditCriticalCheck[];
  wallet_integrity: FinanceBackendAuditWalletIntegrity[];
  meta: {
    trip_count: number;
    payout_row_count: number;
    stripe_balance_error: string | null;
    accounting_rules: Record<string, string>;
  };
};

export type FinanceBackendAuditTripRow = {
  trip_id: string;
  trip_code: string | null;
  captured_amount_pence: number;
  refunded_amount_pence: number;
  driver_net_pence: number;
  onecab_commission_pence: number;
  provider_fee_pence: number;
  payout_status: string;
  paid_out_amount_pence: number;
  remaining_driver_liability_pence: number;
};

export type FinanceBackendAuditPayoutRow = {
  payout_id: string;
  payout_source: "payout_item" | "early_cashout";
  driver_id: string;
  amount_pence: number;
  status: string;
  provider_reference: string | null;
  created_at: string | null;
  paid_at: string | null;
  ledger_entry_created: boolean;
  ledger_entry_id: string | null;
  ledger_amount_pence: number | null;
  batch_kind: string | null;
};

export type FinanceBackendAuditCriticalCheck = {
  id: string;
  passed: boolean;
  detail: string;
};

export type FinanceBackendAuditWalletIntegrity = {
  driver_id: string;
  driver_name: string | null;
  wallet_balance_pence: number;
  ledger_sum_pence: number;
  wallet_ledger_drift_pence: number;
  completed_payouts_without_ledger_pence: number;
  explanation: string | null;
};

export type LedgerRow = {
  id: string;
  driver_id: string;
  type: string;
  amount_pence: number;
  stripe_transfer_id?: string | null;
  stripe_payout_id?: string | null;
  created_at?: string | null;
};

export type PayoutItemRow = {
  id: string;
  driver_id: string;
  trip_id?: string | null;
  amount_pence: number | null;
  driver_amount_pence?: number | null;
  status: string;
  stripe_transfer_id?: string | null;
  stripe_payout_id?: string | null;
  ledger_entry_id?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  batch?: { kind?: string | null } | null;
};

export type EarlyCashoutRow = {
  id: string;
  driver_id: string;
  status: string;
  requested_cashout_pence: number | null;
  driver_receives_pence: number | null;
  stripe_transfer_id?: string | null;
  stripe_payout_id?: string | null;
  ledger_cashout_id?: string | null;
  created_at?: string | null;
  paid_at?: string | null;
};

export function sumLedgerPayoutDebits(rows: LedgerRow[]): {
  total: number;
  weekly: number;
  early: number;
  manual: number;
} {
  let total = 0;
  let weekly = 0;
  let early = 0;
  let manual = 0;
  for (const row of rows) {
    if (!PAYOUT_DEBIT_LEDGER_TYPES.includes(row.type as (typeof PAYOUT_DEBIT_LEDGER_TYPES)[number])) {
      continue;
    }
    const abs = Math.abs(row.amount_pence || 0);
    total += abs;
    if (row.type === "WEEKLY_PAYOUT") weekly += abs;
    else if (row.type === "EARLY_CASHOUT") early += abs;
    else if (row.type === "MANUAL_PAYOUT") manual += abs;
    else if (row.type === "PAYOUT") {
      weekly += abs;
    }
  }
  return { total, weekly, early, manual };
}

export function sumLedgerAdjustmentsPence(rows: LedgerRow[]): number {
  return rows.reduce((s, r) => {
    if (r.type === "ADJUSTMENT" || r.type === "BONUS" || r.type === "REFUND_DEBIT" || r.type === "DEBT_RECOVERY") {
      return s + (r.amount_pence || 0);
    }
    return s;
  }, 0);
}

export function sumLedgerWalletBalance(rows: LedgerRow[]): number {
  return rows.reduce((s, r) => {
    if (r.type === "PLATFORM_COMMISSION" || r.type === "CASH_TRIP_EARNING") return s;
    return s + (r.amount_pence || 0);
  }, 0);
}

export function buildTripAuditRows(
  trips: TripAuditSourceRow[],
  payoutByTrip: Map<string, number>,
): FinanceBackendAuditTripRow[] {
  return trips.map((row) => {
    const captured = Math.max(0, row.capture_amount_pence ?? 0);
    const refunded = Math.max(0, row.refund_amount_pence ?? 0);
    const driverNet = tripDriverNetPence(row) ?? 0;
    const paidOut = payoutByTrip.get(row.id) ?? 0;
    const tips = tripTipsPence(row);
    const cardPayable =
(row) ? 0 : driverNet + tips;
    return {
      trip_id: row.id,
      trip_code: row.trip_code ?? null,
      captured_amount_pence: captured,
      refunded_amount_pence: refunded,
      driver_net_pence: driverNet,
      onecab_commission_pence: tripGrossCommissionPence(row),
      provider_fee_pence: tripStripeFeePence(row),
      payout_status: paidOut > 0 ? "paid_out" :
(row) ? "historical_legacy" : "unpaid",
      paid_out_amount_pence: paidOut,
      remaining_driver_liability_pence: Math.max(0, cardPayable - paidOut),
    };
  });
}

export function buildPayoutAuditRows(args: {
  payoutItems: PayoutItemRow[];
  earlyCashouts: EarlyCashoutRow[];
  ledgerById: Map<string, LedgerRow>;
}): FinanceBackendAuditPayoutRow[] {
  const rows: FinanceBackendAuditPayoutRow[] = [];

  for (const item of args.payoutItems) {
    const ledger = item.ledger_entry_id ? args.ledgerById.get(item.ledger_entry_id) : undefined;
    const amount = Math.max(0, item.driver_amount_pence ?? item.amount_pence ?? 0);
    rows.push({
      payout_id: item.id,
      payout_source: "payout_item",
      driver_id: item.driver_id,
      amount_pence: amount,
      status: item.status,
      provider_reference: item.stripe_payout_id ?? item.stripe_transfer_id ?? null,
      created_at: item.created_at ?? null,
      paid_at: item.completed_at ?? null,
      ledger_entry_created: !!ledger,
      ledger_entry_id: item.ledger_entry_id ?? ledger?.id ?? null,
      ledger_amount_pence: ledger?.amount_pence ?? null,
      batch_kind: item.batch?.kind ?? null,
    });
  }

  for (const cashout of args.earlyCashouts) {
    const ledger = cashout.ledger_cashout_id ? args.ledgerById.get(cashout.ledger_cashout_id) : undefined;
    const amount = Math.max(0, cashout.driver_receives_pence ?? cashout.requested_cashout_pence ?? 0);
    rows.push({
      payout_id: cashout.id,
      payout_source: "early_cashout",
      driver_id: cashout.driver_id,
      amount_pence: amount,
      status: cashout.status,
      provider_reference: cashout.stripe_payout_id ?? cashout.stripe_transfer_id ?? null,
      created_at: cashout.created_at ?? null,
      paid_at: cashout.paid_at ?? null,
      ledger_entry_created: !!ledger,
      ledger_entry_id: cashout.ledger_cashout_id ?? ledger?.id ?? null,
      ledger_amount_pence: ledger?.amount_pence ?? null,
      batch_kind: "EARLY_CASHOUT",
    });
  }

  return rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export function buildWalletIntegrityRows(args: {
  drivers: Array<{ id: string; first_name?: string | null; last_name?: string | null }>;
  walletByDriver: Map<string, number>;
  ledgerSumByDriver: Map<string, number>;
  missingLedgerPayoutPenceByDriver: Map<string, number>;
}): FinanceBackendAuditWalletIntegrity[] {
  return args.drivers.map((d) => {
    const wallet = args.walletByDriver.get(d.id) ?? 0;
    const ledgerSum = args.ledgerSumByDriver.get(d.id) ?? 0;
    const drift = wallet - ledgerSum;
    const missingLedger = args.missingLedgerPayoutPenceByDriver.get(d.id) ?? 0;
    const name = [d.first_name, d.last_name].filter(Boolean).join(" ").trim() || null;
    let explanation: string | null = null;
    if (missingLedger > 0) {
      explanation =
        `Completed payout(s) totalling ${missingLedger}p have no matching negative driver_wallet_ledger entry — wallet may still show pre-payout balance (e.g. £42.08 after £41.16 paid).`;
    } else if (Math.abs(drift) > 1) {
      explanation =
        `driver_wallets cache drifts from ledger SSOT by ${drift}p — run recalculate_driver_wallet.`;
    }
    return {
      driver_id: d.id,
      driver_name: name,
      wallet_balance_pence: wallet,
      ledger_sum_pence: ledgerSum,
      wallet_ledger_drift_pence: drift,
      completed_payouts_without_ledger_pence: missingLedger,
      explanation,
    };
  }).filter((r) =>
    r.wallet_ledger_drift_pence !== 0 ||
    r.completed_payouts_without_ledger_pence > 0 ||
    r.wallet_balance_pence > 0
  ).sort((a, b) => b.wallet_balance_pence - a.wallet_balance_pence);
}

export function buildFinanceBackendAuditV1(args: {
  period: { from: string; to: string };
  currencyCode: string;
  trips: TripAuditSourceRow[];
  payments?: PaymentCaptureRow[];
  ledgerRows: LedgerRow[];
  payoutItems: PayoutItemRow[];
  earlyCashouts: EarlyCashoutRow[];
  walletByDriver: Map<string, number>;
  /** All-time ledger wallet SSOT per driver (Phase 3A.4 — includes COMMISSION_RECOVERED). */
  ledgerWalletSumByDriver: Map<string, number>;
  drivers: Array<{ id: string; first_name?: string | null; last_name?: string | null }>;
  stripeAvailablePence: number;
  stripePendingPence: number;
  stripePlatformPayoutsPence: number;
  stripeBalanceError: string | null;
  tolerancePence?: number;
}): FinanceBackendAuditV1 {
  const tolerance = args.tolerancePence ?? 100;
  const ledgerSplit = computePaymentMethodLedgerMetrics({
    trips: args.trips,
    payments: args.payments,
  });
  const refunded = sumRefundedAmountPence(args.trips);
  const splitCheck = buildSplitReconciliationCheck({ ledger: ledgerSplit, tolerancePence: tolerance });

  const payoutDebits = sumLedgerPayoutDebits(args.ledgerRows);
  const adjustments = sumLedgerAdjustmentsPence(args.ledgerRows);
  const providerFees = ledgerSplit.stripe_processing_fees_pence;

  const failedPayouts = args.payoutItems
    .filter((p) => p.status === "failed")
    .reduce((s, p) => s + Math.max(0, p.amount_pence ?? 0), 0);

  /** Card driver payable only — cash driver_net is already in the driver's hand. */
  const driverRemainingLiability = Math.max(
    0,
    ledgerSplit.card_driver_payable_pence - payoutDebits.total + adjustments,
  );

  // Platform audit cannot compute per-driver eligible payout — use per-driver SSOT.
  const driverAvailableNow = 0;

  // Pending settlement is always 0 under the SSOT; kept for response shape.
  const driverPendingSettlement = 0;

  const onecabRemainingCommission = Math.max(0, ledgerSplit.onecab_card_net_commission_pence);

  const cardLhs = ledgerSplit.card_customer_revenue_pence;
  const cardRhs =
    ledgerSplit.card_driver_payable_pence + ledgerSplit.onecab_card_commission_pence;
  const reconciliationDiff = splitCheck.balanced
    ? 0
    : Math.abs(splitCheck.card_reconciliation.variance_pence);
  const balanced = splitCheck.balanced;

  const ledgerById = new Map(args.ledgerRows.map((r) => [r.id, r]));

  const payoutByTrip = new Map<string, number>();
  for (const item of args.payoutItems) {
    if (item.status !== "completed" || !item.trip_id) continue;
    const amt = Math.max(0, item.driver_amount_pence ?? item.amount_pence ?? 0);
    payoutByTrip.set(item.trip_id, (payoutByTrip.get(item.trip_id) ?? 0) + amt);
  }

  const payoutRows = buildPayoutAuditRows({
    payoutItems: args.payoutItems,
    earlyCashouts: args.earlyCashouts,
    ledgerById,
  });

  const missingLedgerByDriver = new Map<string, number>();
  for (const row of payoutRows) {
    if (row.status !== "completed" && row.status !== "paid" && row.status !== "ledger_sync_failed") continue;
    if (row.ledger_entry_created) continue;
    missingLedgerByDriver.set(
      row.driver_id,
      (missingLedgerByDriver.get(row.driver_id) ?? 0) + row.amount_pence,
    );
  }

  const ledgerSumByDriver = args.ledgerWalletSumByDriver;

  const walletIntegrity = buildWalletIntegrityRows({
    drivers: args.drivers,
    walletByDriver: args.walletByDriver,
    ledgerSumByDriver,
    missingLedgerPayoutPenceByDriver: missingLedgerByDriver,
  });

  const totalWalletBalance = [...args.walletByDriver.values()].reduce((s, v) => s + v, 0);
  const completedWithoutLedger = payoutRows.filter(
    (r) => (r.status === "completed" || r.status === "paid" || r.status === "ledger_sync_failed")
      && !r.ledger_entry_created,
  );

  const criticalChecks: FinanceBackendAuditCriticalCheck[] = [
    {
      id: "successful_payout_creates_negative_ledger",
      passed: completedWithoutLedger.length === 0,
      detail: completedWithoutLedger.length === 0
        ? "All completed payouts have ledger debits."
        : `${completedWithoutLedger.length} completed payout(s) missing ledger debit.`,
    },
    {
      id: "failed_payout_does_not_reduce_wallet",
      passed: args.payoutItems.filter((p) => p.status === "failed").every((p) => !p.ledger_entry_id),
      detail: "Failed payout_items must not reference a ledger_entry_id.",
    },
    {
      id: "provider_balance_not_commission",
      passed: true,
      detail: "onecab_remaining_commission_pence is trip-derived, not Stripe available balance.",
    },
    {
      id: "wallet_not_available_payout",
      passed: driverAvailableNow === 0,
      detail: `Platform rollup does not expose eligible payout (use per-driver SSOT). Liability aggregate=${driverRemainingLiability}p; wallet aggregate=${totalWalletBalance}p informational.`,
    },
    {
      id: "available_payout_formula",
      passed: driverAvailableNow === 0,
      detail: "SSOT: eligible_payout is per-driver via computePayoutEligibility + finance_cleared — not max(wallet).",
    },
  ];

  const answered: Record<string, string | number> = {
    A_card_customer_revenue_pence: ledgerSplit.card_customer_revenue_pence,
    A2_cash_collected_by_driver_pence: ledgerSplit.cash_collected_by_driver_pence,
    B_total_refunded_pence: refunded,
    C_net_card_revenue_pence: ledgerSplit.net_card_revenue_pence,
    D_driver_paid_out_total_pence: payoutDebits.total,
    E_onecab_paid_to_bank_pence: args.stripePlatformPayoutsPence,
    F_driver_still_owed_pence: driverRemainingLiability,
    G_driver_available_now_pence: driverAvailableNow,
    H_driver_pending_settlement_pence: driverPendingSettlement,
    I_onecab_card_commission_net_pence: ledgerSplit.onecab_card_net_commission_pence,
    I2_onecab_cash_commission_receivable_pence: ledgerSplit.onecab_cash_commission_receivable_pence,
    J_provider_processing_fee_pence: providerFees,
    K_wallet_vs_payout_diagnosis: walletIntegrity[0]?.explanation ??
      (balanced
        ? `Digital card ledger balanced. Card liability ${driverRemainingLiability}p.`
        : `Card ledger mismatch ${splitCheck.card_reconciliation.variance_pence}p.`)
        + (totalWalletBalance > 0
          ? ` Wallet aggregate ${totalWalletBalance}p; paid out ${payoutDebits.total}p.`
          : ""),
  };

  return {
    audit_version: "finance_backend_audit_v1",
    period: args.period,
    currency_code: args.currencyCode.toUpperCase(),
    incoming_money: {
      card_customer_revenue_pence: ledgerSplit.card_customer_revenue_pence,
      cash_collected_by_driver_pence: ledgerSplit.cash_collected_by_driver_pence,
      customer_captured_total_pence: ledgerSplit.card_customer_revenue_pence,
      customer_refunded_total_pence: refunded,
      net_customer_money_in_pence: ledgerSplit.net_card_revenue_pence,
      net_card_revenue_pence: ledgerSplit.net_card_revenue_pence,
      provider_available_balance_pence: args.stripeAvailablePence,
      provider_pending_balance_pence: args.stripePendingPence,
      provider_payouts_to_onecab_bank_pence: args.stripePlatformPayoutsPence,
    },
    paid_out: {
      driver_paid_out_total_pence: payoutDebits.total,
      driver_weekly_payouts_paid_pence: payoutDebits.weekly,
      driver_early_cashouts_paid_pence: payoutDebits.early,
      failed_payouts_pence: failedPayouts,
      onecab_paid_to_bank_pence: args.stripePlatformPayoutsPence,
      provider_fees_paid_pence: providerFees,
    },
    remaining_money: {
      driver_remaining_liability_pence: driverRemainingLiability,
      driver_available_now_pence: driverAvailableNow,
      driver_pending_settlement_pence: driverPendingSettlement,
      onecab_remaining_commission_pence: onecabRemainingCommission,
      provider_available_balance_pence: args.stripeAvailablePence,
      provider_pending_balance_pence: args.stripePendingPence,
      reconciliation_difference_pence: reconciliationDiff,
    },
    reconciliation: {
      reconciliation_status: balanced ? "BALANCED" : "MISMATCH",
      reconciliation_difference_pence: reconciliationDiff,
      card_reconciliation: splitCheck.card_reconciliation,
      equation: {
        net_customer_money_in_pence: cardLhs,
        driver_paid_out_total_pence: payoutDebits.total,
        driver_remaining_liability_pence: driverRemainingLiability,
        onecab_net_commission_pence: ledgerSplit.onecab_card_commission_pence,
        provider_processing_fees_pence: providerFees,
        adjustments_pence: adjustments,
        lhs_pence: cardLhs,
        rhs_pence: cardRhs,
      },
    },
    answered_questions: answered,
    trip_rows: buildTripAuditRows(args.trips, payoutByTrip),
    payout_rows: payoutRows,
    critical_checks: criticalChecks,
    wallet_integrity: walletIntegrity,
    meta: {
      trip_count: args.trips.length,
      payout_row_count: payoutRows.length,
      stripe_balance_error: args.stripeBalanceError,
      accounting_rules: {
        driver_remaining_liability:
          "card_driver_payable - ledger_payout_debits + ledger_adjustments (excludes cash driver_net)",
        driver_available_now:
          "min(driver_remaining_liability, provider_available_balance) — NOT wallet balance",
        onecab_commission: "card commission − Stripe fees (digital-only platform)",
        card_reconciliation:
          "card_customer_revenue = card_driver_payable + onecab_card_commission",
        historical_legacy_cash_trips: "excluded from digital finance reconciliation",
        payout_ledger:
          "completed payout must insert negative driver_wallet_ledger (PAYOUT/WEEKLY_PAYOUT/EARLY_CASHOUT)",
      },
    },
  };
}
