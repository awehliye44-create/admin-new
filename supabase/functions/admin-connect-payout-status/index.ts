import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import {
  listInFlightConnectPayouts,
  readConnectPayoutSnapshot,
} from "../_shared/connectPayoutLockdown.ts";
import { fetchPerDriverFinancialReconciliation } from "../_shared/perDriverFinancialReconciliation.ts";
import {
  evaluateConnectManualPayoutGate,
} from "../_shared/connectManualPayout.ts";
import {
  computeConnectAwaitingSettlementPence,
  computeDriverCashoutExecutablePence,
} from "../_shared/driverWalletSettlementSSOT.ts";

const MIN_CASHOUT_AMOUNT_PENCE = 500;

const TRIP_EARNING_LEDGER_TYPES = new Set([
  "TRIP_EARNING_NET",
  "DRIVER_TIP_CREDIT",
  "CASH_TRIP_EARNING",
]);
const DEBT_RECOVERY_LEDGER_TYPES = new Set([
  "DEBT_RECOVERY",
  "CASH_COMMISSION_DEBT",
]);
const ADJUSTMENT_LEDGER_TYPES = new Set([
  "ADJUSTMENT",
  "MANUAL_ADJUSTMENT",
  "BONUS",
  "CHARGEBACK_DEBIT",
]);
const PAYOUT_LEDGER_TYPES = new Set([
  "WEEKLY_PAYOUT",
  "EARLY_CASHOUT",
  "MANUAL_PAYOUT",
  "PAYOUT",
]);

function aggregateLedgerBreakdown(
  rows: Array<{ type: string; amount_pence: number }>,
): {
  trip_earnings_pence: number;
  debt_recovery_pence: number;
  adjustments_pence: number;
  paid_out_pence: number;
} {
  let trip_earnings_pence = 0;
  let debt_recovery_pence = 0;
  let adjustments_pence = 0;
  let paid_out_pence = 0;

  for (const row of rows) {
    const amt = Number(row.amount_pence);
    if (TRIP_EARNING_LEDGER_TYPES.has(row.type)) {
      trip_earnings_pence += amt;
    } else if (DEBT_RECOVERY_LEDGER_TYPES.has(row.type)) {
      debt_recovery_pence += Math.abs(amt);
    } else if (ADJUSTMENT_LEDGER_TYPES.has(row.type)) {
      adjustments_pence += amt;
    } else if (PAYOUT_LEDGER_TYPES.has(row.type)) {
      paid_out_pence += Math.abs(amt);
    }
  }

  return { trip_earnings_pence, debt_recovery_pence, adjustments_pence, paid_out_pence };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function verifyAdmin(supabase: ReturnType<typeof createClient>, authHeader: string | null) {
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data: roleData } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  return roleData ? user : null;
}

