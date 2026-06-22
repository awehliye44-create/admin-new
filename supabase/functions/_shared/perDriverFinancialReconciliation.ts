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
  type LedgerSSOTRow,
  type PaymentCaptureRow,
  type TripSSOTRow,
} from "./financialReconciliationSSOT.ts";
import { computeLedgerWalletBalancePence } from "./onecabFinanceLedger.ts";
import {
  availablePayoutPence,
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
  /** SSOT: max(wallet_balance, 0). */
  driver_available_now_pence: number;
  /** Always 0 under the SSOT; kept for UI compatibility. */
  driver_pending_payout_pence: number;
  /** Signed wallet balance (can be negative when driver owes ONECAB). */
  driver_wallet_balance_pence: number;
  /** abs(min(wallet_balance, 0)). */
  driver_debt_pence: number;
  next_payout_date: string | null;
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

export function nextWeeklyPayoutDateIso(): string {
  const now = new Date();
  const london = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const day = london.getDay();
  const daysUntilWednesday = (3 - day + 7) % 7 || 7;
  london.setDate(london.getDate() + daysUntilWednesday);
  london.setHours(0, 0, 0, 0);
  return london.toISOString();
}

export function buildPayoutGateReasons(args: {
  reconciliationStatus: "BALANCED" | "RECONCILIATION_MISMATCH";
  reconciliationVariancePence: number;
  sourceTier: FinanceDataSourceBadge;
  regionId?: string | null;
  providerAllocatedPence: number;
  ledgerSyncMissing: boolean;
  availableNowPence: number;
  walletBalancePence: number;
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
  if (args.providerAllocatedPence <= 0) {
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
}): PerDriverSSOT {
  const sourceTier = args.sourceTier ?? "LIVE";
  const driverGross = sumDriverGrossEarningsPence(args.trips);
  const driverNet = sumDriverNetEarningsPence(args.trips);
  const bankPaidOut = sumBankPayoutPaidOutPence(args.ledger);
  const completedEarly = sumCompletedEarlyCashoutsPence(args.earlyCashouts);
  const inFlight = sumInFlightCashoutPence(args.earlyCashouts);
  const adjustments = sumAdjustmentsPence(args.ledger);
  const remaining = perDriverLedgerLiabilityPence(args.ledger);
  const allocated = Math.max(0, args.providerAllocations[args.driverId] ?? 0);
  const availableNow = perDriverAvailableNowPence({
    driverRemainingLiabilityPence: remaining,
    providerAllocatedBalancePence: allocated,
    inFlightCashoutPence: inFlight,
  });
  const pendingPayout = Math.max(0, remaining - availableNow);

  const digitalTrips = filterDigitalTrips(args.trips);
  const digitalNetCustomer = sumDigitalNetCustomerRevenuePence({
    payments: args.payments,
    digitalTrips,
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
    availableNowPence: availableNow,
  });
  const payoutBlockedReasons = payoutGate.payout_blocked_reasons;

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
    driver_available_now_pence: availableNow,
    driver_pending_payout_pence: pendingPayout,
    next_payout_date: nextWeeklyPayoutDateIso(),
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
  },
): Promise<PerDriverSSOT> {
  const { driverId } = args;

  const { data: driverRow, error: driverErr } = await supabase
    .from("drivers")
    .select("id, region_id")
    .eq("id", driverId)
    .maybeSingle();
  if (driverErr || !driverRow) throw new Error("Driver not found");

  const regionId = args.regionId ?? driverRow.region_id ?? null;

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

  let ledgerQuery = supabase
    .from("driver_wallet_ledger")
    .select("type, amount_pence, driver_id")
    .in("driver_id", peerDriverIds);

  if (args.periodFrom) ledgerQuery = ledgerQuery.gte("created_at", args.periodFrom);
  if (args.periodTo) ledgerQuery = ledgerQuery.lte("created_at", args.periodTo);

  const [tripsResult, ledgerResult, cashoutsResult, payoutItemsResult] = await Promise.all([
    tripQuery,
    ledgerQuery,
    supabase
      .from("driver_early_cashouts")
      .select("driver_id, status, requested_cashout_pence, driver_receives_pence")
      .in("driver_id", peerDriverIds),
    supabase
      .from("payout_items")
      .select("driver_id, status, ledger_entry_id, stripe_payout_id")
      .in("driver_id", peerDriverIds)
      .in("status", ["completed", "ledger_sync_failed"]),
  ]);

  if (tripsResult.error) throw tripsResult.error;
  if (ledgerResult.error) throw ledgerResult.error;
  if (cashoutsResult.error) throw cashoutsResult.error;
  if (payoutItemsResult.error) throw payoutItemsResult.error;

  const allTrips = (tripsResult.data ?? []) as Array<TripSSOTRow & { driver_id?: string }>;
  const allLedger = (ledgerResult.data ?? []) as Array<LedgerSSOTRow & { driver_id?: string }>;
  const allCashouts = (cashoutsResult.data ?? []) as Array<EarlyCashoutRow & { driver_id?: string }>;

  const tripIds = allTrips.map((t) => (t as { id?: string }).id).filter(Boolean) as string[];
  let paymentRows: PaymentCaptureRow[] = [];
  if (tripIds.length > 0) {
    const { data: payments } = await supabase
      .from("payments")
      .select("captured_amount_pence, status, trip_id")
      .in("trip_id", tripIds);
    paymentRows = payments ?? [];
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
  });
}
