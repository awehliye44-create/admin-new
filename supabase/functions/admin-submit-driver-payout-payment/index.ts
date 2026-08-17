/**
 * Slice 7 — Admin-controlled single-item Revolut Business payout submission.
 * Requires REVOLUT_PAYMENT_TRANSPORT_ENABLED=true and LIVE_PAYOUT_EXECUTION_ENABLED=false.
 * Atomic claim → validated relay /pay → finalize. Never permanently debits wallets.
 *
 * POST {
 *   payout_item_id?: string,
 *   driver_id?: string,              // resolve RESERVED item for driver in batch
 *   batch_id?: string,
 *   schedule_occurrence_key?: string,
 *   confirm_submit?: true            // required safety latch
 * }
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  canonicalIdempotencyKey,
  canonicalProviderRequestId,
  validateApprovedDriverPayoutPayment,
} from "../_shared/revolutDriverPayoutPaymentSSOT.ts";
import {
  assertSlice7MoneySafety,
  evaluateSlice7FlagGate,
  evaluateSourceAccountGate,
  mapProviderSubmissionOutcome,
  maskProviderId,
  redactProviderEvidence,
  rejectCompanyOrArbitraryPayment,
  SLICE7_PROOF_DRIVERS,
  SUBMISSION_ERROR,
} from "../_shared/driverPayoutSubmissionSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayApprovedDriverPayoutPayment,
  relayProbePayBlocked,
} from "../_shared/revolutBusinessRelayClient.ts";
import { resolveLiveCompanyBalanceSnapshot } from "../_shared/companyBalanceResolveSSOT.ts";
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

  const flagGate = evaluateSlice7FlagGate(Deno.env);
  if (!flagGate.ok) {
    return json({
      ok: false,
      error: flagGate.code,
      message: flagGate.message,
      live_payout_execution_enabled: (Deno.env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false")
        .toLowerCase() === "true",
      revolut_payment_transport_enabled: (Deno.env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false")
        .toLowerCase() === "true",
      revolut_pay_called: false,
      wallet_debited: false,
      slices_8_to_12_started: false,
    }, 503);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const blocked = rejectCompanyOrArbitraryPayment(body);
  if (!blocked.ok) {
    return json({
      ok: false,
      error: blocked.code,
      message: blocked.message,
      revolut_pay_called: false,
      wallet_debited: false,
    }, 400);
  }

  if (body.confirm_submit !== true) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.VALIDATION_FAILED,
      message: "confirm_submit:true is required for Slice 7 provider submission",
      revolut_pay_called: false,
    }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const payoutItemIdHint = body.payout_item_id ? String(body.payout_item_id).trim() : null;
  const driverIdHint = body.driver_id ? String(body.driver_id).trim() : null;
  const batchIdHint = body.batch_id ? String(body.batch_id).trim() : null;
  const occurrenceKey = String(
    body.schedule_occurrence_key ?? SLICE7_PROOF_DRIVERS.OCCURRENCE_KEY,
  ).trim();

  let payoutItemId = payoutItemIdHint;
  if (!payoutItemId) {
    let batchQuery = supabase
      .from("payout_batches")
      .select("id, status, schedule_occurrence_key")
      .limit(1);
    if (batchIdHint) batchQuery = batchQuery.eq("id", batchIdHint);
    else batchQuery = batchQuery.eq("schedule_occurrence_key", occurrenceKey);
    const { data: batch } = await batchQuery.maybeSingle();
    if (!batch) {
      return json({
        ok: false,
        error: SUBMISSION_ERROR.BATCH_NOT_ELIGIBLE,
        message: "batch not found",
        revolut_pay_called: false,
      }, 404);
    }
    if (!driverIdHint) {
      return json({
        ok: false,
        error: SUBMISSION_ERROR.VALIDATION_FAILED,
        message: "payout_item_id or driver_id required",
        revolut_pay_called: false,
      }, 400);
    }
    const { data: item } = await supabase
      .from("payout_items")
      .select("id, status, amount_pence, driver_id")
      .eq("batch_id", batch.id)
      .eq("driver_id", driverIdHint)
      .eq("status", "RESERVED")
      .maybeSingle();
    if (!item) {
      return json({
        ok: false,
        error: SUBMISSION_ERROR.PAYOUT_ITEM_NOT_RESERVED,
        message: "RESERVED payout item not found for driver",
        revolut_pay_called: false,
      }, 404);
    }
    payoutItemId = String(item.id);
  }

  // Source account only from Company Balance SSOT — never from request body.
  if (body.source_account_id) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.ARBITRARY_PAYMENT_BLOCKED,
      message: "Frontend/source_account_id override rejected — Company Balance SSOT only",
      revolut_pay_called: false,
    }, 400);
  }

  const companyBalance = await resolveLiveCompanyBalanceSnapshot({
    supabase,
    currency: "GBP",
    refresh: true,
  });
  if (!companyBalance.source_account_id) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.MISSING_SOURCE_ACCOUNT,
      message: "Company Balance SSOT source account not configured",
      company_balance_status: companyBalance.status_code,
      source_account_label: companyBalance.source_account_label,
      revolut_pay_called: false,
    }, 409);
  }
  if (companyBalance.status_code !== "AVAILABLE") {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.SOURCE_BALANCE_UNAVAILABLE,
      message: `Company Balance not AVAILABLE (${companyBalance.status_code})`,
      company_balance_status: companyBalance.status_code,
      source_account_label: companyBalance.source_account_label,
      revolut_pay_called: false,
      wallet_debited: false,
    }, 409);
  }

  const { data: itemRow } = await supabase
    .from("payout_items")
    .select("id, amount_pence, driver_id, status, currency, batch_id, payout_destination_id")
    .eq("id", payoutItemId)
    .maybeSingle();
  if (!itemRow) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.PAYOUT_ITEM_NOT_RESERVED,
      message: "payout item not found",
      revolut_pay_called: false,
    }, 404);
  }

  const amountGate = evaluateSourceAccountGate({
    source_account_id: companyBalance.source_account_id,
    currency: "GBP",
    available_pence: companyBalance.provider_available_balance_pence
      ?? companyBalance.provider_cash_balance_pence,
    amount_pence: Number(itemRow.amount_pence),
    account_active: true,
  });
  if (!amountGate.ok) {
    return json({
      ok: false,
      error: amountGate.code,
      message: amountGate.message,
      company_balance_status: companyBalance.status_code,
      source_account_label: companyBalance.source_account_label,
      revolut_pay_called: false,
      wallet_debited: false,
    }, 409);
  }

  let accessToken: string;
  try {
    const tok = await ensureFreshRevolutBusinessAccessToken(supabase);
    accessToken = tok.accessToken;
  } catch (err) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.ACCESS_TOKEN_REQUIRED,
      message: err instanceof Error ? err.message : "access token unavailable",
      revolut_pay_called: false,
    }, 503);
  }

  const { data: claimRaw, error: claimErr } = await supabase.rpc(
    "claim_driver_payout_submission",
    {
      p_payout_item_id: payoutItemId,
      p_source_account_id: amountGate.source_account_id,
      p_claim_token: crypto.randomUUID(),
    },
  );
  if (claimErr) {
    return json({
      ok: false,
      error: "claim_rpc_failed",
      message: claimErr.message,
      revolut_pay_called: false,
      hint: "Apply migration 20260831210000_driver_payout_provider_submission_slice7.sql",
    }, 500);
  }
  const claim = (claimRaw ?? {}) as Record<string, unknown>;
  if (claim.ok !== true) {
    // Idempotent reuse: already-SUBMITTED item must return existing execution,
    // never call Revolut again.
    if (String(claim.error ?? "") === SUBMISSION_ERROR.ALREADY_SUBMITTED) {
      const { data: existingIntent } = await supabase
        .from("driver_payout_payment_intents")
        .select(
          "execution_status, provider_payment_id, provider_state, provider_request_id, amount_pence",
        )
        .eq("payout_item_id", payoutItemId)
        .eq("execution_status", "SUBMITTED")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data: existingReservation } = await supabase
        .from("driver_payout_reservations")
        .select("status, amount_pence")
        .eq("payout_item_id", payoutItemId)
        .eq("status", "ACTIVE")
        .maybeSingle();
      const [liveRes, availRes, reservedRes] = await Promise.all([
        supabase.rpc("driver_wallet_live_balance_pence", { p_driver_id: itemRow.driver_id }),
        supabase.rpc("driver_wallet_available_for_payout_pence", { p_driver_id: itemRow.driver_id }),
        supabase.rpc("driver_wallet_active_reservation_pence", { p_driver_id: itemRow.driver_id }),
      ]);
      const paymentId = (existingIntent?.provider_payment_id as string | null) ?? null;
      assertSlice7MoneySafety({
        wallet_debited: false,
        reservation_consumed: false,
        paid_marked: false,
        live_payout_execution_enabled: false,
        slices_8_to_12_started: false,
      });
      return json({
        ok: true,
        slice: 7,
        reused_existing_execution: true,
        payout_item_id: payoutItemId,
        driver_id: itemRow.driver_id,
        amount_pence: Number(itemRow.amount_pence),
        execution_status: existingIntent?.execution_status ?? "SUBMITTED",
        item_status: "SUBMITTED",
        provider_payment_id: paymentId,
        provider_payment_id_masked: maskProviderId(paymentId),
        provider_state: (existingIntent?.provider_state as string | null) ?? null,
        provider_request_id: (existingIntent?.provider_request_id as string | null)
          ?? canonicalProviderRequestId(payoutItemId),
        reservation_status: existingReservation?.status ?? null,
        reservation_active: String(existingReservation?.status ?? "") === "ACTIVE",
        wallet: {
          live_balance_pence: Number(liveRes.data ?? 0),
          available_pence: Number(availRes.data ?? 0),
          reserved_pence: Number(reservedRes.data ?? 0),
          paid_pence: 0,
          wallet_debited: false,
        },
        paid: false,
        wallet_debit_applied: false,
        revolut_pay_called: false,
        wallet_debited: false,
        live_payout_execution_enabled: false,
        revolut_payment_transport_enabled: true,
        slices_8_to_12_started: false,
        ahmed_not_submitted: itemRow.driver_id !== SLICE7_PROOF_DRIVERS.AHMED_ID,
        message: "Reused existing SUBMITTED execution — Revolut not called again",
      }, 200);
    }
    return json({
      ok: false,
      error: claim.error ?? SUBMISSION_ERROR.CLAIM_CONFLICT,
      message: claim.message ?? "claim failed",
      revolut_pay_called: false,
      wallet_debited: false,
    }, 409);
  }

  const paymentBody: Record<string, unknown> = {
    payout_item_id: String(claim.payout_item_id),
    driver_id: String(claim.driver_id),
    payout_destination_id: String(claim.payout_destination_id),
    source_account_id: String(claim.source_account_id),
    provider_counterparty_id: String(claim.provider_counterparty_id),
    provider_recipient_account_id: String(claim.provider_recipient_account_id),
    amount_pence: Number(claim.amount_pence),
    currency: String(claim.currency ?? "GBP"),
    payment_reference: claim.payment_reference ?? null,
    provider_request_id: canonicalProviderRequestId(String(claim.payout_item_id)),
    idempotency_key: canonicalIdempotencyKey(String(claim.payout_item_id)),
  };

  const { data: dest } = await supabase
    .from("driver_payout_destinations")
    .select(
      "id, driver_id, currency_code, verification_status, provider_link_status, provider_counterparty_id, provider_recipient_account_id, is_active, archived_at",
    )
    .eq("id", String(claim.payout_destination_id))
    .maybeSingle();

  const validated = validateApprovedDriverPayoutPayment({
    body: paymentBody,
    destination: dest,
  });
  if (!validated.ok) {
    await supabase.rpc("finalize_driver_payout_submission", {
      p_payout_item_id: payoutItemId,
      p_claim_token: String(claim.claim_token),
      p_execution_status: "FAILED",
      p_provider_failure_code: validated.code,
      p_provider_failure_reason_safe: validated.message,
      p_evidence_redacted: { validation_failed: true },
      p_release_reservation: true,
    });
    return json({
      ok: false,
      error: validated.code,
      message: validated.message,
      revolut_pay_called: false,
      wallet_debited: false,
    }, 400);
  }

  if (!isRevolutBusinessRelayConfigured()) {
    await supabase.rpc("abort_driver_payout_submission_claim", {
      p_payout_item_id: payoutItemId,
      p_claim_token: String(claim.claim_token),
      p_failure_code: SUBMISSION_ERROR.RELAY_UNREACHABLE,
      p_failure_reason_safe: "relay not configured",
    });
    return json({
      ok: false,
      error: SUBMISSION_ERROR.RELAY_UNREACHABLE,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_kept_active: true,
    }, 503);
  }

  try {
    await assertPayoutItemLedgerLineage({
      supabase,
      payout_item_id: String(validated.normalized.payout_item_id),
      expected_amount_pence: Number(validated.normalized.amount_pence),
    });
  } catch (lineageErr) {
    await supabase.rpc("abort_driver_payout_submission_claim", {
      p_payout_item_id: payoutItemId,
      p_claim_token: String(claim.claim_token),
      p_failure_code: PAYOUT_LINEAGE_MISSING,
      p_failure_reason_safe: lineageErr instanceof Error
        ? lineageErr.message
        : PAYOUT_LINEAGE_MISSING,
    });
    return json({
      ok: false,
      error: PAYOUT_LINEAGE_MISSING,
      message: lineageErr instanceof Error ? lineageErr.message : PAYOUT_LINEAGE_MISSING,
      revolut_pay_called: false,
      wallet_debited: false,
    }, 409);
  }

  const relayStarted = Date.now();
  let timedOut = false;
  let relayResult: Awaited<ReturnType<typeof relayApprovedDriverPayoutPayment>>;
  try {
    relayResult = await relayApprovedDriverPayoutPayment({
      body: {
        payout_item_id: validated.normalized.payout_item_id,
        driver_id: validated.normalized.driver_id,
        payout_destination_id: validated.normalized.payout_destination_id,
        source_account_id: validated.normalized.source_account_id,
        provider_counterparty_id: validated.normalized.provider_counterparty_id,
        provider_recipient_account_id: validated.normalized.provider_recipient_account_id,
        amount_pence: validated.normalized.amount_pence,
        currency: validated.normalized.currency,
        payment_reference: validated.normalized.payment_reference,
        provider_request_id: validated.normalized.provider_request_id,
        idempotency_key: validated.normalized.idempotency_key,
      },
      idempotencyKey: validated.normalized.idempotency_key,
      accessToken,
      timeoutMs: 25_000,
    });
  } catch {
    timedOut = true;
    relayResult = {
      status: 0,
      error: "relay_timeout",
      revolut_pay_called: true,
      provider_payment_id: null,
      provider_state: null,
      json: {},
    };
  }
  if (relayResult.error === "relay_unreachable" || relayResult.status === 0) {
    timedOut = timedOut || Date.now() - relayStarted >= 20_000;
  }

  const providerPaymentId = relayResult.provider_payment_id
    ?? (typeof relayResult.json?.id === "string" ? String(relayResult.json.id) : null);
  const providerState = relayResult.provider_state
    ?? (typeof relayResult.json?.state === "string" ? String(relayResult.json.state) : null);
  const providerCreatedAt = typeof relayResult.json?.created_at === "string"
    ? String(relayResult.json.created_at)
    : null;

  // Failures before Revolut payment creation: abort claim, keep reservation.
  // Includes infra gates and relay validation (e.g. request_id shape) when /pay was never called.
  const infraAbortCodes = new Set([
    "PAYMENT_EXECUTION_DISABLED",
    SUBMISSION_ERROR.PAYMENT_TRANSPORT_DISABLED,
    "access_token_required",
    "relay_not_configured",
    "relay_unreachable",
    "LIVE_AUTOMATIC_EXECUTION_FORBIDDEN",
    "PROVIDER_REQUEST_ID_MISMATCH",
    "PROVIDER_REQUEST_ID_TOO_LONG",
    "IDEMPOTENCY_KEY_MISMATCH",
    "EXTRA_FIELDS_REJECTED",
    "validation_failed",
    "invalid_amount",
    "currency_not_gbp",
  ]);
  const prePayValidationFail =
    !timedOut
    && relayResult.revolut_pay_called !== true
    && !providerPaymentId
    && (
      infraAbortCodes.has(String(relayResult.error ?? ""))
      || relayResult.status === 403
      || (relayResult.status >= 400 && relayResult.status < 500)
    );
  if (prePayValidationFail) {
    await supabase.rpc("abort_driver_payout_submission_claim", {
      p_payout_item_id: payoutItemId,
      p_claim_token: String(claim.claim_token),
      p_failure_code: String(relayResult.error ?? SUBMISSION_ERROR.PAYMENT_TRANSPORT_DISABLED),
      p_failure_reason_safe: "Provider /pay not called — reservation kept ACTIVE",
    });
    return json({
      ok: false,
      error: String(relayResult.error ?? SUBMISSION_ERROR.PAYMENT_TRANSPORT_DISABLED),
      message: "Relay rejected before Revolut /pay — reservation kept ACTIVE",
      relay_error: relayResult.error,
      relay_status: relayResult.status,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_kept_active: true,
      slices_8_to_12_started: false,
    }, relayResult.status === 403 || relayResult.status === 0 ? 503 : 422);
  }

  const hardReject = relayResult.revolut_pay_called === true
    && relayResult.status >= 400
    && relayResult.status < 500
    && !timedOut
    && !providerPaymentId;

  const outcome = mapProviderSubmissionOutcome({
    http_ok: relayResult.status >= 200 && relayResult.status < 300,
    timed_out: timedOut || relayResult.error === "relay_timeout",
    provider_payment_id: providerPaymentId,
    provider_state: providerState,
    hard_reject: hardReject || relayResult.error === "PROVIDER_HARD_REJECT",
  });

  const evidence = redactProviderEvidence({
    provider_payment_id: providerPaymentId,
    provider_state: providerState,
    provider_request_id: validated.normalized.provider_request_id,
    http_status: relayResult.status,
    created_at: providerCreatedAt,
    failure_code: relayResult.error,
  });

  const { data: finalizeRaw, error: finalizeErr } = await supabase.rpc(
    "finalize_driver_payout_submission",
    {
      p_payout_item_id: payoutItemId,
      p_claim_token: String(claim.claim_token),
      p_execution_status: outcome.execution_status,
      p_provider_payment_id: providerPaymentId,
      p_provider_state: providerState,
      p_provider_created_at: providerCreatedAt,
      p_provider_failure_code: outcome.release_reservation
        ? (relayResult.error ?? SUBMISSION_ERROR.PROVIDER_HARD_REJECT)
        : null,
      p_provider_failure_reason_safe: outcome.release_reservation
        ? String(relayResult.json?.message ?? relayResult.error ?? "provider rejected").slice(0, 180)
        : null,
      p_evidence_redacted: evidence,
      p_release_reservation: outcome.release_reservation,
    },
  );
  if (finalizeErr) {
    return json({
      ok: false,
      error: "finalize_rpc_failed",
      message: finalizeErr.message,
      revolut_pay_called: relayResult.revolut_pay_called === true,
      provider_payment_id_masked: maskProviderId(providerPaymentId),
      provider_state: providerState,
      wallet_debited: false,
    }, 500);
  }

  const [liveRes, availRes, reservedRes] = await Promise.all([
    supabase.rpc("driver_wallet_live_balance_pence", { p_driver_id: itemRow.driver_id }),
    supabase.rpc("driver_wallet_available_for_payout_pence", { p_driver_id: itemRow.driver_id }),
    supabase.rpc("driver_wallet_active_reservation_pence", { p_driver_id: itemRow.driver_id }),
  ]);

  const { data: reservation } = await supabase
    .from("driver_payout_reservations")
    .select("id, status, amount_pence")
    .eq("payout_item_id", payoutItemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const rawPayProbe = await relayProbePayBlocked();

  assertSlice7MoneySafety({
    wallet_debited: false,
    reservation_consumed: String(reservation?.status ?? "") === "CONSUMED",
    paid_marked: false,
    live_payout_execution_enabled: false,
    slices_8_to_12_started: false,
  });

  const ok = outcome.execution_status === "SUBMITTED" || outcome.execution_status === "UNKNOWN";
  return json({
    ok,
    slice: 7,
    payout_item_id: payoutItemId,
    driver_id: itemRow.driver_id,
    amount_pence: Number(itemRow.amount_pence),
    claim_token_present: true,
    provider_request_id: validated.normalized.provider_request_id,
    execution_status: outcome.execution_status,
    item_status: outcome.item_status,
    provider_payment_id: providerPaymentId,
    provider_payment_id_masked: maskProviderId(providerPaymentId),
    provider_state: providerState,
    reservation_status: reservation?.status ?? null,
    reservation_active: String(reservation?.status ?? "") === "ACTIVE",
    wallet: {
      live_balance_pence: Number(liveRes.data ?? 0),
      available_pence: Number(availRes.data ?? 0),
      reserved_pence: Number(reservedRes.data ?? 0),
      paid_pence: 0,
      wallet_debited: false,
    },
    paid: false,
    wallet_debit_applied: false,
    source_account_label: companyBalance.source_account_label,
    source_account_id_masked: maskProviderId(amountGate.source_account_id),
    relay: {
      status: relayResult.status,
      revolut_pay_called: relayResult.revolut_pay_called === true,
      error: relayResult.error,
      raw_pay_still_blocked: rawPayProbe.blocked,
    },
    evidence_redacted: evidence,
    finalize: finalizeRaw,
    live_payout_execution_enabled: false,
    revolut_payment_transport_enabled: true,
    slices_8_to_12_started: false,
    ahmed_not_submitted: itemRow.driver_id !== SLICE7_PROOF_DRIVERS.AHMED_ID,
  }, ok ? 200 : 422);
});
