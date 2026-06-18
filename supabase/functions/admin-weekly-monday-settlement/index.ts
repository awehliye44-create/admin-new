import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { fetchPerDriverFinancialReconciliation } from "../_shared/perDriverFinancialReconciliation.ts";
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

type DriverResult = {
  driver_id: string;
  driver_name?: string | null;
  status: "READY" | "BLOCKED" | "FAILED";
  failure_reason?: string;
  failure_code?: string;
  net_payable_pence?: number;
  payout_warning_reasons?: string[];
  payout_blocked_reasons?: string[];
  payout_item_id?: string;
};

/**
 * WEEKLY_MONDAY settlement — creates batch + payout_items per eligible driver.
 * Skips hard-blocked drivers only; soft warnings are included.
 * dry_run: simulate without DB writes. Never executes Stripe transfers.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const verificationMode = isPayoutVerificationMode(body as Record<string, unknown>);
    const stripeExecutionEnabled = isAdminStripePayoutExecutionEnabled();

    if (verificationMode) {
      const regionIdPreview = body.region_id as string | undefined;
      let driverQueryPreview = supabase
        .from("drivers")
        .select("id, region_id, first_name, last_name")
        .eq("approval_status", "approved");
      if (regionIdPreview) driverQueryPreview = driverQueryPreview.eq("region_id", regionIdPreview);
      const { data: driversPreview } = await driverQueryPreview;
      const resultsPreview = (driversPreview ?? []).map((driver) => ({
        driver_id: driver.id,
        driver_name: `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim() || null,
        status: "SIMULATED" as const,
      }));
      return new Response(JSON.stringify({
        success: true,
        dry_run: true,
        verification_mode: true,
        payout_safety_version: "3d.1",
        stripe_execution_disabled: !stripeExecutionEnabled,
        message: PAYOUT_VERIFICATION_MODE_MESSAGE,
        batch_id: null,
        batch_status: "SIMULATED",
        total_amount_pence: 0,
        ready_count: resultsPreview.length,
        blocked_count: 0,
        failed_count: 0,
        warning_count: 0,
        results: resultsPreview,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const regionId = body.region_id as string | undefined;

    if (!stripeExecutionEnabled) {
      return new Response(JSON.stringify({
        error: PAYOUT_EXECUTION_DISABLED_MESSAGE,
        error_code: PAYOUT_EXECUTION_DISABLED_CODE,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let stripeAvailablePence = 0;
    let stripePendingPence = 0;
    if (!verificationMode && stripeSecretKey) {
      const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
      const balance = await stripe.balance.retrieve();
      stripeAvailablePence = balance.available.find((b) => b.currency === "gbp")?.amount ?? 0;
      stripePendingPence = balance.pending.find((b) => b.currency === "gbp")?.amount ?? 0;
    }

    let driverQuery = supabase
      .from("drivers")
      .select("id, region_id, stripe_account_id, payouts_enabled, onboarding_complete, first_name, last_name")
      .eq("approval_status", "approved");

    if (regionId) driverQuery = driverQuery.eq("region_id", regionId);

    const { data: drivers, error: driversError } = await driverQuery;
    if (driversError) throw driversError;

    const runDate = new Date().toISOString().slice(0, 10);
    let batchId: string | null = null;

    if (!verificationMode) {
      const { data: batch, error: batchError } = await supabase
        .from("payout_batches")
        .insert({
          kind: "WEEKLY_MONDAY",
          run_date: runDate,
          status: "CREATED",
          total_drivers: 0,
          total_amount_pence: 0,
          created_by: user.id,
        })
        .select()
        .single();

      if (batchError) throw batchError;
      batchId = batch.id;
    }

    const results: DriverResult[] = [];
    let totalAmount = 0;
    let successCount = 0;
    let failedCount = 0;
    let blockedCount = 0;
    let warningCount = 0;

    for (const driver of drivers ?? []) {
      const driverName = `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim() || null;

      const ssot = await fetchPerDriverFinancialReconciliation(supabase, {
        driverId: driver.id,
        regionId: driver.region_id,
        providerAvailableBalancePence: stripeAvailablePence,
        providerPendingBalancePence: stripePendingPence,
        sourceTier: "LIVE",
      });

      const payoutAmount = ssot.driver_available_now_pence;
      const hasWarnings = ssot.payout_warning_reasons.length > 0;

      if (ssot.payout_blocked || payoutAmount <= 0) {
        blockedCount += 1;
        results.push({
          driver_id: driver.id,
          driver_name: driverName,
          status: "BLOCKED",
          failure_reason: ssot.payout_blocked_reasons.join("; ")
            || (payoutAmount <= 0 ? "No payable balance" : "Hard payout block"),
          net_payable_pence: payoutAmount,
          payout_blocked_reasons: ssot.payout_blocked_reasons,
          payout_warning_reasons: ssot.payout_warning_reasons,
        });
        continue;
      }

      if (hasWarnings) warningCount += 1;

      if (verificationMode) {
        successCount += 1;
        totalAmount += payoutAmount;
        results.push({
          driver_id: driver.id,
          driver_name: driverName,
          status: "READY",
          net_payable_pence: payoutAmount,
          payout_warning_reasons: ssot.payout_warning_reasons,
          payout_blocked_reasons: ssot.payout_blocked_reasons,
        });
        continue;
      }

      const { data: item, error: itemError } = await supabase
        .from("payout_items")
        .insert({
          batch_id: batchId,
          driver_id: driver.id,
          amount_pence: payoutAmount,
          net_driver_payout_pence: payoutAmount,
          status: "pending",
          settlement_status: "READY",
          driver_stripe_account_id: driver.stripe_account_id,
          provider_response: {
            payout_warning_reasons: ssot.payout_warning_reasons,
            payout_blocked_reasons: ssot.payout_blocked_reasons,
          },
        })
        .select()
        .single();

      if (itemError || !item) {
        failedCount += 1;
        results.push({
          driver_id: driver.id,
          driver_name: driverName,
          status: "FAILED",
          failure_code: "PAYOUT_ITEM_CREATE_FAILED",
          failure_reason: itemError?.message ?? "payout_item insert failed",
          payout_warning_reasons: ssot.payout_warning_reasons,
        });
        continue;
      }

      totalAmount += payoutAmount;
      successCount += 1;
      results.push({
        driver_id: driver.id,
        driver_name: driverName,
        payout_item_id: item.id,
        status: "READY",
        net_payable_pence: payoutAmount,
        payout_warning_reasons: ssot.payout_warning_reasons,
        payout_blocked_reasons: ssot.payout_blocked_reasons,
      });
    }

    let batchStatus = successCount > 0 ? "READY" : "BLOCKED";
    if (totalAmount > 0 && successCount === 0 && !verificationMode) {
      batchStatus = "INVALID_ORPHANED";
    }

    if (!verificationMode && batchId) {
      await supabase.from("payout_batches").update({
        status: batchStatus,
        total_drivers: successCount + blockedCount + failedCount,
        total_amount_pence: totalAmount,
        successful_payouts: 0,
        failed_payouts: failedCount,
        failure_reason: batchStatus === "INVALID_ORPHANED"
          ? "Batch has amount but no payout items"
          : (successCount === 0 ? "No eligible drivers for Monday settlement" : null),
        failure_code: batchStatus === "INVALID_ORPHANED" ? "ORPHANED_NO_ITEMS" : null,
        updated_at: new Date().toISOString(),
      }).eq("id", batchId);
    }

    return new Response(JSON.stringify({
      success: true,
      dry_run: verificationMode,
      verification_mode: verificationMode,
      payout_safety_version: '3d.1',
      stripe_execution_disabled: !stripeExecutionEnabled,
      message: verificationMode ? PAYOUT_VERIFICATION_MODE_MESSAGE : undefined,
      batch_id: batchId,
      batch_status: batchStatus,
      total_amount_pence: totalAmount,
      ready_count: successCount,
      blocked_count: blockedCount,
      failed_count: failedCount,
      warning_count: warningCount,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-weekly-monday-settlement]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
