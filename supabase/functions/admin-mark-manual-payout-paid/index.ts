import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { finalizePayoutAfterProviderSuccess } from "../_shared/payoutLedgerSync.ts";
import { fetchPerDriverFinancialReconciliation } from "../_shared/perDriverFinancialReconciliation.ts";
import { resolveCurrencyFromDriver } from "../_shared/regionCurrency.ts";
import {
  driverHasActivePayoutDestination,
  isManualBankPayoutProvider,
  isValidProviderReference,
  normalizeProviderReference,
  PENDING_PAYOUT_ITEM_STATUSES,
  resolveRegionPayoutProvider,
} from "../_shared/manualProviderPayoutSSOT.ts";
import { isPayoutVerificationMode } from "../_shared/payoutExecutionGate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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
    const payoutItemId = String(body.payout_item_id ?? "").trim();
    const providerReferenceRaw = String(body.provider_reference ?? body.revolut_reference ?? "").trim();
    const confirmManualPayout = body.confirm_manual_payout === true;

    if (!payoutItemId) {
      return new Response(JSON.stringify({ error: "payout_item_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: payoutItem, error: itemError } = await supabase
      .from("payout_items")
      .select(`
        id, batch_id, driver_id, amount_pence, net_driver_payout_pence, status,
        provider_reference, ledger_entry_id,
        payout_batches ( id, kind, status )
      `)
      .eq("id", payoutItemId)
      .maybeSingle();

    if (itemError || !payoutItem) {
      return new Response(JSON.stringify({ error: "Payout item not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const batch = payoutItem.payout_batches as { id?: string; kind?: string; status?: string } | null;
    const batchId = payoutItem.batch_id ?? batch?.id;
    const batchKind = batch?.kind ?? "WEEKLY_MONDAY";
    const payoutAmount = Math.max(
      0,
      Number(payoutItem.net_driver_payout_pence ?? payoutItem.amount_pence ?? 0),
    );

    const { data: driverRow } = await supabase
      .from("drivers")
      .select("id, region_id")
      .eq("id", payoutItem.driver_id)
      .maybeSingle();

    const regionId = driverRow?.region_id ?? null;
    const payoutProvider = await resolveRegionPayoutProvider(supabase, regionId);

    if (!isManualBankPayoutProvider(payoutProvider)) {
      return new Response(JSON.stringify({
        error: "Manual mark-paid is only supported for Revolut/manual bank payout regions",
        error_code: "MANUAL_PAYOUT_PROVIDER_UNSUPPORTED",
        payout_provider: payoutProvider,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (verificationMode) {
      return new Response(JSON.stringify({
        success: true,
        verification_mode: true,
        payout_safety_version: "phase3-revolut-manual",
        payout_item_id: payoutItemId,
        payout_amount_pence: payoutAmount,
        payout_provider: payoutProvider,
        message: "Verification mode — no ledger debit or payout item mutation",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!confirmManualPayout) {
      return new Response(JSON.stringify({
        error: "confirm_manual_payout=true required",
        error_code: "CONFIRMATION_REQUIRED",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!isValidProviderReference(providerReferenceRaw)) {
      return new Response(JSON.stringify({
        error: "provider_reference required (3–128 chars)",
        error_code: "INVALID_PROVIDER_REFERENCE",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const providerReference = normalizeProviderReference(providerReferenceRaw);

    if (payoutItem.status === "completed" && payoutItem.ledger_entry_id) {
      return new Response(JSON.stringify({
        success: true,
        already_completed: true,
        payout_item_id: payoutItemId,
        ledger_entry_id: payoutItem.ledger_entry_id,
        provider_reference: payoutItem.provider_reference,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!PENDING_PAYOUT_ITEM_STATUSES.has(String(payoutItem.status ?? "").toLowerCase())) {
      return new Response(JSON.stringify({
        error: `Payout item status ${payoutItem.status} cannot be marked paid`,
        error_code: "INVALID_PAYOUT_ITEM_STATUS",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const hasDestination = await driverHasActivePayoutDestination(
      supabase,
      payoutItem.driver_id,
      payoutProvider!,
    );
    if (!hasDestination) {
      return new Response(JSON.stringify({
        error: "Driver has no active payout destination for this provider",
        error_code: "PAYOUT_DESTINATION_MISSING",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: duplicateRef } = await supabase
      .from("payout_items")
      .select("id")
      .eq("provider_reference", providerReference)
      .neq("id", payoutItemId)
      .maybeSingle();

    if (duplicateRef?.id) {
      return new Response(JSON.stringify({
        error: "provider_reference already used on another payout item",
        error_code: "DUPLICATE_PROVIDER_REFERENCE",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ssot = await fetchPerDriverFinancialReconciliation(supabase, {
      driverId: payoutItem.driver_id,
      regionId,
      providerAvailableBalancePence: Number.MAX_SAFE_INTEGER,
      providerPendingBalancePence: 0,
      sourceTier: "LIVE",
      manualProviderPayout: true,
    });

    if (ssot.payout_blocked) {
      return new Response(JSON.stringify({
        error: "Payout blocked by finance SSOT",
        error_code: "PAYOUT_BLOCKED",
        payout_blocked_reasons: ssot.payout_blocked_reasons,
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (payoutAmount <= 0) {
      return new Response(JSON.stringify({
        error: "Payout amount must be positive",
        error_code: "INVALID_PAYOUT_AMOUNT",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (payoutAmount > ssot.driver_wallet_balance_pence) {
      return new Response(JSON.stringify({
        error: "Payout amount exceeds wallet balance",
        error_code: "PAYOUT_EXCEEDS_WALLET",
        wallet_balance_pence: ssot.driver_wallet_balance_pence,
        payout_amount_pence: payoutAmount,
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currencyCode = await resolveCurrencyFromDriver(supabase, payoutItem.driver_id);

    if (!batchId) {
      return new Response(JSON.stringify({
        error: "Payout item missing batch_id",
        error_code: "BATCH_ID_MISSING",
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await finalizePayoutAfterProviderSuccess({
      supabase,
      payoutItemId,
      batchId,
      driverId: payoutItem.driver_id,
      payoutAmount,
      currencyCode,
      batchKind,
      providerReference,
      providerPayoutId: providerReference,
      paymentProvider: payoutProvider,
      walletBalanceBefore: ssot.driver_wallet_balance_pence,
    });

    if (!result.success) {
      return new Response(JSON.stringify({
        success: false,
        error: result.error,
        status: result.status,
        ledger_entry_id: result.ledgerEntryId,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      payout_safety_version: "phase3-revolut-manual",
      payout_item_id: payoutItemId,
      batch_id: batchId,
      provider_reference: providerReference,
      ledger_entry_id: result.ledgerEntryId,
      wallet_balance_after_pence: result.walletBalanceAfter,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-mark-manual-payout-paid]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
