/**
 * Admin Slice 4 dry-run: validate Revolut driver-payout payment transport + idempotency.
 * Creates/reuses driver_payout_payment_intents at VALIDATED (or BLOCKED).
 * Never reserves wallets, never creates batches, never calls Revolut POST /pay.
 *
 * POST {
 *   driver_id, payout_destination_id, source_account_id,
 *   amount_pence?, payout_item_id?, payment_reference?,
 *   dry_run?: true
 * }
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  IDEMPOTENCY_CONFLICT,
  PAYMENT_EXECUTION_DISABLED,
  assertSlice4MoneySafety,
  canonicalIdempotencyKey,
  canonicalProviderRequestId,
  isLivePayoutExecutionEnabled,
  isRevolutPaymentTransportEnabled,
  mayCallRevolutPayEndpoint,
  resolvePaymentIntentIdempotency,
  revolutBusinessPayContractVerified,
  slice4IntentStatusAfterValidation,
  validateApprovedDriverPayoutPayment,
  type ExistingPaymentIntent,
} from "../_shared/revolutDriverPayoutPaymentSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  probeRelayPublicHealth,
  relayApprovedDriverPayoutPayment,
  relayProbePayBlocked,
} from "../_shared/revolutBusinessRelayClient.ts";
import { resolveGrantedRevolutBusinessScopes } from "../_shared/driverPayoutProviderLinkageSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Content-Type": "application/json",
};

function mapIntent(row: Record<string, unknown>): ExistingPaymentIntent {
  return {
    id: String(row.id),
    payout_item_id: String(row.payout_item_id),
    driver_id: String(row.driver_id),
    payout_destination_id: String(row.payout_destination_id),
    provider_request_id: String(row.provider_request_id),
    idempotency_key: String(row.idempotency_key),
    source_account_id: String(row.source_account_id),
    provider_counterparty_id: String(row.provider_counterparty_id),
    provider_recipient_account_id: String(row.provider_recipient_account_id),
    amount_pence: Number(row.amount_pence),
    currency: String(row.currency),
    payment_reference: row.payment_reference == null ? null : String(row.payment_reference),
    execution_status: String(row.execution_status),
    provider_payment_id: row.provider_payment_id == null ? null : String(row.provider_payment_id),
    request_fingerprint: String(row.request_fingerprint),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  const live = isLivePayoutExecutionEnabled();
  const transport = isRevolutPaymentTransportEnabled();
  if (live || transport || mayCallRevolutPayEndpoint()) {
    return new Response(JSON.stringify({
      ok: false,
      error: "slice4_refuses_enabled_execution_flags",
      live_payout_execution_enabled: live,
      revolut_payment_transport_enabled: transport,
      revolut_pay_called: false,
    }), { status: 503, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  const driverId = String(body.driver_id ?? "").trim();
  const destinationId = String(body.payout_destination_id ?? "").trim();
  const sourceAccountId = String(body.source_account_id ?? "").trim();
  if (!driverId || !destinationId || !sourceAccountId) {
    return new Response(JSON.stringify({
      ok: false,
      error: "driver_id, payout_destination_id, and source_account_id are required",
      revolut_pay_called: false,
    }), { status: 400, headers: corsHeaders });
  }

  const payoutItemId = String(body.payout_item_id ?? crypto.randomUUID()).trim();
  const amountPence = body.amount_pence == null ? 1 : Number(body.amount_pence);

  const { data: dest, error: destErr } = await supabase
    .from("driver_payout_destinations")
    .select(
      "id, driver_id, currency_code, verification_status, provider_link_status, provider_counterparty_id, provider_recipient_account_id, is_active, archived_at",
    )
    .eq("id", destinationId)
    .maybeSingle();

  if (destErr || !dest) {
    return new Response(JSON.stringify({
      ok: false,
      error: "destination_not_found",
      revolut_pay_called: false,
    }), { status: 404, headers: corsHeaders });
  }

  const paymentBody: Record<string, unknown> = {
    payout_item_id: payoutItemId,
    driver_id: driverId,
    payout_destination_id: destinationId,
    source_account_id: sourceAccountId,
    provider_counterparty_id: dest.provider_counterparty_id,
    provider_recipient_account_id: dest.provider_recipient_account_id,
    amount_pence: amountPence,
    currency: "GBP",
    payment_reference: body.payment_reference ?? `slice4-dry-run:${payoutItemId.slice(0, 8)}`,
    provider_request_id: canonicalProviderRequestId(payoutItemId),
    idempotency_key: canonicalIdempotencyKey(payoutItemId),
    dry_run: true,
  };

  // Allow caller to override provider ids only if they match destination (validated below).
  if (typeof body.provider_counterparty_id === "string") {
    paymentBody.provider_counterparty_id = body.provider_counterparty_id;
  }
  if (typeof body.provider_recipient_account_id === "string") {
    paymentBody.provider_recipient_account_id = body.provider_recipient_account_id;
  }

  const validated = validateApprovedDriverPayoutPayment({
    body: paymentBody,
    destination: dest,
  });
  if (!validated.ok) {
    return new Response(JSON.stringify({
      ok: false,
      error: validated.code,
      message: validated.message,
      details: validated.details ?? null,
      execution_status: null,
      revolut_pay_called: false,
      provider_payment_id: null,
      wallet_mutated: false,
      live_payout_execution_enabled: false,
      revolut_payment_transport_enabled: false,
    }), { status: 400, headers: corsHeaders });
  }

  const n = validated.normalized;

  const { data: byKeyRow } = await supabase
    .from("driver_payout_payment_intents")
    .select("*")
    .eq("idempotency_key", n.idempotency_key)
    .maybeSingle();

  const { data: byItemRow } = await supabase
    .from("driver_payout_payment_intents")
    .select("*")
    .eq("payout_item_id", n.payout_item_id)
    .in("execution_status", ["DRAFT", "VALIDATED", "BLOCKED", "READY", "SUBMITTING", "SUBMITTED"])
    .maybeSingle();

  const decision = resolvePaymentIntentIdempotency({
    normalized: n,
    existingByIdempotencyKey: byKeyRow ? mapIntent(byKeyRow) : null,
    existingActiveByPayoutItemId: byItemRow ? mapIntent(byItemRow) : null,
  });

  if (decision.action === "conflict") {
    return new Response(JSON.stringify({
      ok: false,
      error: IDEMPOTENCY_CONFLICT,
      code: IDEMPOTENCY_CONFLICT,
      message: decision.message,
      existing_intent_id: decision.intent?.id ?? null,
      revolut_pay_called: false,
      provider_payment_id: null,
      wallet_mutated: false,
    }), { status: 409, headers: corsHeaders });
  }

  let intent = decision.action === "reuse" ? decision.intent : null;
  let reused = decision.action === "reuse";

  if (decision.action === "create") {
    const statusInfo = slice4IntentStatusAfterValidation();
    const insertRow = {
      payout_item_id: n.payout_item_id,
      driver_id: n.driver_id,
      payout_destination_id: n.payout_destination_id,
      provider: "revolut_business",
      provider_request_id: n.provider_request_id,
      idempotency_key: n.idempotency_key,
      source_account_id: n.source_account_id,
      provider_counterparty_id: n.provider_counterparty_id,
      provider_recipient_account_id: n.provider_recipient_account_id,
      amount_pence: n.amount_pence,
      currency: n.currency,
      payment_reference: n.payment_reference,
      execution_status: statusInfo.status,
      provider_payment_id: null,
      provider_state: null,
      provider_failure_code: statusInfo.failure_code,
      provider_failure_reason_safe: statusInfo.failure_reason_safe,
      request_fingerprint: n.request_fingerprint,
    };
    const { data: created, error: insErr } = await supabase
      .from("driver_payout_payment_intents")
      .insert(insertRow)
      .select("*")
      .single();
    if (insErr || !created) {
      return new Response(JSON.stringify({
        ok: false,
        error: "intent_insert_failed",
        message: insErr?.message ?? "insert failed",
        revolut_pay_called: false,
        hint: "Apply migration 20260831180000_driver_payout_payment_intent.sql",
      }), { status: 500, headers: corsHeaders });
    }
    intent = mapIntent(created);
  }

  // Hit approved relay payment op — must return PAYMENT_EXECUTION_DISABLED without calling /pay.
  let relayResult: {
    status: number;
    error: string | null;
    revolut_pay_called: boolean;
    provider_payment_id: string | null;
  } = {
    status: 0,
    error: "relay_skipped",
    revolut_pay_called: false,
    provider_payment_id: null,
  };
  if (isRevolutBusinessRelayConfigured()) {
    relayResult = await relayApprovedDriverPayoutPayment({
      body: {
        payout_item_id: n.payout_item_id,
        driver_id: n.driver_id,
        payout_destination_id: n.payout_destination_id,
        source_account_id: n.source_account_id,
        provider_counterparty_id: n.provider_counterparty_id,
        provider_recipient_account_id: n.provider_recipient_account_id,
        amount_pence: n.amount_pence,
        currency: n.currency,
        payment_reference: n.payment_reference,
        provider_request_id: n.provider_request_id,
        idempotency_key: n.idempotency_key,
      },
      idempotencyKey: n.idempotency_key,
    });
  }

  const payProbe = isRevolutBusinessRelayConfigured()
    ? await relayProbePayBlocked()
    : { blocked: true, status: 0, error: "relay_not_configured" };
  const health = await probeRelayPublicHealth();
  const scopes = await resolveGrantedRevolutBusinessScopes(supabase);

  assertSlice4MoneySafety({
    revolut_pay_called: relayResult.revolut_pay_called === true,
    wallet_mutated: false,
    live_payout_execution_enabled: live,
    payment_transport_enabled: transport,
    provider_payment_id: intent?.provider_payment_id ?? relayResult.provider_payment_id,
  });

  const executionDisabled =
    relayResult.error === PAYMENT_EXECUTION_DISABLED
    || relayResult.error === "PAYMENT_EXECUTION_DISABLED"
    || !isRevolutBusinessRelayConfigured();

  return new Response(JSON.stringify({
    ok: true,
    slice: 4,
    dry_run: true,
    reused,
    intent: intent
      ? {
        id: intent.id,
        payout_item_id: intent.payout_item_id,
        execution_status: intent.execution_status,
        provider_request_id: intent.provider_request_id,
        idempotency_key: intent.idempotency_key,
        amount_pence: intent.amount_pence,
        currency: intent.currency,
        provider_payment_id: intent.provider_payment_id,
        source_account_id_present: Boolean(intent.source_account_id),
        provider_counterparty_id_masked: intent.provider_counterparty_id
          ? `${intent.provider_counterparty_id.slice(0, 4)}…`
          : null,
        provider_recipient_account_id_masked: intent.provider_recipient_account_id
          ? `${intent.provider_recipient_account_id.slice(0, 4)}…`
          : null,
      }
      : null,
    dry_run_payload_built: true,
    dry_run_payload_keys: Object.keys(n.dry_run_payload),
    relay: {
      approved_op_status: relayResult.status,
      approved_op_error: relayResult.error,
      execution_disabled: executionDisabled,
      revolut_pay_called: relayResult.revolut_pay_called,
      raw_pay_blocked: payProbe.blocked,
      raw_pay_status: payProbe.status,
      health_mode: health.mode,
      health_live_payout: health.live_payout_execution_enabled,
    },
    oauth_scopes_granted: scopes,
    revolut_pay_contract: revolutBusinessPayContractVerified(),
    live_payout_execution_enabled: false,
    revolut_payment_transport_enabled: false,
    wallet_mutated: false,
    batch_created: false,
    slices_5_to_12_started: false,
  }), { status: 200, headers: corsHeaders });
});
