/**
 * Per-driver Financial Reconciliation SSOT.
 * Digital driver liability = wallet ledger balance (Phase 3A.4).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  allocateProviderBalanceByLiability,
  buildDigitalReconciliationCheck,
  classifyReconciliationVariance,
  type FinanceDataSourceBadge,
  filterDigitalTrips,
  onecabNetCommissionPence,
  PAYOUT_SOFT_WARNING_RECONCILIATION,
  perDriverLedgerLiabilityPence,
  sumAdjustmentsPence,
  sumBankPayoutPaidOutPence,
  sumDigitalNetCustomerRevenuePence,
  sumDriverGrossEarningsPence,
  sumDriverNetEarningsPence,
  sumOnecabGrossCommissionPence,
  sumProviderProcessingFeesPence,
  mergePaymentSessionsIntoCaptureRows,
  type LedgerSSOTRow,
  type PaymentCaptureRow,
  type TripSSOTRow,
} from "./financialReconciliationSSOT.ts";
import { computeLedgerWalletBalancePence } from "./onecabFinanceLedger.ts";
import { computePayoutEligibility } from "./payoutEligibilitySSOT.ts";
import { loadPayoutControlCentreSettings } from "./payoutControlCentreSettingsSSOT.ts";
import {
  computeFinanceClearedPenceFromSettlements,
  computeIncludedInPayoutBatchPence,
  type SettlementRow,
} from "./settlementFinanceSSOT.ts";
import { sumStripePaidOutFromConnectPayouts } from "./driverWalletPayoutSSOT.ts";
import {
  driverDebtPence,
  WALLET_NEGATIVE_BLOCK_REASON,
} from "./payoutAvailability.ts";

export type PerDriverSSOT = {
  driver_id: string;
  driver_gross_earnings_pence: number;
  driver_net_earnings_pence: number;
  driver_paid_out_pence: number;
  completed_early_cashouts_pence: number;
  adjustments_pence: number;
  driver_remaining_liability_pence: number;
  in_flight_cashout_pence: number;
  provider_available_balance_pence: number;
  provider_pending_balance_pence: number;
  provider_available_balance_allocated_to_driver_pence: number;
  provider_upcoming_payout_pence: number;
  /** Cleared settlements sum — NOT max(wallet_balance, 0). */
  finance_cleared_amount_pence: number;
  /** min(wallet, stripe-settled, finance-cleared) − in-flight. */
  eligible_payout_pence: number;
  included_in_payout_batch_pence: number;
  stripe_paid_out_total_pence: number;
  /** @deprecated Use eligible_payout_pence — kept for API compat. */
  driver_available_now_pence: number;
  /** Always 0 under the SSOT; kept for UI compatibility. */
  driver_pending_payout_pence: number;
  /** Signed wallet balance (can be negative when driver owes ONECAB). */
  driver_wallet_balance_pence: number;
  /** abs(min(wallet_balance, 0)). */
  driver_debt_pence: number;
  next_payout_date: string | null;
  /** Backend-formatted local next run — never browser-local. */
  next_payout_local?: string | null;
  reconciliation_status: "BALANCED" | "RECONCILIATION_MISMATCH";
  reconciliation_scope: "digital_v3";
  digital_net_customer_revenue_pence: number;
  digital_onecab_net_commission_pence: number;
  digital_provider_processing_fee_pence: number;
  reconciliation_variance_pence: number;
  source_tier: FinanceDataSourceBadge;
  ledger_sync_missing: boolean;
  payout_blocked: boolean;
  payout_blocked_reasons: string[];
  payout_warning_reasons: string[];
};

export type EarlyCashoutRow = {
  status: string;
  requested_cashout_pence: number | null;
  driver_receives_pence?: number | null;
};

const IN_FLIGHT_CASHOUT_STATUSES = new Set(["pending", "processing", "transfer_created"]);

export function sumCompletedEarlyCashoutsPence(rows: EarlyCashoutRow[]): number {
  return rows
    .filter((r) => r.status === "paid")
    .reduce((s, r) => s + Math.max(0, r.requested_cashout_pence ?? 0), 0);
}

export function sumInFlightCashoutPence(rows: EarlyCashoutRow[]): number {
  return rows
    .filter((r) => IN_FLIGHT_CASHOUT_STATUSES.has(r.status))
    .reduce((s, r) => s + Math.max(0, r.requested_cashout_pence ?? 0), 0);
}

