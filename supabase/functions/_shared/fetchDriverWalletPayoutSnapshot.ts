/**
 * Fetch per-driver wallet/payout snapshot from distinct SSOT sources (server I/O).
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type Stripe from "https://esm.sh/stripe@14.21.0";
import { computeLedgerWalletBalancePence, computeCashCommissionOutstanding } from "./onecabFinanceLedger.ts";
import {
  computeDriverWalletPayoutSnapshot,
  sumIncludedInPayoutBatchPence,
  sumStripePaidOutFromConnectPayouts,
  type DriverWalletPayoutSnapshot,
} from "./driverWalletPayoutSSOT.ts";
import { sumClearedSettlementBatchPence, type EarningSettlementInput } from "./payoutEligibilitySSOT.ts";
import { readConnectPayoutSnapshot, listInFlightConnectPayouts } from "./connectPayoutLockdown.ts";
import {
  buildDriverWalletPeriodKpis,
  type DriverWalletPeriodKpis,
} from "./driverWalletPeriodKpisSSOT.ts";

const TERMINAL_FAILED = new Set(["failed", "ledger_sync_failed", "failed_duplicate"]);
const STUCK_SETTLEMENT = new Set(["PROCESSING", "READY", "PENDING", "AVAILABLE"]);

export type DriverWalletPayoutDetail = DriverWalletPayoutSnapshot & {
  driver_id: string;
  user_id: string | null;
  driver_code: string | null;
  driver_name: string | null;
  connected_account_id: string | null;
  verification_status: string | null;
  bank_account_last4: string | null;
  payouts_enabled: boolean | null;
  last_payout_at: string | null;
  last_payout_amount_pence: number | null;
  payout_items: Array<Record<string, unknown>>;
  early_cashouts: Array<Record<string, unknown>>;
  stripe_connect_payouts: Array<Record<string, unknown>>;
  settlements: Array<Record<string, unknown>>;
  ledger_rows: Array<Record<string, unknown>>;
  transfer_ledger_rows: Array<Record<string, unknown>>;
  last_synced_at: string | null;
  period_kpis: DriverWalletPeriodKpis;
};

export async function fetchDriverWalletPayoutSnapshot(
  supabase: SupabaseClient,
  args: {
    driverId: string;
    stripe?: Stripe | null;
    currency?: string;
  },
): Promise<DriverWalletPayoutDetail> {
  const currency = (args.currency ?? "gbp").toLowerCase();
  const syncedAt = new Date().toISOString();

  const { data: driver } = await supabase
    .from("drivers")
    .select("id, user_id, driver_code, first_name, last_name, stripe_account_id, payouts_enabled, charges_enabled, onboarding_complete, region_id")
    .eq("id", args.driverId)
    .maybeSingle();

  const [
    fullLedgerRes,
    recentLedgerRes,
    transferLedgerRes,
    settlementsRes,
    payoutItemsRes,
    stripePayoutsRes,
    earlyCashoutsRes,
  ] = await Promise.all([
    supabase.from("driver_wallet_ledger").select("type, amount_pence, stripe_payout_id, created_at, related_trip_id")
      .eq("driver_id", args.driverId),
    supabase.from("driver_wallet_ledger").select("id, type, amount_pence, related_trip_id, stripe_payout_id, stripe_transfer_id, created_at, description")
      .eq("driver_id", args.driverId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("driver_wallet_ledger").select("id, type, amount_pence, related_trip_id, stripe_payout_id, stripe_transfer_id, created_at")
      .eq("driver_id", args.driverId)
      .not("stripe_transfer_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("driver_earning_settlement")
      .select("id, trip_id, settlement_status, settlement_lifecycle_status, allocated_to_payout, allocated_amount_pence, paid_in_payout_item_id, paid_in_batch_id, driver_wallet_ledger!inner(amount_pence)")
      .eq("driver_id", args.driverId),
    supabase.from("payout_items")
      .select("id, batch_id, status, settlement_status, net_driver_payout_pence, amount_pence, stripe_transfer_id, stripe_payout_id, failure_reason, created_at, updated_at")
      .eq("driver_id", args.driverId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("stripe_connect_payouts")
      .select("*")
      .eq("driver_id", args.driverId)
      .order("initiated_at", { ascending: false })
      .limit(50),
    supabase.from("driver_early_cashouts")
      .select("id, status, requested_cashout_pence, early_cashout_fee_pence, driver_receives_pence, created_at, updated_at, paid_at, stripe_payout_id, failure_reason")
      .eq("driver_id", args.driverId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const ledger = fullLedgerRes.data ?? [];
  const recentLedger = recentLedgerRes.data ?? [];
  const transferLedger = transferLedgerRes.data ?? [];
  const walletBalance = computeLedgerWalletBalancePence(ledger);
  const recoveryDebt = computeCashCommissionOutstanding(ledger);

  const settlements = settlementsRes.data ?? [];
  const settlementTripIds = [...new Set(
    settlements.map((s) => String(s.trip_id ?? "")).filter(Boolean),
  )];
  const tripCaptureById = new Map<string, {
    capture_amount_pence: number | null;
    payment_status: string | null;
    final_customer_fare_pence: number | null;
    payment_method: string | null;
  }>();
  if (settlementTripIds.length > 0) {
    const { data: tripRows } = await supabase
      .from("trips")
      .select("id, capture_amount_pence, payment_status, final_customer_fare_pence, payment_method")
      .in("id", settlementTripIds);
    for (const t of tripRows ?? []) {
      tripCaptureById.set(String(t.id), {
        capture_amount_pence: t.capture_amount_pence == null ? null : Number(t.capture_amount_pence),
        payment_status: (t.payment_status as string | null) ?? null,
        final_customer_fare_pence: t.final_customer_fare_pence == null
          ? null
          : Number(t.final_customer_fare_pence),
        payment_method: (t.payment_method as string | null) ?? null,
      });
    }
  }

  const earningInputs: EarningSettlementInput[] = settlements.map((s) => {
    const ledgerJoin = s.driver_wallet_ledger as { amount_pence?: number } | { amount_pence?: number }[] | null;
    const ledgerAmt = Array.isArray(ledgerJoin)
      ? Number(ledgerJoin[0]?.amount_pence ?? 0)
      : Number(ledgerJoin?.amount_pence ?? 0);
    const trip = tripCaptureById.get(String(s.trip_id ?? ""));
    const capturedAmt = trip?.capture_amount_pence ?? null;
    const captureOk = capturedAmt != null && Number.isFinite(capturedAmt) && capturedAmt > 0;
    return {
      amount_pence: Math.max(0, ledgerAmt),
      settlement_status: s.settlement_status === "settled" ? "settled" : s.settlement_status === "failed" ? "failed" : "pending",
      paid_in_batch_id: s.paid_in_batch_id as string | null,
      allocated_to_payout: s.allocated_to_payout === true,
      allocated_amount_pence: Number(s.allocated_amount_pence ?? 0),
      trip_completed: true,
      payment_captured: captureOk,
      captured_amount_pence: capturedAmt,
      required_customer_fare_pence: trip?.final_customer_fare_pence ?? null,
      capture_mismatch_unresolved: !captureOk,
      payment_method: trip?.payment_method ?? "card",
    };
  });
  const financeCleared = sumClearedSettlementBatchPence(earningInputs);

  const payoutItems = payoutItemsRes.data ?? [];
  const includedBatch = sumIncludedInPayoutBatchPence(payoutItems);

  const stripePayouts = stripePayoutsRes.data ?? [];
  const stripePaidOut = sumStripePaidOutFromConnectPayouts(stripePayouts);

  const earlyCashouts = earlyCashoutsRes.data ?? [];
  const inFlight = earlyCashouts
    .filter((r) => ["pending", "processing", "transfer_created"].includes(String(r.status ?? "").toLowerCase()))
    .reduce((s, r) => s + Math.max(0, Number(r.requested_cashout_pence ?? 0)), 0);

  let connectAvailable: number | null = null;
  let connectPending: number | null = null;
  let connectInstant: number | null = null;
  let connectInTransit: number | null = null;
  if (args.stripe && driver?.stripe_account_id) {
    try {
      const snap = await readConnectPayoutSnapshot(args.stripe, driver.stripe_account_id, currency);
      connectAvailable = snap.available_pence;
      connectPending = snap.pending_pence;
      connectInstant = snap.instant_available_pence;
      const inFlightPayouts = await listInFlightConnectPayouts(args.stripe, driver.stripe_account_id);
      connectInTransit = inFlightPayouts
        .filter((p) => p.status === "in_transit")
        .reduce((s, p) => s + Math.max(0, p.amount_pence), 0);
    } catch {
      // Stripe read failed — leave null
    }
  }

  const stripePayoutIds = new Set(
    stripePayouts.map((r) => String(r.payout_id ?? "")).filter(Boolean),
  );
  const ledgerStripePayoutIds = new Set(
    ledger.filter((r) => r.stripe_payout_id).map((r) => String(r.stripe_payout_id)),
  );

  let stripeWithoutLedger = 0;
  for (const sp of stripePayouts) {
    const pid = String(sp.payout_id ?? "");
    if (pid && !ledgerStripePayoutIds.has(pid) && String(sp.status).toLowerCase() === "paid") {
      stripeWithoutLedger += Math.max(0, Number(sp.amount_pence ?? 0));
    }
  }

  let ledgerWithoutStripe = 0;
  for (const row of ledger) {
    const pid = row.stripe_payout_id ? String(row.stripe_payout_id) : "";
    if (pid && !stripePayoutIds.has(pid) && (row.amount_pence ?? 0) < 0) {
      ledgerWithoutStripe += Math.abs(row.amount_pence ?? 0);
    }
  }

  let localFailed = 0;
  let stuckProcessing = 0;
  for (const item of payoutItems) {
    const st = String(item.status ?? "").toLowerCase();
    const net = Math.max(0, Number(item.net_driver_payout_pence ?? item.amount_pence ?? 0));
    const hasStripe = Boolean(item.stripe_transfer_id || item.stripe_payout_id);
    if (TERMINAL_FAILED.has(st) && !hasStripe) {
      localFailed += net;
      const ss = String(item.settlement_status ?? "");
      if (STUCK_SETTLEMENT.has(ss)) stuckProcessing += net;
    }
  }

  let providerAvailable: number | null = null;
  if (args.stripe) {
    try {
      const bal = await args.stripe.balance.retrieve();
      providerAvailable = bal.available.find((b) => b.currency === currency)?.amount ?? 0;
    } catch {
      providerAvailable = null;
    }
  }

  const snapshot = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: walletBalance,
    finance_cleared_pence: financeCleared,
    included_in_payout_batch_pence: includedBatch,
    stripe_connect_available_pence: connectAvailable,
    stripe_connect_pending_pence: connectPending,
    stripe_in_transit_pence: connectInTransit,
    stripe_connect_instant_available_pence: connectInstant,
    stripe_paid_out_total_pence: stripePaidOut,
    recovery_debt_pence: recoveryDebt,
    in_flight_cashout_pence: inFlight,
    payout_blocked: walletBalance < 0 || driver?.payouts_enabled === false,
    instant_payout_enabled_by_stripe: driver?.charges_enabled !== false,
    stripe_payout_without_ledger_debit_pence: stripeWithoutLedger,
    ledger_debit_without_stripe_payout_pence: ledgerWithoutStripe,
    local_only_failed_payout_pence: localFailed,
    failed_payout_stuck_processing_pence: stuckProcessing,
    provider_platform_available_pence: providerAvailable,
  });

  const driverName = driver
    ? `${String(driver.first_name ?? "").trim()} ${String(driver.last_name ?? "").trim()}`.trim() || null
    : null;

  const lastPaidPayout = [...stripePayouts]
    .filter((row) => {
      const st = String(row.status ?? "").toLowerCase();
      return st === "paid" || st === "in_transit" || st === "pending";
    })
    .sort((a, b) => {
      const aTs = new Date(String(a.initiated_at ?? a.arrival_date ?? 0)).getTime();
      const bTs = new Date(String(b.initiated_at ?? b.arrival_date ?? 0)).getTime();
      return bTs - aTs;
    })[0] ?? null;

  const bankLast4 = [...stripePayouts]
    .map((r) => (r.bank_last4 == null ? null : String(r.bank_last4)))
    .find((v) => v && v.length > 0) ?? null;

  let verificationStatus: string | null = null;
  if (!driver?.stripe_account_id) verificationStatus = "not_connected";
  else if (driver.payouts_enabled && driver.onboarding_complete) verificationStatus = "verified";
  else if (driver.onboarding_complete || driver.charges_enabled) verificationStatus = "restricted";
  else verificationStatus = "pending";

  const period_kpis = buildDriverWalletPeriodKpis(
    ledger.map((r) => ({
      type: String(r.type ?? ""),
      amount_pence: Number(r.amount_pence ?? 0),
      created_at: (r as { created_at?: string | null }).created_at ?? null,
      related_trip_id: (r as { related_trip_id?: string | null }).related_trip_id ?? null,
    })),
    {
      recoveryDebtPence: recoveryDebt,
      // Pending = finance-cleared not yet in a payout batch (backend SSOT fields).
      pendingEarningsPence: Math.max(0, financeCleared - includedBatch),
    },
  );

  return {
    ...snapshot,
    driver_id: args.driverId,
    user_id: (driver?.user_id as string) ?? null,
    driver_code: (driver?.driver_code as string) ?? null,
    driver_name: driverName,
    connected_account_id: (driver?.stripe_account_id as string) ?? null,
    verification_status: verificationStatus,
    bank_account_last4: bankLast4,
    payouts_enabled: driver?.payouts_enabled ?? null,
    last_payout_at: lastPaidPayout
      ? String(lastPaidPayout.initiated_at ?? lastPaidPayout.arrival_date ?? null)
      : null,
    last_payout_amount_pence: lastPaidPayout
      ? Math.max(0, Number(lastPaidPayout.amount_pence ?? 0))
      : null,
    period_kpis,
    payout_items: payoutItems,
    early_cashouts: earlyCashouts,
    stripe_connect_payouts: stripePayouts,
    settlements,
    ledger_rows: recentLedger,
    transfer_ledger_rows: transferLedger,
    last_synced_at: syncedAt,
  };
}
