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
import { sumEligibleEarningPence, type EarningSettlementInput } from "./payoutEligibilitySSOT.ts";
import { readConnectPayoutSnapshot } from "./connectPayoutLockdown.ts";

const TERMINAL_FAILED = new Set(["failed", "ledger_sync_failed", "failed_duplicate"]);
const STUCK_SETTLEMENT = new Set(["PROCESSING", "READY", "PENDING", "AVAILABLE"]);

export type DriverWalletPayoutDetail = DriverWalletPayoutSnapshot & {
  driver_id: string;
  user_id: string | null;
  driver_code: string | null;
  connected_account_id: string | null;
  payout_items: Array<Record<string, unknown>>;
  stripe_connect_payouts: Array<Record<string, unknown>>;
  settlements: Array<Record<string, unknown>>;
  last_synced_at: string | null;
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
    .select("id, user_id, driver_code, stripe_account_id")
    .eq("id", args.driverId)
    .maybeSingle();

  const [
    ledgerRes,
    settlementsRes,
    payoutItemsRes,
    stripePayoutsRes,
    earlyCashoutsRes,
  ] = await Promise.all([
    supabase.from("driver_wallet_ledger").select("type, amount_pence, stripe_payout_id")
      .eq("driver_id", args.driverId),
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
      .select("status, requested_cashout_pence")
      .eq("driver_id", args.driverId)
      .in("status", ["pending", "processing", "transfer_created"]),
  ]);

  const ledger = ledgerRes.data ?? [];
  const walletBalance = computeLedgerWalletBalancePence(ledger);
  const recoveryDebt = computeCashCommissionOutstanding(ledger);

  const settlements = settlementsRes.data ?? [];
  const earningInputs: EarningSettlementInput[] = settlements.map((s) => {
    const ledgerJoin = s.driver_wallet_ledger as { amount_pence?: number } | { amount_pence?: number }[] | null;
    const ledgerAmt = Array.isArray(ledgerJoin)
      ? Number(ledgerJoin[0]?.amount_pence ?? 0)
      : Number(ledgerJoin?.amount_pence ?? 0);
    return {
      amount_pence: Math.max(0, ledgerAmt),
      settlement_status: s.settlement_status === "settled" ? "settled" : s.settlement_status === "failed" ? "failed" : "pending",
      paid_in_batch_id: s.paid_in_batch_id as string | null,
      allocated_to_payout: s.allocated_to_payout === true,
      allocated_amount_pence: Number(s.allocated_amount_pence ?? 0),
      trip_completed: true,
      payment_captured: true,
      payment_method: "card",
    };
  });
  const financeCleared = sumEligibleEarningPence(earningInputs);

  const payoutItems = payoutItemsRes.data ?? [];
  const includedBatch = sumIncludedInPayoutBatchPence(payoutItems);

  const stripePayouts = stripePayoutsRes.data ?? [];
  const stripePaidOut = sumStripePaidOutFromConnectPayouts(stripePayouts);

  const inFlight = (earlyCashoutsRes.data ?? []).reduce(
    (s, r) => s + Math.max(0, Number(r.requested_cashout_pence ?? 0)),
    0,
  );

  let connectAvailable: number | null = null;
  let connectPending: number | null = null;
  let connectInstant: number | null = null;
  if (args.stripe && driver?.stripe_account_id) {
    try {
      const snap = await readConnectPayoutSnapshot(args.stripe, driver.stripe_account_id, currency);
      connectAvailable = snap.available_pence;
      connectPending = snap.pending_pence;
      connectInstant = snap.instant_available_pence;
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
    stripe_connect_instant_available_pence: connectInstant,
    stripe_paid_out_total_pence: stripePaidOut,
    recovery_debt_pence: recoveryDebt,
    in_flight_cashout_pence: inFlight,
    stripe_payout_without_ledger_debit_pence: stripeWithoutLedger,
    ledger_debit_without_stripe_payout_pence: ledgerWithoutStripe,
    local_only_failed_payout_pence: localFailed,
    failed_payout_stuck_processing_pence: stuckProcessing,
    provider_platform_available_pence: providerAvailable,
  });

  return {
    ...snapshot,
    driver_id: args.driverId,
    user_id: (driver?.user_id as string) ?? null,
    driver_code: (driver?.driver_code as string) ?? null,
    connected_account_id: (driver?.stripe_account_id as string) ?? null,
    payout_items: payoutItems,
    stripe_connect_payouts: stripePayouts,
    settlements,
    last_synced_at: syncedAt,
  };
}