function connectAccountStatusLabel(account: Stripe.Account): string {
  if (account.requirements?.disabled_reason) return `restricted:${account.requirements.disabled_reason}`;
  if ((account.requirements?.currently_due?.length ?? 0) > 0) return "requirements_due";
  if (account.payouts_enabled && account.charges_enabled) return "active";
  if (!account.details_submitted) return "onboarding";
  return "pending";
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const user = await verifyAdmin(supabase, req.headers.get("Authorization"));
    if (!user) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!stripeSecretKey) {
      return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);
    const regionId = (body.region_id as string | undefined) ?? url.searchParams.get("region_id") ?? undefined;
    const driverId = (body.driver_id as string | undefined) ?? url.searchParams.get("driver_id") ?? undefined;

    let driverQuery = supabase
      .from("drivers")
      .select("id, driver_code, first_name, last_name, stripe_account_id, region_id, payouts_enabled, charges_enabled, regions(currency_code)")
      .not("stripe_account_id", "is", null);

    if (driverId) driverQuery = driverQuery.eq("id", driverId);
    if (regionId) driverQuery = driverQuery.eq("region_id", regionId);

    const { data: drivers, error: driversError } = await driverQuery;
    if (driversError) throw driversError;

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
    const platformAccount = await stripe.accounts.retrieve();
    const platformBalance = await stripe.balance.retrieve();
    const platformAvailable = platformBalance.available.find((b) => b.currency === "gbp")?.amount ?? 0;
    const platformPending = platformBalance.pending.find((b) => b.currency === "gbp")?.amount ?? 0;

    const accounts: Array<Record<string, unknown>> = [];

    for (const driver of drivers ?? []) {
      const acct = driver.stripe_account_id as string;
      if (acct === platformAccount.id) continue;

      const regionData = driver.regions as { currency_code?: string } | null;
      const currency = (regionData?.currency_code ?? "gbp").toLowerCase();

      const account = await stripe.accounts.retrieve(acct);
      const snapshot = await readConnectPayoutSnapshot(stripe, acct, currency);
      const inFlight = await listInFlightConnectPayouts(stripe, acct);
      const connectInTransitPence = inFlight
        .filter((p) => p.status === "in_transit")
        .reduce((s, p) => s + p.amount_pence, 0);

      const finance = await fetchPerDriverFinancialReconciliation(supabase, {
        driverId: driver.id,
        regionId: driver.region_id,
        providerAvailableBalancePence: platformAvailable,
        providerPendingBalancePence: platformPending,
        sourceTier: "LIVE",
      });

      const { data: summaryRow } = await supabase
        .from("driver_financial_summary")
        .select("wallet_balance, amount_owed_to_onecab")
        .eq("driver_id", driver.id)
        .maybeSingle();

      const walletBalance = Number(
        finance.driver_wallet_balance_pence ?? summaryRow?.wallet_balance ?? 0,
      );
      const walletOwed = Math.max(0, walletBalance);
      const financeCleared = finance.driver_available_now_pence;
      const connectAvailable = snapshot.available_pence;
      const connectInstantAvailable = snapshot.payouts_enabled ? connectAvailable : 0;
      const awaitingSettlement = computeConnectAwaitingSettlementPence(walletOwed, connectAvailable) ?? 0;
      const cashoutNow = computeDriverCashoutExecutablePence(
        walletOwed,
        financeCleared,
        connectAvailable,
      );
      const walletConnectDifference = connectAvailable - walletBalance;

      const { data: driverLedgerRows } = await supabase
        .from("driver_wallet_ledger")
        .select("type, amount_pence")
        .eq("driver_id", driver.id);

      const ledgerBreakdown = aggregateLedgerBreakdown(driverLedgerRows ?? []);

      const { data: transferItems } = await supabase
        .from("payout_items")
        .select("amount_pence, net_driver_payout_pence")
        .eq("driver_id", driver.id)
        .not("stripe_transfer_id", "is", null);

      const transfersToConnectCount = transferItems?.length ?? 0;
      const transfersToConnectPence = (transferItems ?? []).reduce(
        (s, item) => s + Number(item.net_driver_payout_pence ?? item.amount_pence ?? 0),
        0,
      );

      const { data: lastTransferItem } = await supabase
        .from("payout_items")
        .select("stripe_transfer_id, amount_pence, net_driver_payout_pence, created_at, completed_at")
        .eq("driver_id", driver.id)
        .not("stripe_transfer_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: lastPayoutItem } = await supabase
        .from("payout_items")
        .select("stripe_payout_id, amount_pence, net_driver_payout_pence, status, provider_status, created_at, completed_at")
        .eq("driver_id", driver.id)
        .not("stripe_payout_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: ledgerRows } = await supabase
        .from("driver_wallet_ledger")
        .select("stripe_payout_id")
        .eq("driver_id", driver.id)
        .not("stripe_payout_id", "is", null);

      const { data: payoutItems } = await supabase
        .from("payout_items")
        .select("stripe_payout_id, status")
        .eq("driver_id", driver.id)
        .not("stripe_payout_id", "is", null);

      const ledgerSet = new Set((ledgerRows ?? []).map((r) => r.stripe_payout_id));
      const itemSet = new Set((payoutItems ?? []).map((r) => r.stripe_payout_id));

      const accountRestricted = (account.requirements?.currently_due?.length ?? 0) > 0
        || account.requirements?.disabled_reason != null;

      const cashoutBlockReasons: string[] = [];
      if (finance.payout_blocked && finance.payout_blocked_reasons.length > 0) {
        cashoutBlockReasons.push(...finance.payout_blocked_reasons);
      }
      if (!snapshot.payouts_enabled) {
        cashoutBlockReasons.push("Stripe Connect payouts disabled");
      }
      if (cashoutNow != null && cashoutNow > 0 && cashoutNow < MIN_CASHOUT_AMOUNT_PENCE) {
        cashoutBlockReasons.push(`Below minimum cash-out (£${(MIN_CASHOUT_AMOUNT_PENCE / 100).toFixed(2)})`);
      }

      const manualGate = evaluateConnectManualPayoutGate({
        wallet_balance_pence: walletBalance,
        driver_available_now_pence: financeCleared,
        connect_available_pence: connectAvailable,
        payouts_enabled: snapshot.payouts_enabled === true,
        charges_enabled: account.charges_enabled === true,
        stripe_account_id: acct,
        account_restricted: accountRestricted,
        payout_blocked: finance.payout_blocked,
        reconciliation_status: finance.reconciliation_status,
        outstanding_debt_pence: Number(summaryRow?.amount_owed_to_onecab ?? 0),
      });

      const allCashoutBlocks = [...new Set([
        ...cashoutBlockReasons,
        ...(cashoutNow === 0 || cashoutNow == null ? manualGate.block_reasons : []),
      ])];

      accounts.push({
        driver_id: driver.id,
        driver_code: driver.driver_code,
        driver_name: `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim(),
        stripe_account_id: acct,
        connect_account_status: connectAccountStatusLabel(account),
        connect_account_type: account.type,
        charges_enabled: account.charges_enabled ?? false,
        payouts_enabled: snapshot.payouts_enabled ?? false,
        db_payouts_enabled: driver.payouts_enabled,
        requirements_due: account.requirements?.currently_due ?? [],
        currency,
        onecab_wallet: {
          driver_earned_owed_pence: walletOwed,
          ledger_balance_pence: walletBalance,
          trip_earnings_pence: ledgerBreakdown.trip_earnings_pence,
          debt_recovery_pence: ledgerBreakdown.debt_recovery_pence,
          adjustments_pence: ledgerBreakdown.adjustments_pence,
          paid_out_pence: ledgerBreakdown.paid_out_pence,
        },
        stripe_connect: {
          stripe_account_id: acct,
          account_type: account.type,
          payouts_enabled: snapshot.payouts_enabled ?? false,
          available_to_payout_pence: connectAvailable,
          instant_available_pence: connectInstantAvailable,
          pending_pence: snapshot.pending_pence,
          in_transit_pence: connectInTransitPence,
          last_payout_id: lastPayoutItem?.stripe_payout_id ?? null,
          last_payout_amount_pence: lastPayoutItem?.net_driver_payout_pence
            ?? lastPayoutItem?.amount_pence ?? null,
          last_payout_date: lastPayoutItem?.completed_at ?? lastPayoutItem?.created_at ?? null,
          last_payout_status: lastPayoutItem?.provider_status ?? lastPayoutItem?.status ?? null,
          next_payout_date: finance.next_payout_date,
        },
        platform_reconciliation: {
          platform_available_pence: finance.provider_available_balance_pence,
          platform_pending_pence: finance.provider_pending_balance_pence,
          platform_allocated_to_driver_pence: finance.provider_available_balance_allocated_to_driver_pence,
          application_fees_pence: finance.digital_onecab_net_commission_pence,
          transfers_to_connect_count: transfersToConnectCount,
          transfers_to_connect_pence: transfersToConnectPence,
          reconciliation_status: finance.reconciliation_status,
          reconciliation_variance_pence: finance.reconciliation_variance_pence,
          source_tier: finance.source_tier,
          provider_settlement_evidence: finance.reconciliation_status === "BALANCED"
            ? "Digital reconciliation balanced"
            : `Reconciliation mismatch — variance ${finance.reconciliation_variance_pence}p`,
        },
        cashout_decision: {
          wallet_owed_pence: walletOwed,
          finance_cleared_pence: financeCleared,
          connect_available_pence: connectAvailable,
          cashout_now_pence: cashoutNow ?? 0,
          awaiting_settlement_pence: awaitingSettlement,
          block_reasons: allCashoutBlocks,
          cashout_enabled: allCashoutBlocks.length === 0
            && cashoutNow != null
            && cashoutNow >= MIN_CASHOUT_AMOUNT_PENCE,
        },
        connect_available_pence: connectAvailable,
        connect_instant_available_pence: connectInstantAvailable,
        connect_pending_pence: snapshot.pending_pence,
        connect_in_transit_pence: connectInTransitPence,
        wallet_balance_pence: walletBalance,
        wallet_owed_pence: walletOwed,
        onecab_available_now_pence: financeCleared,
        finance_cleared_pence: financeCleared,
        awaiting_settlement_pence: awaitingSettlement,
        cashout_now_pence: cashoutNow ?? 0,
        cashout_block_reasons: allCashoutBlocks,
        cashout_enabled: allCashoutBlocks.length === 0
          && cashoutNow != null
          && cashoutNow >= MIN_CASHOUT_AMOUNT_PENCE,
        wallet_connect_difference_pence: walletConnectDifference,
        max_manual_connect_payout_pence: manualGate.max_manual_payout_pence,
        manual_connect_payout_allowed: manualGate.allowed,
        manual_connect_payout_block_reasons: manualGate.block_reasons,
        payout_blocked: finance.payout_blocked,
        payout_blocked_reasons: finance.payout_blocked_reasons,
        reconciliation_status: finance.reconciliation_status,
        next_payout_date: finance.next_payout_date,
        last_stripe_transfer_id: lastTransferItem?.stripe_transfer_id ?? null,
        last_transfer_amount_pence: lastTransferItem?.net_driver_payout_pence
          ?? lastTransferItem?.amount_pence ?? null,
        last_transfer_date: lastTransferItem?.completed_at ?? lastTransferItem?.created_at ?? null,
        last_payout_id: lastPayoutItem?.stripe_payout_id ?? null,
        last_payout_status: lastPayoutItem?.provider_status ?? lastPayoutItem?.status ?? null,
        last_payout_amount_pence: lastPayoutItem?.net_driver_payout_pence
          ?? lastPayoutItem?.amount_pence ?? null,
        last_payout_date: lastPayoutItem?.completed_at ?? lastPayoutItem?.created_at ?? null,
        payout_mode: snapshot.interval === "manual" ? "manual" : "automatic",
        payout_schedule_interval: snapshot.interval,
        payout_schedule_delay_days: snapshot.delay_days,
        automatic_payouts_enabled: snapshot.automatic_payouts_enabled,
        in_flight_payouts: inFlight.map((p) => ({
          ...p,
          in_ledger: ledgerSet.has(p.payout_id),
          in_payout_items: itemSet.has(p.payout_id),
          orphan_risk: !ledgerSet.has(p.payout_id) && !itemSet.has(p.payout_id),
        })),
      });
    }

    return new Response(JSON.stringify({
      phase: "driver_payout_ssot_visibility",
      read_only: true,
      ssot_note: {
        wallet_balance: "driver_wallet_ledger — ONECAB ledger truth (what ONECAB owes the driver)",
        finance_cleared: "finance reconciliation driver_available_now — finance-cleared cap",
        connect_available: "Stripe Connect balance.available — Connect payout truth",
        cashout_now: "min(ledger owed, finance-cleared, Connect available)",
        awaiting_settlement: "max(0, ledger owed − Connect available)",
        platform_balance: "Platform Stripe balance — reconciliation only, not cash-out cap",
      },
      platform_stripe: {
        available_pence: platformAvailable,
        pending_pence: platformPending,
      },
      timestamp: new Date().toISOString(),
      connect_accounts: accounts,
      summary: {
        total: accounts.length,
        automatic_count: accounts.filter((a) => a.automatic_payouts_enabled === true).length,
        manual_count: accounts.filter((a) => a.automatic_payouts_enabled === false).length,
        in_flight_count: accounts.reduce(
          (s, a) => s + ((a.in_flight_payouts as unknown[])?.length ?? 0),
          0,
        ),
        total_connect_available_pence: accounts.reduce(
          (s, a) => s + Number(a.connect_available_pence ?? 0),
          0,
        ),
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-connect-payout-status]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
