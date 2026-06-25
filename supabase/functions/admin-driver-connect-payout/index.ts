/**
 * admin-driver-connect-payout
 *
 * Pays out from funds already sitting on the driver's Stripe Connect account
 * (Connect balance → driver bank). Does NOT transfer from platform.
 *
 * Caps: min(wallet_balance, driver_available_now, connect_available).
 * Standard wallet payout SSOT (driver_available_now) is unchanged for driver app.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { readConnectPayoutSnapshot } from "../_shared/connectPayoutLockdown.ts";
import { fetchPerDriverFinancialReconciliation } from "../_shared/perDriverFinancialReconciliation.ts";
import { finalizePayoutAfterProviderSuccess } from "../_shared/payoutLedgerSync.ts";
import {
  buildPayoutSettlementSnapshot,
  recordPayoutFailureAndReturnToWallet,
} from "../_shared/payoutFailureRecovery.ts";
import { findInFlightPayoutItem } from "../_shared/payoutInflightGuard.ts";
import { resolveCurrencyFromDriver } from "../_shared/regionCurrency.ts";
import {
  evaluateConnectManualPayoutGate,
  insertConnectPayoutAuditLog,
} from "../_shared/connectManualPayout.ts";
import {
  isAdminStripePayoutExecutionEnabled,
  isPayoutVerificationMode,
  PAYOUT_EXECUTION_DISABLED_CODE,
  PAYOUT_EXECUTION_DISABLED_MESSAGE,
  PAYOUT_VERIFICATION_MODE_MESSAGE,
} from "../_shared/payoutExecutionGate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_KIND = "CONNECT_MANUAL";

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

    const body = await req.json().catch(() => ({}));
    const verificationMode = isPayoutVerificationMode(body as Record<string, unknown>);
    const driver_id = body.driver_id as string | undefined;
    const amount_pence = Number(body.amount_pence ?? 0);
    const reason = String(body.reason ?? "").trim();

    if (!driver_id) {
      return new Response(JSON.stringify({ error: "driver_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!Number.isFinite(amount_pence) || amount_pence <= 0) {
      return new Response(JSON.stringify({ error: "amount_pence must be a positive integer" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: driver, error: driverErr } = await supabase
      .from("drivers")
      .select("id, first_name, last_name, stripe_account_id, region_id, payouts_enabled, charges_enabled")
      .eq("id", driver_id)
      .single();

    if (driverErr || !driver?.stripe_account_id) {
      return new Response(JSON.stringify({ error: "Driver or Stripe Connect account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!stripeSecretKey) {
      return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
    const platformBalance = await stripe.balance.retrieve();
    const platformAvailable = platformBalance.available.find((b) => b.currency === "gbp")?.amount ?? 0;
    const platformPending = platformBalance.pending.find((b) => b.currency === "gbp")?.amount ?? 0;

    const connectSnapshot = await readConnectPayoutSnapshot(stripe, driver.stripe_account_id);
    const account = await stripe.accounts.retrieve(driver.stripe_account_id);
    const accountRestricted = (account.requirements?.currently_due?.length ?? 0) > 0
      || (account.requirements?.disabled_reason != null);

    const finance = await fetchPerDriverFinancialReconciliation(supabase, {
      driverId: driver_id,
      regionId: driver.region_id,
      providerAvailableBalancePence: platformAvailable,
      providerPendingBalancePence: platformPending,
      sourceTier: "LIVE",
    });

    const { data: debtRow } = await supabase
      .from("driver_financial_summary")
      .select("amount_owed_to_onecab, wallet_balance")
      .eq("driver_id", driver_id)
      .maybeSingle();

    const walletBalance = Number(
      finance.driver_wallet_balance_pence ?? debtRow?.wallet_balance ?? 0,
    );
    const outstandingDebt = Number(debtRow?.amount_owed_to_onecab ?? 0);

    const gate = evaluateConnectManualPayoutGate({
      wallet_balance_pence: walletBalance,
      driver_available_now_pence: finance.driver_available_now_pence,
      connect_available_pence: connectSnapshot.available_pence,
      payouts_enabled: connectSnapshot.payouts_enabled === true,
      charges_enabled: account.charges_enabled === true,
      stripe_account_id: driver.stripe_account_id,
      account_restricted: accountRestricted,
      payout_blocked: finance.payout_blocked,
      reconciliation_status: finance.reconciliation_status,
      outstanding_debt_pence: outstandingDebt,
    });

    if (amount_pence > gate.max_manual_payout_pence) {
      await insertConnectPayoutAuditLog(supabase, {
        driver_id,
        event_type: "connect_manual_payout_rejected_amount",
        requested_amount_pence: amount_pence,
        provider_balance_pence: connectSnapshot.available_pence,
        provider_error_message: `Requested ${amount_pence}p exceeds max ${gate.max_manual_payout_pence}p`,
        metadata: { max_manual_payout_pence: gate.max_manual_payout_pence, reason },
      });
      return new Response(JSON.stringify({
        success: false,
        error: `Amount exceeds max manual payout (${gate.max_manual_payout_pence}p)`,
        error_code: "CONNECT_PAYOUT_EXCEEDS_MAX",
        max_manual_payout_pence: gate.max_manual_payout_pence,
        block_reasons: gate.block_reasons,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!gate.allowed) {
      await insertConnectPayoutAuditLog(supabase, {
        driver_id,
        event_type: "connect_manual_payout_blocked",
        requested_amount_pence: amount_pence,
        provider_balance_pence: connectSnapshot.available_pence,
        provider_error_message: gate.block_reasons.join(" · "),
        metadata: { block_reasons: gate.block_reasons, reason },
      });
      return new Response(JSON.stringify({
        success: false,
        error: "Connect manual payout blocked",
        error_code: "CONNECT_PAYOUT_BLOCKED",
        block_reasons: gate.block_reasons,
        max_manual_payout_pence: gate.max_manual_payout_pence,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const inFlight = await findInFlightPayoutItem(supabase, driver_id);
    if (inFlight) {
      return new Response(JSON.stringify({
        success: false,
        error: "Driver has an in-flight payout item",
        error_code: "PAYOUT_IN_FLIGHT",
        payout_item_id: inFlight.id,
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const preview = {
      driver_id,
      amount_pence,
      max_manual_payout_pence: gate.max_manual_payout_pence,
      wallet_balance_pence: walletBalance,
      driver_available_now_pence: finance.driver_available_now_pence,
      connect_available_pence: connectSnapshot.available_pence,
      payout_source: "connect_balance",
      stripe_account_id: driver.stripe_account_id,
      account_type: account.type,
      payouts_enabled: connectSnapshot.payouts_enabled,
      payout_schedule: connectSnapshot.interval,
      reason,
    };

    if (verificationMode) {
      return new Response(JSON.stringify({
        success: true,
        verification_mode: true,
        message: PAYOUT_VERIFICATION_MODE_MESSAGE,
        preview,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!isAdminStripePayoutExecutionEnabled()) {
      return new Response(JSON.stringify({
        success: false,
        error: PAYOUT_EXECUTION_DISABLED_MESSAGE,
        error_code: PAYOUT_EXECUTION_DISABLED_CODE,
        preview,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currencyResult = await resolveCurrencyFromDriver(supabase, driver_id);
    const currency_code = currencyResult.currency_code;

    const { data: batch, error: batchError } = await supabase
      .from("payout_batches")
      .insert({
        kind: BATCH_KIND,
        status: "CREATED",
        total_drivers: 1,
        total_amount_pence: amount_pence,
        created_by: user.id,
        notes: reason || "Connect balance manual payout",
      })
      .select()
      .single();

    if (batchError || !batch) throw batchError ?? new Error("batch insert failed");

    const { data: payoutItem, error: itemError } = await supabase
      .from("payout_items")
      .insert({
        batch_id: batch.id,
        driver_id,
        amount_pence,
        status: "pending",
        settlement_status: "PROCESSING",
        driver_stripe_account_id: driver.stripe_account_id,
        provider_response: {
          payout_source: "connect_balance",
          admin_reason: reason,
          max_manual_payout_pence: gate.max_manual_payout_pence,
          performed_by: user.id,
        },
      })
      .select()
      .single();

    if (itemError || !payoutItem) {
      await supabase.from("payout_batches").update({
        status: "INVALID_ORPHANED",
        failure_code: "ORPHANED_NO_ITEMS",
        updated_at: new Date().toISOString(),
      }).eq("id", batch.id);
      throw itemError ?? new Error("payout_item insert failed");
    }

    await supabase.from("payout_batches").update({
      total_amount_pence: amount_pence,
      status: "READY",
      updated_at: new Date().toISOString(),
    }).eq("id", batch.id);

    const runDate = new Date().toISOString().slice(0, 10);
    const settlementSnapshot = await buildPayoutSettlementSnapshot(
      supabase,
      driver_id,
      amount_pence,
      runDate,
    );

    await supabase.from("payout_items").update({
      gross_payable_pence: settlementSnapshot.gross_payable_pence,
      cash_commission_recovered_pence: settlementSnapshot.cash_commission_recovered_pence,
      net_driver_payout_pence: settlementSnapshot.net_driver_payout_pence,
      updated_at: new Date().toISOString(),
    }).eq("id", payoutItem.id);

    let stripePayoutId: string | null = null;
    let stripeError: string | null = null;

    try {
      const payout = await stripe.payouts.create({
        amount: amount_pence,
        currency: currency_code.toLowerCase(),
        metadata: {
          driver_id,
          payout_item_id: payoutItem.id,
          batch_id: batch.id,
          type: "connect_manual_payout",
          admin_id: user.id,
        },
      }, {
        stripeAccount: driver.stripe_account_id,
        idempotencyKey: `connect_payout_${payoutItem.id}`,
      });
      stripePayoutId = payout.id;
    } catch (err) {
      stripeError = (err as Error).message;
    }

    if (stripeError) {
      const failure = await recordPayoutFailureAndReturnToWallet({
        supabase,
        payoutItemId: payoutItem.id,
        batchId: batch.id,
        batchKind: BATCH_KIND,
        driverId: driver_id,
        netDriverPayoutPence: amount_pence,
        snapshot: settlementSnapshot,
        providerStatus: "failed",
        providerReference: null,
        rawFailureReason: stripeError,
      });

      await insertConnectPayoutAuditLog(supabase, {
        driver_id,
        event_type: "connect_manual_payout_stripe_failed",
        requested_amount_pence: amount_pence,
        provider_balance_pence: connectSnapshot.available_pence,
        provider_error_message: stripeError,
        metadata: { payout_item_id: payoutItem.id, batch_id: batch.id, reason },
      });

      return new Response(JSON.stringify({
        success: false,
        error: stripeError,
        batch_id: batch.id,
        payout_item_id: payoutItem.id,
        returned_to_wallet_pence: failure.returned_pence,
      }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const finalize = await finalizePayoutAfterProviderSuccess({
      supabase,
      payoutItemId: payoutItem.id,
      batchId: batch.id,
      driverId: driver_id,
      payoutAmount: amount_pence,
      currencyCode: currency_code,
      batchKind: BATCH_KIND,
      stripeTransferId: null,
      stripePayoutId,
      walletBalanceBefore: walletBalance,
    });

    await insertConnectPayoutAuditLog(supabase, {
      driver_id,
      event_type: "connect_manual_payout_succeeded",
      requested_amount_pence: amount_pence,
      provider_balance_pence: connectSnapshot.available_pence,
      metadata: {
        payout_item_id: payoutItem.id,
        batch_id: batch.id,
        stripe_payout_id: stripePayoutId,
        reason,
        admin_id: user.id,
      },
    });

    return new Response(JSON.stringify({
      success: finalize.success,
      batch_id: batch.id,
      payout_item_id: payoutItem.id,
      amount_pence,
      stripe_payout_id: stripePayoutId,
      wallet_balance_before: walletBalance,
      wallet_balance_after: finalize.walletBalanceAfter,
      ledger_entry_id: finalize.ledgerEntryId,
      payout_source: "connect_balance",
      critical: !finalize.success,
      error: finalize.error,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-driver-connect-payout]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