/** Next weekly payout calendar date — re-exported from payoutScheduleSSOT. */
export { nextWeeklyPayoutDateIso, computeNextWeeklyPayoutRun, buildPayoutScheduleDto } from "./payoutScheduleSSOT.ts";

export function buildPayoutGateReasons(args: {
  reconciliationStatus: "BALANCED" | "RECONCILIATION_MISMATCH";
  reconciliationVariancePence: number;
  sourceTier: FinanceDataSourceBadge;
  regionId?: string | null;
  providerAllocatedPence: number;
  ledgerSyncMissing: boolean;
  availableNowPence: number;
  walletBalancePence: number;
  /** Revolut/manual bank payout — skip Stripe platform allocation gate. */
  manualProviderPayout?: boolean;
}): {
  payout_blocked_reasons: string[];
  payout_warning_reasons: string[];
} {
  const hard: string[] = [];
  const soft: string[] = [];

  // SSOT rule #1: wallet_balance < 0 blocks every payout path.
  if (args.walletBalancePence < 0) {
    hard.push(WALLET_NEGATIVE_BLOCK_REASON);
  }

  const varianceClass = classifyReconciliationVariance({
    reconciliationStatus: args.reconciliationStatus,
    variancePence: args.reconciliationVariancePence,
    sourceTier: args.sourceTier,
    regionId: args.regionId,
  });

  if (varianceClass === "hard_mismatch") {
    hard.push("Reconciliation mismatch — payout blocked until balanced");
  } else if (varianceClass === "soft_positive_classified") {
    soft.push(PAYOUT_SOFT_WARNING_RECONCILIATION);
  }

  if (args.sourceTier === "RECONSTRUCTED") {
    hard.push("Reconstructed data tier — live reconciliation required");
  }
  if (args.ledgerSyncMissing) {
    hard.push("Ledger sync missing after previous payout — resolve before paying out");
  }
  if (!args.manualProviderPayout && args.providerAllocatedPence <= 0) {
    hard.push("No provider balance allocated — funds awaiting settlement");
  }
  if (args.availableNowPence <= 0 && args.walletBalancePence >= 0) {
    // Only surface this when wallet is non-negative; wallet<0 already blocked above.
    hard.push("No SSOT available payout for this driver");
  }

  return { payout_blocked_reasons: hard, payout_warning_reasons: soft };
}

/** Hard payout blocks only — use buildPayoutGateReasons for soft warnings. */
export function buildPayoutBlockedReasons(args: {
  reconciliationStatus: "BALANCED" | "RECONCILIATION_MISMATCH";
  reconciliationVariancePence?: number;
  sourceTier: FinanceDataSourceBadge;
  regionId?: string | null;
  providerAllocatedPence: number;
  ledgerSyncMissing: boolean;
  availableNowPence: number;
  walletBalancePence: number;
}): string[] {
  return buildPayoutGateReasons({
    reconciliationStatus: args.reconciliationStatus,
    reconciliationVariancePence: args.reconciliationVariancePence ?? 0,
    sourceTier: args.sourceTier,
    regionId: args.regionId,
    providerAllocatedPence: args.providerAllocatedPence,
    ledgerSyncMissing: args.ledgerSyncMissing,
    availableNowPence: args.availableNowPence,
    walletBalancePence: args.walletBalancePence,
  }).payout_blocked_reasons;
}

