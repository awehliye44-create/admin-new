/**
 * Slice 8 — Admin-controlled finalisation of a SUBMITTED Revolut payout.
 * Polls Revolut transaction status via relay (read-only). Only canonical
 * `completed` may consume reservation + debit wallet. Never calls /pay.
 * LIVE_PAYOUT_EXECUTION_ENABLED must stay false.
 *
 * POST {
 *   payout_item_id: string,
 *   confirm_finalize?: true   // required safety latch
 * }
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  assertSlice8MoneySafety,
  COMPLETION_ERROR,
  evaluateCompletionEligibility,
  evaluateSlice8FlagGate,
  isCanonicalProviderCompleted,
  mayFinaliseFromProviderState,
  redactCompletionEvidence,
  SLICE8_PROOF_DRIVERS,
} from "../_shared/driverPayoutCompletionSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayApprovedDriverPayoutPaymentStatus,
  relayProbePayBlocked,
} from "../_shared/revolutBusinessRelayClient.ts";
import { ensureFreshRevolutBusinessAccessToken } from "../_shared/revolutBusinessAccessTokenRefresh.ts";
import {
  assertPayoutItemLedgerLineage,
  PAYOUT_LINEAGE_MISSING,
} from "../_shared/payoutItemLedgerAllocationWrite.ts";

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
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const flagGate = evaluateSlice8FlagGate(Deno.env);
  if (!flagGate.ok) {
    return json({
      ok: false,
      error: flagGate.code,
      message: flagGate.message,
      live_payout_execution_enabled: true,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
    }, 503);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (body.confirm_finalize !== true) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "confirm_finalize:true is required for Slice 8 finalisation",
      revolut_pay_called: false,
      wallet_debited: false,
    }, 400);
  }

  // Hard reject any attempt to forge pay / skip status sync via this edge.
  if (
    body.revolut_pay_called === true ||
    body.forge_completed === true ||
    body.skip_status_sync === true
  ) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "Cannot forge completion, skip status sync, or invoke /pay from finalize edge",
      revolut_pay_called: false,
      wallet_debited: false,
    }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const payoutItemId = body.payout_item_id
    ? String(body.payout_item_id).trim()
    : SLICE8_PROOF_DRIVERS.BOSTEYO_ITEM_HINT;

  // Safety: never finalise Ahmed on this proof path unless explicitly named elsewhere.
  const { data: item, error: itemErr } = await supabase
    .from("payout_items")
    .select("id, driver_id, amount_pence, currency, status, execution_status, batch_id")
    .eq("id", payoutItemId)
    .maybeSingle();

  if (itemErr || !item) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "payout item not found",
      revolut_pay_called: false,
    }, 404);
  }

  try {
    await assertPayoutItemLedgerLineage({
      supabase,
      payout_item_id: payoutItemId,
      expected_amount_pence: Number(item.amount_pence ?? 0),
    });
  } catch (lineageErr) {
    return json({
      ok: false,
      error: PAYOUT_LINEAGE_MISSING,
      message: lineageErr instanceof Error ? lineageErr.message : PAYOUT_LINEAGE_MISSING,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
    }, 409);
  }

  if (String(item.driver_id) === SLICE8_PROOF_DRIVERS.AHMED_ID) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "Ahmed finalisation blocked in Slice 8 proof path — leave reservation ACTIVE",
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      driver_id: item.driver_id,
    }, 403);
  }

  const { data: intent } = await supabase
    .from("driver_payout_payment_intents")
    .select(
      "id, execution_status, provider_payment_id, provider_state, provider_request_id, amount_pence, currency, driver_id, financially_applied_at, financial_application_ledger_entry_id, provider_completed_at",
    )
    .eq("payout_item_id", payoutItemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: reservation } = await supabase
    .from("driver_payout_reservations")
    .select(
      "id, status, amount_pence, currency, driver_id, debit_ledger_entry_id, consumed_at",
    )
    .eq("payout_item_id", payoutItemId)
    .in("status", ["ACTIVE", "CONSUMED"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!intent?.provider_payment_id) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.MISSING_PROVIDER_PAYMENT_ID,
      message: "No provider_payment_id on intent — cannot poll or finalise",
      revolut_pay_called: false,
      wallet_debited: false,
    }, 409);
  }

  const eligibility = evaluateCompletionEligibility({
    item_status: item.status,
    intent_status: intent.execution_status,
    reservation_status: reservation?.status,
    item_amount_pence: item.amount_pence,
    reservation_amount_pence: reservation?.amount_pence,
    intent_amount_pence: intent.amount_pence,
    currency: item.currency,
    intent_currency: intent.currency,
    reservation_currency: reservation?.currency,
    driver_id: item.driver_id,
    reservation_driver_id: reservation?.driver_id,
    intent_driver_id: intent.driver_id,
    intent_provider_payment_id: intent.provider_payment_id,
    financially_applied: Boolean(intent.financially_applied_at),
    reservation_consumed: String(reservation?.status ?? "") === "CONSUMED",
  });

  // Already applied → return reuse without re-polling hard fail (still sync optional).
  if (
    !eligibility.ok &&
    eligibility.code === COMPLETION_ERROR.ALREADY_APPLIED
  ) {
    const { data: reuse } = await supabase.rpc("finalize_driver_payout_completion", {
      p_payout_item_id: payoutItemId,
      p_provider_payment_id: intent.provider_payment_id,
      p_provider_state: "completed",
      p_provider_completed_at: intent.provider_completed_at,
      p_evidence_redacted: redactCompletionEvidence({
        provider_payment_id: intent.provider_payment_id,
        provider_state: "completed",
        provider_request_id: intent.provider_request_id,
        completed_at: intent.provider_completed_at,
        amount_pence: item.amount_pence,
        currency: item.currency,
      }),
    });
    return json({
      ok: true,
      already_applied: true,
      reused: true,
      ...(typeof reuse === "object" && reuse ? reuse : {}),
      revolut_pay_called: false,
      live_payout_execution_enabled: false,
      slice: 8,
    });
  }

  if (!eligibility.ok && eligibility.code !== COMPLETION_ERROR.INVARIANT_PARTIAL_STATE) {
    return json({
      ok: false,
      error: eligibility.code,
      message: eligibility.message,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
    }, 409);
  }

  if (!isRevolutBusinessRelayConfigured()) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.RELAY_UNREACHABLE,
      message: "Revolut Business relay not configured",
      revolut_pay_called: false,
    }, 503);
  }

  const payProbe = await relayProbePayBlocked();
  if (!payProbe.blocked) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.VALIDATION_FAILED,
      message: "Safety: raw /pay must remain blocked on relay",
      revolut_pay_called: false,
    }, 503);
  }

  let accessToken: string;
  try {
    const tokenResult = await ensureFreshRevolutBusinessAccessToken(supabase);
    accessToken = String(tokenResult.accessToken ?? "").trim();
    if (!accessToken) throw new Error("access_token_empty");
  } catch (err) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.ACCESS_TOKEN_REQUIRED,
      message: err instanceof Error ? err.message : "access token unavailable",
      revolut_pay_called: false,
    }, 503);
  }

  const statusResult = await relayApprovedDriverPayoutPaymentStatus({
    providerPaymentId: String(intent.provider_payment_id),
    accessToken,
    payoutItemId,
  });

  if (statusResult.status === 0 || statusResult.error === "relay_unreachable" ||
    statusResult.error === "relay_timeout") {
    return json({
      ok: false,
      error: COMPLETION_ERROR.RELAY_UNREACHABLE,
      message: statusResult.error ?? "relay unreachable",
      revolut_pay_called: false,
      wallet_debited: false,
    }, 503);
  }

  if (statusResult.status < 200 || statusResult.status >= 300 || !statusResult.provider_state) {
    // Touch sync timestamp only — never clear an existing provider_state with null.
    await supabase
      .from("driver_payout_payment_intents")
      .update({
        last_provider_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", intent.id);

    return json({
      ok: false,
      error: COMPLETION_ERROR.STATUS_SYNC_FAILED,
      message: statusResult.error ?? `status http ${statusResult.status}`,
      provider_payment_id_masked: statusResult.provider_payment_id
        ? `${String(statusResult.provider_payment_id).slice(0, 4)}…${String(statusResult.provider_payment_id).slice(-4)}`
        : null,
      provider_state: statusResult.provider_state,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      note: "Relay status path may be undeployed — do not forge completed or debit",
    }, 502);
  }

  // Persist synced state before finalize decision (pending stays pending).
  await supabase
    .from("driver_payout_payment_intents")
    .update({
      provider_state: statusResult.provider_state,
      last_provider_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", intent.id);

  const mayFinalise = mayFinaliseFromProviderState(statusResult.provider_state);
  if (!mayFinalise.ok) {
    return json({
      ok: false,
      error: mayFinalise.code,
      message: mayFinalise.message,
      provider_state: statusResult.provider_state,
      provider_payment_id_masked:
        `${String(intent.provider_payment_id).slice(0, 4)}…${String(intent.provider_payment_id).slice(-4)}`,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      financially_applied: false,
      live_payout_execution_enabled: false,
      slice: 8,
    }, 409);
  }

  if (!isCanonicalProviderCompleted(statusResult.provider_state)) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.PROVIDER_NOT_COMPLETED,
      message: "Refusing to finalise without canonical completed",
      revolut_pay_called: false,
      wallet_debited: false,
    }, 409);
  }

  const evidence = redactCompletionEvidence({
    provider_payment_id: intent.provider_payment_id,
    provider_state: statusResult.provider_state,
    provider_request_id: intent.provider_request_id,
    completed_at: statusResult.completed_at,
    amount_pence: item.amount_pence,
    currency: item.currency,
  });

  const { data: finalized, error: finalizeErr } = await supabase.rpc(
    "finalize_driver_payout_completion",
    {
      p_payout_item_id: payoutItemId,
      p_provider_payment_id: String(intent.provider_payment_id),
      p_provider_state: "completed",
      p_provider_completed_at: statusResult.completed_at,
      p_evidence_redacted: evidence,
    },
  );

  if (finalizeErr) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.INVARIANT_PARTIAL_STATE,
      message: finalizeErr.message,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      note: "TX failed — safe to retry same finalisation; do not create another Revolut payment",
    }, 500);
  }

  const result = (typeof finalized === "object" && finalized ? finalized : {}) as Record<
    string,
    unknown
  >;

  if (result.ok === false) {
    return json({
      ...result,
      revolut_pay_called: false,
      live_payout_execution_enabled: false,
      slice: 8,
    }, result.error === "PROVIDER_NOT_COMPLETED" ? 409 : 400);
  }

  try {
    assertSlice8MoneySafety({
      provider_state: "completed",
      wallet_debited: result.wallet_debited === true,
      reservation_consumed: result.reservation_consumed === true,
      live_payout_execution_enabled: false,
      revolut_pay_called: false,
      forged_completion: false,
    });
  } catch (err) {
    return json({
      ok: false,
      error: COMPLETION_ERROR.INVARIANT_PARTIAL_STATE,
      message: err instanceof Error ? err.message : "slice8 invariant",
      result,
    }, 500);
  }

  return json({
    ok: true,
    ...result,
    revolut_pay_called: false,
    live_payout_execution_enabled: false,
    revolut_payment_transport_enabled:
      (Deno.env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").toLowerCase() === "true",
    provider_state_synced: statusResult.provider_state,
    evidence_redacted: evidence,
    slice: 8,
  });
});
