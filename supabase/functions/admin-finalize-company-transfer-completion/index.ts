/**
 * Slice 12 — Admin-controlled company transfer completion finalisation.
 * Polls Revolut transaction status via relay (read-only). Only canonical
 * `completed` may consume hold + debit company funds. Never calls /pay.
 *
 * POST { transfer_id: string, confirm_finalize?: true }
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  assertSlice12CompletionMoneySafety,
  COMPLETION_ERROR,
  evaluateCompanyTransferCompletionEligibility,
  evaluateSlice12CompletionFlagGate,
  isCanonicalProviderCompleted,
  mayFinaliseCompanyTransferFromProviderState,
  redactCompanyTransferCompletionEvidence,
} from "../_shared/companyTransferCompletionSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayCompanyTransferPaymentStatus,
  relayProbePayBlocked,
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 200);

  const flagGate = evaluateSlice12CompletionFlagGate(Deno.env);
  if (!flagGate.ok) {
    return json({
      ok: false,
      error: flagGate.code,
      message: flagGate.message,
      revolut_pay_called: false,
      company_debited: false,
      hold_consumed: false,
    }, 200);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 200);
  }

  if (body.confirm_finalize !== true) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "confirm_finalize:true is required for Slice 12 finalisation",
      revolut_pay_called: false,
    }, 200);
  }

  if (body.revolut_pay_called === true || body.forge_completed === true || body.skip_status_sync === true) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "Cannot forge completion or invoke /pay from finalize edge",
      revolut_pay_called: false,
    }, 200);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const transferId = String(body.transfer_id ?? "").trim();
  if (!transferId) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "transfer_id is required",
      revolut_pay_called: false,
    }, 200);
  }

  const { data: transfer } = await supabase
    .from("company_outgoing_transfers")
    .select("id, status, amount_pence, approved_amount_pence, currency, provider_transaction_id")
    .eq("id", transferId)
    .maybeSingle();

  if (!transfer) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "transfer not found",
      revolut_pay_called: false,
    }, 200);
  }

  const { data: intent } = await supabase
    .from("company_transfer_payment_intents")
    .select(
      "id, execution_status, provider_payment_id, provider_state, amount_pence, currency, " +
      "financially_applied_at",
    )
    .eq("transfer_id", transferId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: hold } = await supabase
    .from("company_funding_holds")
    .select("id, status, amount_pence, currency, consumed_at")
    .eq("transfer_id", transferId)
    .in("status", ["ACTIVE", "CONSUMED"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!intent?.provider_payment_id) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.MISSING_PROVIDER_PAYMENT_ID,
      message: "No provider payment id — transfer not submitted",
      revolut_pay_called: false,
      company_debited: false,
    }, 200);
  }

  const amount = Number(transfer.approved_amount_pence ?? transfer.amount_pence ?? 0);
  const eligibility = evaluateCompanyTransferCompletionEligibility({
    transfer_status: transfer.status,
    intent_status: intent.execution_status,
    hold_status: hold?.status ?? null,
    transfer_amount_pence: amount,
    hold_amount_pence: hold?.amount_pence ?? null,
    intent_amount_pence: intent.amount_pence,
    currency: transfer.currency,
    intent_provider_payment_id: intent.provider_payment_id,
    financially_applied: Boolean(intent.financially_applied_at),
    hold_consumed: hold?.status === "CONSUMED",
  });
  if (!eligibility.ok) {
    return json({
      ok: false,
      error: eligibility.code,
      message: eligibility.message,
      revolut_pay_called: false,
      company_debited: false,
    }, 200);
  }

  if (!isRevolutBusinessRelayConfigured()) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.RELAY_UNREACHABLE,
      revolut_pay_called: false,
    }, 200);
  }

  let accessToken: string;
  try {
    const tok = await ensureFreshRevolutBusinessAccessToken(supabase);
    accessToken = tok.accessToken;
  } catch (err) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.ACCESS_TOKEN_REQUIRED,
      message: err instanceof Error ? err.message : "token unavailable",
      revolut_pay_called: false,
    }, 200);
  }

  const payBlocked = await relayProbePayBlocked();
  if (!payBlocked.blocked) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "Raw /pay must remain blocked on relay",
      revolut_pay_called: false,
    }, 200);
  }

  const statusResult = await relayCompanyTransferPaymentStatus({
    providerPaymentId: String(intent.provider_payment_id),
    transferId,
    accessToken,
  });

  const providerState = statusResult.provider_state;
  const finaliseGate = mayFinaliseCompanyTransferFromProviderState(providerState);
  if (!finaliseGate.ok) {
    await supabase.rpc("sync_company_transfer_provider_status", {
      p_transfer_id: transferId,
      p_provider_payment_id: String(intent.provider_payment_id),
      p_provider_state: providerState,
      p_provider_completed_at: statusResult.completed_at,
      p_evidence_redacted: redactCompanyTransferCompletionEvidence({
        provider_payment_id: intent.provider_payment_id,
        provider_state: providerState,
        provider_completed_at: statusResult.completed_at,
        http_status: statusResult.status,
      }),
    });
    return json({
      ok: false,
      error: finaliseGate.code,
      message: finaliseGate.message,
      provider_state: providerState,
      revolut_pay_called: false,
      company_debited: false,
      hold_consumed: false,
    }, 200);
  }

  if (!isCanonicalProviderCompleted(providerState)) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.PROVIDER_NOT_COMPLETED,
      revolut_pay_called: false,
      company_debited: false,
    }, 200);
  }

  const evidence = redactCompanyTransferCompletionEvidence({
    provider_payment_id: intent.provider_payment_id,
    provider_state: providerState,
    provider_completed_at: statusResult.completed_at,
    http_status: statusResult.status,
  });

  const { data: finalizeRaw, error: finalizeErr } = await supabase.rpc(
    "finalize_company_transfer_completion",
    {
      p_transfer_id: transferId,
      p_provider_payment_id: String(intent.provider_payment_id),
      p_provider_state: providerState,
      p_provider_completed_at: statusResult.completed_at,
      p_evidence_redacted: evidence,
    },
  );

  if (finalizeErr) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: finalizeErr.message,
      revolut_pay_called: false,
    }, 500);
  }

  const finalize = (finalizeRaw ?? {}) as Record<string, unknown>;
  assertSlice12CompletionMoneySafety({
    revolut_pay_called: false,
    forged_completed: false,
    driver_wallet_mutated: false,
  });

  return json({
    ok: finalize.ok === true,
    slice: 12,
    transfer_id: transferId,
    provider_state: providerState,
    provider_payment_id: intent.provider_payment_id,
    company_debited: finalize.company_debited === true,
    hold_consumed: finalize.hold_consumed === true,
    money_moved: finalize.money_moved === true,
    revolut_pay_called: false,
    finalize,
  }, finalize.ok === true ? 200 : 409);
});