export function computePerDriverSSOT(args: {
  driverId: string;
  regionId?: string | null;
  trips: TripSSOTRow[];
  ledger: LedgerSSOTRow[];
  earlyCashouts: EarlyCashoutRow[];
  payments: PaymentCaptureRow[];
  providerAvailableBalancePence: number;
  providerPendingBalancePence: number;
  providerAllocations: Record<string, number>;
  ledgerSyncMissing: boolean;
  sourceTier?: FinanceDataSourceBadge;
  settlements?: SettlementRow[];
  activePayoutItems?: Array<{ status: string; net_driver_payout_pence?: number | null; amount_pence?: number | null }>;
  stripeConnectPayouts?: Array<{ amount_pence?: number | null; status?: string | null }>;
  /** Wallet-ledger payout path (Revolut manual bank transfer). */
  manualProviderPayout?: boolean;
  weeklyPayoutDay?: string | null;
  payoutTimeZone?: string | null;
  localProcessingTime?: string | null;
}): PerDriverSSOT {
  const sourceTier = args.sourceTier ?? "LIVE";
  const driverGross = sumDriverGrossEarningsPence(args.trips);
  const driverNet = sumDriverNetEarningsPence(args.trips);
  const stripePaidOut = sumStripePaidOutFromConnectPayouts(args.stripeConnectPayouts ?? []);
  const bankPaidOutLedger = args.ledger
    .filter((r) => ["PAYOUT", "WEEKLY_PAYOUT", "EARLY_CASHOUT", "MANUAL_PAYOUT"].includes(String(r.type)))
    .reduce((s, r) => s + Math.abs(r.amount_pence ?? 0), 0);
  const bankPaidOut = stripePaidOut > 0 ? stripePaidOut : bankPaidOutLedger;
  const completedEarly = sumCompletedEarlyCashoutsPence(args.earlyCashouts);
  const inFlight = sumInFlightCashoutPence(args.earlyCashouts);
  const adjustments = sumAdjustmentsPence(args.ledger);
  const walletBalance = computeLedgerWalletBalancePence(args.ledger);
  const remaining = perDriverLedgerLiabilityPence(args.ledger);
  const allocated = Math.max(0, args.providerAllocations[args.driverId] ?? 0);
  const financeCleared = computeFinanceClearedPenceFromSettlements(args.settlements ?? []);
  const includedBatch = computeIncludedInPayoutBatchPence(args.activePayoutItems ?? []);
  const driverDebt = driverDebtPence(walletBalance);
  const pendingPayout = 0;

  const stripeSettledForEligibility = args.manualProviderPayout ? remaining : allocated;
  const eligibility = computePayoutEligibility({
    walletUnpaidPence: remaining,
    stripeSettledUnpaidPence: stripeSettledForEligibility,
    payoutBlocked: walletBalance < 0,
    inFlightPayoutPence: inFlight,
  });
  const eligiblePayout =
    args.manualProviderPayout
      ? eligibility.eligible_payout_pence
      : financeCleared > 0
        ? Math.min(eligibility.eligible_payout_pence, financeCleared)
        : eligibility.eligible_payout_pence;

  const digitalTrips = filterDigitalTrips(args.trips);
  const digitalNetCustomer = sumDigitalNetCustomerRevenuePence({
    payments: args.payments,
    digitalTrips: digitalTrips.map((t) => ({
      id: t.id ?? undefined,
      refund_amount_pence: t.refund_amount_pence,
    })),
  });
  const digitalOnecabGross = sumOnecabGrossCommissionPence(digitalTrips);
  const digitalProviderFees = sumProviderProcessingFeesPence(digitalTrips);
  const digitalOnecabNet = onecabNetCommissionPence(digitalOnecabGross, digitalProviderFees);
  const reconciliation = buildDigitalReconciliationCheck({
    digitalNetCustomerRevenuePence: digitalNetCustomer,
    driverWalletLiabilityPence: remaining,
    digitalOnecabNetCommissionPence: digitalOnecabNet,
    digitalProviderProcessingFeePence: digitalProviderFees,
    bankPaidOutPence: bankPaidOut,
    completedEarlyCashoutsPence: completedEarly,
  });

  const payoutGate = buildPayoutGateReasons({
    reconciliationStatus: reconciliation.status,
    reconciliationVariancePence: reconciliation.variance_pence,
    sourceTier,
    regionId: args.regionId,
    providerAllocatedPence: allocated,
    ledgerSyncMissing: args.ledgerSyncMissing,
    availableNowPence: eligiblePayout,
    walletBalancePence: walletBalance,
    manualProviderPayout: args.manualProviderPayout,
  });
  const payoutBlockedReasons = payoutGate.payout_blocked_reasons;
  const nextRun = computeNextWeeklyPayoutRun({
    weeklyPayoutDay: args.weeklyPayoutDay,
    timeZone: args.payoutTimeZone,
    localProcessingTime: args.localProcessingTime ?? "12:00",
  });

  return {
    driver_id: args.driverId,
    driver_gross_earnings_pence: driverGross,
    driver_net_earnings_pence: driverNet,
    driver_paid_out_pence: bankPaidOut,
    completed_early_cashouts_pence: completedEarly,
    adjustments_pence: adjustments,
    driver_remaining_liability_pence: remaining,
    in_flight_cashout_pence: inFlight,
    provider_available_balance_pence: args.providerAvailableBalancePence,
    provider_pending_balance_pence: args.providerPendingBalancePence,
    provider_available_balance_allocated_to_driver_pence: allocated,
    provider_upcoming_payout_pence: args.providerPendingBalancePence,
    finance_cleared_amount_pence: financeCleared,
    eligible_payout_pence: eligiblePayout,
    included_in_payout_batch_pence: includedBatch,
    stripe_paid_out_total_pence: stripePaidOut,
    driver_available_now_pence: eligiblePayout,
    driver_pending_payout_pence: pendingPayout,
    driver_wallet_balance_pence: walletBalance,
    driver_debt_pence: driverDebt,
    next_payout_date: nextRun.next_run_at_utc,
    next_payout_local: nextRun.next_run_at_local,
    reconciliation_status: reconciliation.status,
    reconciliation_scope: reconciliation.reconciliation_scope,
    digital_net_customer_revenue_pence: reconciliation.digital_net_customer_revenue_pence,
    digital_onecab_net_commission_pence: reconciliation.digital_onecab_net_commission_pence,
    digital_provider_processing_fee_pence: reconciliation.digital_provider_processing_fee_pence,
    reconciliation_variance_pence: reconciliation.variance_pence,
    source_tier: sourceTier,
    ledger_sync_missing: args.ledgerSyncMissing,
    payout_blocked: payoutBlockedReasons.length > 0,
    payout_blocked_reasons: payoutBlockedReasons,
    payout_warning_reasons: payoutGate.payout_warning_reasons,
  };
}

