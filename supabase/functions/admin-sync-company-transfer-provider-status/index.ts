/**
 * Slice 12 — Manual / poll provider status sync for company transfers.
 * Read-only relay GET /transaction/:id — never calls /pay.
 *
 * POST { transfer_id: string }
 *
 * Business/validation outcomes return HTTP 200 + ok:false so Lovable/admin
 * never treat expected gates as blank-screen RUNTIME_ERROR (non-2xx).
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { COMPLETION_ERROR } from "../_shared/companyTransferCompletionSSOT.ts";
import { redactCompanyTransferCompletionEvidence } from "../_shared/companyTransferCompletionSSOT.ts";
import { mapProviderReversalOutcome } from "../_shared/companyTransferCompletionSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayCompanyTransferPaymentStatus,
} from "../_shared/revolutBusinessRelayClient.ts";
import { ensureFreshRevolutBusinessAccessToken } from "../_shared/revolutBusinessAccessTokenRefresh.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

/** Expected business outcomes — never blank-screen via non-2xx. */
function gate(data: Record<string, unknown>): Response {
  return json({
    success: false,
    ...data,
    revolut_pay_called: data.revolut_pay_called ?? false,
    money_moved: data.money_moved ?? false,
  }, 200);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return gate({ ok: false, error: "method_not_allowed", message: "POST required" });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return gate({ ok: false, error: "invalid_json", message: "Invalid JSON body" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const transferId = String(body.transfer_id ?? "").trim();
  if (!transferId) {
    return gate({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      error_code: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "transfer_id is required",
      first_visible_error: "transfer_id is required",
    });
  }

  const { data: intent } = await supabase
    .from("company_transfer_payment_intents")
    .select("id, provider_payment_id, execution_status")
    .eq("transfer_id", transferId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!intent?.provider_payment_id) {
    return gate({
      ok: false,
      error: COMPLETION_ERROR.MISSING_PROVIDER_PAYMENT_ID,
      error_code: COMPLETION_ERROR.MISSING_PROVIDER_PAYMENT_ID,
      message:
        "No provider payment to sync yet. Submit to Revolut first (blocked while company LIVE execution is off).",
      first_visible_error:
        "No provider payment to sync yet. Submit to Revolut first (blocked while company LIVE execution is off).",
    });
  }

  if (!isRevolutBusinessRelayConfigured()) {
    return gate({
      ok: false,
      error: COMPLETION_ERROR.RELAY_UNREACHABLE,
      error_code: COMPLETION_ERROR.RELAY_UNREACHABLE,
      message: "Revolut Business relay is not configured",
      first_visible_error: "Revolut Business relay is not configured",
    });
  }

  let accessToken: string;
  try {
    const tok = await ensureFreshRevolutBusinessAccessToken(supabase);
    accessToken = tok.accessToken;
  } catch (err) {
    return gate({
      ok: false,
      error: COMPLETION_ERROR.ACCESS_TOKEN_REQUIRED,
      error_code: COMPLETION_ERROR.ACCESS_TOKEN_REQUIRED,
      message: err instanceof Error ? err.message : "token unavailable",
      first_visible_error: "Revolut access token unavailable",
    });
  }

  try {
    const statusResult = await relayCompanyTransferPaymentStatus({
      providerPaymentId: String(intent.provider_payment_id),
      transferId,
      accessToken,
    });

    const evidence = redactCompanyTransferCompletionEvidence({
      provider_payment_id: intent.provider_payment_id,
      provider_state: statusResult.provider_state,
      provider_completed_at: statusResult.completed_at,
      http_status: statusResult.status,
    });

    const { data: syncRaw } = await supabase.rpc("sync_company_transfer_provider_status", {
      p_transfer_id: transferId,
      p_provider_payment_id: String(intent.provider_payment_id),
      p_provider_state: statusResult.provider_state,
      p_provider_completed_at: statusResult.completed_at,
      p_evidence_redacted: evidence,
    });

    const providerState = String(statusResult.provider_state ?? "").toLowerCase();
    let reversal: ReturnType<typeof mapProviderReversalOutcome> | null = null;
    let finalizeRaw: unknown = null;
    let moneyMoved = false;

    if (providerState === "completed") {
      // Automatic reconciliation: provider completed → consume hold + audit + transfer COMPLETED.
      const { data: fin } = await supabase.rpc("finalize_company_transfer_completion", {
        p_transfer_id: transferId,
        p_provider_payment_id: String(intent.provider_payment_id),
        p_provider_state: "completed",
        p_provider_completed_at: statusResult.completed_at,
        p_evidence_redacted: evidence,
      });
      finalizeRaw = fin;
      moneyMoved = Boolean(
        (fin as { money_moved?: boolean } | null)?.money_moved
          ?? (fin as { company_debited?: boolean } | null)?.company_debited,
      );
    } else if (["failed", "declined", "reverted"].includes(providerState)) {
      reversal = mapProviderReversalOutcome({ provider_state: providerState });
      await supabase.rpc("release_company_funding_hold", {
        p_transfer_id: transferId,
        p_reason: providerState.toUpperCase(),
      });
      await supabase.from("company_outgoing_transfers").update({
        status: reversal.transfer_status,
        failure_reason: providerState,
        updated_at: new Date().toISOString(),
      }).eq("id", transferId);
    }

    return json({
      ok: statusResult.status >= 200 && statusResult.status < 300,
      success: statusResult.status >= 200 && statusResult.status < 300,
      slice: 12,
      transfer_id: transferId,
      provider_payment_id: intent.provider_payment_id,
      provider_state: statusResult.provider_state,
      revolut_pay_called: false,
      money_moved: moneyMoved,
      sync: syncRaw,
      finalize: finalizeRaw,
      reversal,
    });
  } catch (err) {
    console.error("[admin-sync-company-transfer-provider-status]", err);
    return gate({
      ok: false,
      error: "SYNC_FAILED",
      error_code: "SYNC_FAILED",
      message: err instanceof Error ? err.message : String(err),
      first_visible_error: "Provider status sync failed",
    });
  }
});