export async function fetchPerDriverFinancialReconciliation(
  supabase: SupabaseClient,
  args: {
    driverId: string;
    regionId?: string | null;
    periodFrom?: string | null;
    periodTo?: string | null;
    providerAvailableBalancePence: number;
    providerPendingBalancePence: number;
    sourceTier?: FinanceDataSourceBadge;
    manualProviderPayout?: boolean;
  },
): Promise<PerDriverSSOT> {
  const { driverId } = args;

  const { data: driverRow, error: driverErr } = await supabase
    .from("drivers")
    .select("id, region_id, service_area_id")
    .eq("id", driverId)
    .maybeSingle();
  if (driverErr || !driverRow) throw new Error("Driver not found");

  const regionId = args.regionId ?? driverRow.region_id ?? null;
  const serviceAreaId = (driverRow as { service_area_id?: string | null }).service_area_id ?? null;

  let peerDriverIds = [driverId];
  if (regionId) {
    const { data: peers } = await supabase
      .from("drivers")
      .select("id")
      .eq("region_id", regionId);
    peerDriverIds = (peers ?? []).map((p) => p.id as string);
    if (!peerDriverIds.includes(driverId)) peerDriverIds.push(driverId);
  }

  let tripQuery = supabase
    .from("trips")
    .select(`
      id, driver_id, payment_method,
      commission_pence, stripe_processing_fee_pence, onecab_net_pence, driver_net_pence,
      gross_fare_pence, final_fare_pence, commissionable_fare_pence, capture_amount_pence,
      refund_amount_pence, pickup_waiting_charge_pence, stop_waiting_charge_pence,
      tip_pence, tip_amount_pence, airport_charge_pence, other_pass_through_charges_pence
    `)
    .in("driver_id", peerDriverIds)
    .not("completed_at", "is", null);

  if (args.periodFrom) tripQuery = tripQuery.gte("completed_at", args.periodFrom);
  if (args.periodTo) tripQuery = tripQuery.lte("completed_at", args.periodTo);

  // Wallet balance / payout guard MUST use full lifetime ledger — never period-filtered.
  const fullLedgerQuery = supabase
    .from("driver_wallet_ledger")
    .select("type, amount_pence, driver_id")
    .in("driver_id", peerDriverIds);

  const [tripsResult, fullLedgerResult, cashoutsResult, payoutItemsResult, settlementsResult, activePayoutResult, stripePayoutsResult] = await Promise.all([
    tripQuery,
    fullLedgerQuery,
    supabase
      .from("driver_early_cashouts")
      .select("driver_id, status, requested_cashout_pence, driver_receives_pence")
      .in("driver_id", peerDriverIds),
    supabase
      .from("payout_items")
      .select("driver_id, status, ledger_entry_id, stripe_payout_id")
      .in("driver_id", peerDriverIds)
      .in("status", ["completed", "ledger_sync_failed"]),
    supabase
      .from("driver_earning_settlement")
      .select(`
        id, trip_id, settlement_status, allocated_to_payout, allocated_amount_pence,
        paid_in_batch_id, paid_in_payout_item_id,
        driver_wallet_ledger ( amount_pence )
      `)
      .eq("driver_id", driverId),
    supabase
      .from("payout_items")
      .select("status, net_driver_payout_pence, amount_pence")
      .eq("driver_id", driverId)
      .in("status", ["pending", "processing", "ready", "transfer_created"]),
    supabase
      .from("stripe_connect_payouts")
      .select("amount_pence, status")
      .eq("driver_id", driverId),
  ]);

  if (tripsResult.error) throw tripsResult.error;
  if (fullLedgerResult.error) throw fullLedgerResult.error;
  if (cashoutsResult.error) throw cashoutsResult.error;
  if (payoutItemsResult.error) throw payoutItemsResult.error;
  if (settlementsResult.error) throw settlementsResult.error;
  if (activePayoutResult.error) throw activePayoutResult.error;
  if (stripePayoutsResult.error) throw stripePayoutsResult.error;

  const allTrips = (tripsResult.data ?? []) as Array<TripSSOTRow & { driver_id?: string }>;
  const allLedger = (fullLedgerResult.data ?? []) as Array<LedgerSSOTRow & { driver_id?: string }>;
  const allCashouts = (cashoutsResult.data ?? []) as Array<EarlyCashoutRow & { driver_id?: string }>;

  const tripIds = allTrips.map((t) => (t as { id?: string }).id).filter(Boolean) as string[];
  let paymentRows: PaymentCaptureRow[] = [];
  if (tripIds.length > 0) {
    const [paymentsRes, sessionsRes] = await Promise.all([
      supabase
        .from("payments")
        .select("captured_amount_pence, status, trip_id")
        .in("trip_id", tripIds),
      supabase
        .from("payment_sessions")
        .select("trip_id, captured_amount_pence, status")
        .in("trip_id", tripIds)
        .not("captured_amount_pence", "is", null),
    ]);
    paymentRows = mergePaymentSessionsIntoCaptureRows({
      paymentSessions: sessionsRes.data ?? [],
    }).rows;
  }

  const liabilities: Record<string, number> = {};
  for (const peerId of peerDriverIds) {
    const peerLedger = allLedger.filter((l) => l.driver_id === peerId);
    liabilities[peerId] = perDriverLedgerLiabilityPence(peerLedger);
  }

  const allocations = allocateProviderBalanceByLiability({
    providerAvailableBalancePence: args.providerAvailableBalancePence,
    driverLiabilities: liabilities,
  });

  const driverTrips = allTrips.filter((t) => t.driver_id === driverId);
  const driverLedger = allLedger.filter((l) => l.driver_id === driverId);
  const driverCashouts = allCashouts.filter((c) => c.driver_id === driverId);
  const driverTripIds = new Set(driverTrips.map((t) => (t as { id?: string }).id));
  const driverPayments = paymentRows.filter((p) => p.trip_id && driverTripIds.has(p.trip_id));

  const ledgerSyncMissing = (payoutItemsResult.data ?? []).some(
    (item) =>
      item.driver_id === driverId &&
      (item.status === "ledger_sync_failed" ||
        (item.status === "completed" && !item.ledger_entry_id && !!item.stripe_payout_id)),
  );

  const controlCentre = await loadPayoutControlCentreSettings(supabase, {
    serviceAreaId,
  });

  return computePerDriverSSOT({
    driverId,
    regionId,
    trips: driverTrips,
    ledger: driverLedger,
    earlyCashouts: driverCashouts,
    payments: driverPayments,
    providerAvailableBalancePence: args.providerAvailableBalancePence,
    providerPendingBalancePence: args.providerPendingBalancePence,
    providerAllocations: allocations,
    ledgerSyncMissing,
    sourceTier: args.sourceTier,
    settlements: (settlementsResult.data ?? []) as SettlementRow[],
    activePayoutItems: activePayoutResult.data ?? [],
    stripeConnectPayouts: stripePayoutsResult.data ?? [],
    manualProviderPayout: args.manualProviderPayout,
    weeklyPayoutDay: controlCentre.weekly_payout_day,
    payoutTimeZone: controlCentre.payout_timezone,
    localProcessingTime: controlCentre.payout_processing_time,
  });
}
