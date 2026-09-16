/**
 * Slice 12 â Admin-controlled company transfer provider submission.
 * Requires REVOLUT_PAYMENT_TRANSPORT_ENABLED=true and
 * LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED must be true for provider /pay.
 * Revalidates Slice 11 gate before any provider call. Never trusts client amount/payee.
 *
 * POST { transfer_id: string, confirm_submit?: true }
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveLiveCompanyBalanceWithSlice10Gate } from "../_shared/companyBalanceResolveSSOT.ts";
import { loadActiveOperationalReservePolicy } from "../_shared/companyOperationalReserveLoadSSOT.ts";
import {
  loadProtectedDriverLiabilityPence,
  loadReservedDriverPayoutPence,
} from "../_shared/companyBalanceCompositionLoadSSOT.ts";
import {
  buildCompanyTransferFundingSnapshot,
  COMPANY_TRANSFER_GATE_REASON,
  evaluateCompanyTransferExecutionGate,
  LIVE_COMPANY_TRANSFER_EXECUTION_SETTING_KEY,
  parseAdminSettingEnabled,
  parseLiveCompanyTransferExecutionEnabled,
  resolveLiveCompanyTransferExecutionEnabledFailClosed,
} from "../_shared/companyTransferLifecycleSSOT.ts";
import {
  assertSlice12SubmissionMoneySafety,
  canonicalCompanyTransferIdempotencyKey,
  canonicalCompanyTransferProviderRequestId,
  evaluateCompanyTransferPreSubmitGate,
  evaluateCompanyTransferSubmissionEligibility,
  evaluateSlice12SubmissionFlagGate,
  mapCompanyTransferProviderSubmissionOutcome,
  maskProviderId,
  redactCompanyTransferSubmissionEvidence,
  rejectDriverOrArbitraryPayment,
  SUBMISSION_ERROR,
} from "../_shared/companyTransferSubmissionSSOT.ts";
import { validateApprovedCompanyTransferPayment } from "../_shared/revolutCompanyTransferPaymentSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayApprovedCompanyTransferPayment,
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

async function loadLiveCompanyTransferExecutionEnabled(
  supabase: ReturnType<typeof createClient>,
): Promise<boolean> {
  try {
    const envEnabled = parseLiveCompanyTransferExecutionEnabled((k) => Deno.env.get(k));
    const { data } = await supabase
      .from("admin_settings")
      .select("setting_value")
      .eq("setting_key", LIVE_COMPANY_TRANSFER_EXECUTION_SETTING_KEY)
      .maybeSingle();
    return resolveLiveCompanyTransferExecutionEnabledFailClosed({
      env_enabled: envEnabled,
      admin_settings_enabled: parseAdminSettingEnabled(data?.setting_value),
    });
  } catch {
    return false;
  }
}

async function captureFundingSnapshot(args: {
  supabase: ReturnType<typeof createClient>;
  service_area_id: string | null;
  currency: string;
}) {
  // Match admin-company-outgoing-transfer capture â without liability/reserved +
  // eligible/final field mapping, final_company_available_pence stays null and
  // LIVE submit falsely BLOCKS despite Available Company Funds on the ledger.
  const [liability, reserved, reserveLoaded] = await Promise.all([
    loadProtectedDriverLiabilityPence(args.supabase, args.service_area_id),
    loadReservedDriverPayoutPence(args.supabase, args.service_area_id),
    loadActiveOperationalReservePolicy(args.supabase, {
      service_area_id: args.service_area_id,
      currency: args.currency,
    }),
  ]);

  const companyBalance = await resolveLiveCompanyBalanceWithSlice10Gate({
    supabase: args.supabase,
    service_area_id: args.service_area_id,
    currency: args.currency,
    approved_payables_pending_pence: 0,
    driver_liability_pence: liability.amount_pence,
    driver_payout_reserved_pence: reserved.amount_pence,
    customer_refund_reserved_pence: null,
  });

  const reserveSection = companyBalance.sections?.operational_reserve;
  const policyActive = String(reserveLoaded.policy?.status ?? "").toUpperCase() === "ACTIVE";
  const reserveAmount = companyBalance.operational_reserve_pence;
  const reserveStatus = reserveAmount != null && policyActive
    ? "ACTIVE"
    : reserveAmount != null
      && ["ACTIVE", "AVAILABLE"].includes(String(reserveSection?.status ?? "").toUpperCase())
    ? "ACTIVE"
    : (reserveSection?.status
      ?? (reserveAmount == null ? "NOT_CONFIGURED" : "ACTIVE"));
  const reserveReason = reserveAmount != null
    ? null
    : (reserveSection?.reason_code
      ?? reserveLoaded.error_code
      ?? null);

  const funding_snapshot = buildCompanyTransferFundingSnapshot({
    capture_phase: "SUBMIT",
    service_area_id: args.service_area_id,
    currency: args.currency,
    source_balance_pence: companyBalance.provider_available_balance_pence
      ?? companyBalance.provider_cash_balance_pence,
    protected_liabilities_pence: companyBalance.driver_liability_pence
      ?? companyBalance.sections?.driver_liabilities?.amount_pence
      ?? null,
    reserved_driver_payouts_pence: companyBalance.driver_payout_reserved_pence
      ?? companyBalance.sections?.reserved_driver_payouts?.amount_pence
      ?? null,
    approved_payables_pence: companyBalance.approved_company_payables_pence
      ?? companyBalance.sections?.approved_company_payables?.amount_pence
      ?? null,
    classified_company_cash_pence: companyBalance.classified_company_cash_pence ?? null,
    eligible_company_cash_pence: companyBalance.company_available_before_operational_reserve_pence,
    transferable_base_pence: companyBalance.transferable_base_pence ?? null,
    operational_reserve_pence: reserveAmount,
    operational_reserve_status: reserveStatus,
    operational_reserve_reason_code: reserveReason,
    reserve_policy_id: reserveLoaded.policy?.id ?? null,
    final_company_available_pence: companyBalance.final_company_available_pence
      ?? companyBalance.company_available_for_transfer_pence,
    source_account_id: companyBalance.source_account_id ?? null,
  });
  return { companyBalance, funding_snapshot };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 200);

  const flagGate = evaluateSlice12SubmissionFlagGate(Deno.env);
  if (!flagGate.ok) {
    return json({
      ok: false,
      error: flagGate.code,
      message: flagGate.message,
      revolut_pay_called: false,
      company_debited: false,
      hold_placed: false,
    }, 200);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 200);
  }

  const blocked = rejectDriverOrArbitraryPayment(body);
  if (!blocked.ok) {
    return json({
      ok: false,
      error: blocked.code,
      message: blocked.message,
      revolut_pay_called: false,
      hold_placed: false,
    }, 200);
  }

  if (body.confirm_submit !== true) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.VALIDATION_FAILED,
      message: "confirm_submit:true is required for Slice 12 provider submission",
      revolut_pay_called: false,
    }, 200);
  }

  for (const forbidden of [
    "amount_pence",
    "approved_amount_pence",
    "source_account_id",
    "provider_counterparty_id",
    "provider_recipient_account_id",
    "payee_id",
    "recipient_name",
  ]) {
    if (body[forbidden] !== undefined) {
      return json({
        ok: false,
        error: SUBMISSION_ERROR.ARBITRARY_PAYMENT_BLOCKED,
        message: `Client field '${forbidden}' rejected â server-loaded transfer only`,
        revolut_pay_called: false,
        hold_placed: false,
      }, 200);
    }
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const transferId = String(body.transfer_id ?? "").trim();
  if (!transferId) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.VALIDATION_FAILED,
      message: "transfer_id is required",
      revolut_pay_called: false,
    }, 200);
  }

  const liveCompanyExec = await loadLiveCompanyTransferExecutionEnabled(supabase);

  const { data: transfer, error: transferErr } = await supabase
    .from("company_outgoing_transfers")
    .select(
      "id, status, amount_pence, approved_amount_pence, currency, service_area_id, " +
      "revolut_counterparty_id, revolut_recipient_account_id, payment_reference, transfer_ref, " +
      "payee_id, provider, blocked_reason_codes, pre_execution_funding_snapshot",
    )
    .eq("id", transferId)
    .maybeSingle();

  if (transferErr || !transfer) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.VALIDATION_FAILED,
      message: "transfer not found",
      revolut_pay_called: false,
    }, 200);
  }

  const amount = Number(transfer.approved_amount_pence ?? transfer.amount_pence ?? 0);
  const { companyBalance, funding_snapshot } = await captureFundingSnapshot({
    supabase,
    service_area_id: transfer.service_area_id ?? null,
    currency: transfer.currency ?? "GBP",
  });

  // LIVE off: refuse without mutating transfer status (keep READY/APPROVED for safe admin actions).
  if (!liveCompanyExec) {
    assertSlice12SubmissionMoneySafety({
      company_debited: false,
      hold_consumed: false,
      live_company_transfer_execution_enabled: false,
      revolut_pay_called: false,
      driver_wallet_mutated: false,
    });
    return json({
      ok: false,
      slice: 12,
      error: COMPANY_TRANSFER_GATE_REASON.LIVE_EXECUTION_DISABLED,
      error_code: COMPANY_TRANSFER_GATE_REASON.LIVE_EXECUTION_DISABLED,
      blocked_reason_codes: [COMPANY_TRANSFER_GATE_REASON.LIVE_EXECUTION_DISABLED],
      message: "LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false â no provider submission",
      transfer_id: transfer.id,
      transfer_status: transfer.status,
      transfer_status_unchanged: true,
      funding_snapshot,
      live_company_transfer_execution_enabled: false,
      revolut_pay_called: false,
      money_moved: false,
      company_debited: false,
      hold_placed: false,
      driver_wallet_mutated: false,
      company_balance_mutated: false,
      provider_payment_id: null,
    }, 200);
  }

  const execGate = evaluateCompanyTransferPreSubmitGate({
    amount_pence: amount,
    funding_snapshot,
    live_company_transfer_execution_enabled: liveCompanyExec,
  });

  if (!execGate.allowed) {
    const now = new Date().toISOString();
    const protection = execGate.funds_protection ?? null;
    await supabase.from("company_outgoing_transfers").update({
      status: "BLOCKED",
      pre_execution_funding_snapshot: funding_snapshot,
      blocked_reason_codes: execGate.reason_codes,
      blocked_at: now,
      failure_reason: protection?.message ?? execGate.reason_codes.join(","),
      updated_at: now,
    }).eq("id", transfer.id);

    assertSlice12SubmissionMoneySafety({
      company_debited: false,
      hold_consumed: false,
      live_company_transfer_execution_enabled: liveCompanyExec,
      revolut_pay_called: false,
      driver_wallet_mutated: false,
    });

    return json({
      ok: false,
      slice: 12,
      error: protection?.reason ?? SUBMISSION_ERROR.FUNDING_GATE_BLOCKED,
      error_code: protection?.reason ?? execGate.reason_codes[0],
      blocked_reason_codes: execGate.reason_codes,
      funds_protection: protection,
      message: protection?.message ?? execGate.reason_codes.join(","),
      transfer_id: transfer.id,
      transfer_status: "BLOCKED",
      funding_snapshot,
      live_company_transfer_execution_enabled: liveCompanyExec,
      revolut_pay_called: false,
      company_debited: false,
      hold_placed: false,
      driver_wallet_mutated: false,
      company_balance_mutated: false,
      provider_payment_id: null,
    }, 200);
  }

  const eligibility = evaluateCompanyTransferSubmissionEligibility({
    transfer_status: transfer.status,
    approved_amount_pence: amount,
    loaded_amount_pence: amount,
    provider_counterparty_id: transfer.revolut_counterparty_id,
    provider_recipient_account_id: transfer.revolut_recipient_account_id,
  });
  if (!eligibility.ok) {
    return json({
      ok: false,
      error: eligibility.code,
      message: eligibility.message,
      revolut_pay_called: false,
      hold_placed: false,
    }, 200);
  }

  const sourceAccountId = funding_snapshot.source_account_id ?? companyBalance.source_account_id;
  if (!sourceAccountId) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.MISSING_SOURCE_ACCOUNT,
      message: "Company Balance SSOT source account not configured",
      revolut_pay_called: false,
    }, 200);
  }

  const { data: claimRaw, error: claimErr } = await supabase.rpc(
    "claim_company_transfer_submission",
    {
      p_transfer_id: transferId,
      p_source_account_id: sourceAccountId,
      p_claim_token: crypto.randomUUID(),
      p_place_hold: true,
    },
  );
  if (claimErr) {
    return json({
      ok: false,
      error: "claim_rpc_failed",
      message: claimErr.message,
      hint: "Apply migration 20260831270000_company_transfer_provider_submission_slice12.sql",
      revolut_pay_called: false,
    }, 500);
  }
  const claim = (claimRaw ?? {}) as Record<string, unknown>;
  if (claim.ok !== true) {
    return json({
      ok: false,
      error: claim.error ?? SUBMISSION_ERROR.CLAIM_CONFLICT,
      message: claim.message ?? "claim failed",
      revolut_pay_called: false,
      hold_placed: false,
    }, 200);
  }

  const paymentBody: Record<string, unknown> = {
    transfer_id: transferId,
    source_account_id: String(claim.source_account_id),
    provider_counterparty_id: String(claim.provider_counterparty_id),
    provider_recipient_account_id: String(claim.provider_recipient_account_id),
    amount_pence: Number(claim.amount_pence),
    currency: String(claim.currency ?? "GBP"),
    payment_reference: claim.payment_reference ?? null,
    provider_request_id: canonicalCompanyTransferProviderRequestId(transferId),
    idempotency_key: canonicalCompanyTransferIdempotencyKey(transferId),
  };

  const validated = validateApprovedCompanyTransferPayment({
    body: paymentBody,
    loaded: {
      transfer_id: transferId,
      amount_pence: amount,
      currency: String(transfer.currency ?? "GBP"),
      source_account_id: String(claim.source_account_id),
      provider_counterparty_id: String(claim.provider_counterparty_id),
      provider_recipient_account_id: String(claim.provider_recipient_account_id),
      payment_reference: transfer.payment_reference,
    },
  });
  if (!validated.ok) {
    await supabase.rpc("finalize_company_transfer_submission", {
      p_transfer_id: transferId,
      p_claim_token: String(claim.claim_token),
      p_execution_status: "FAILED",
      p_provider_failure_code: validated.code,
      p_provider_failure_reason_safe: validated.message,
      p_evidence_redacted: { validation_failed: true },
      p_release_hold: true,
    });
    return json({
      ok: false,
      error: validated.code,
      message: validated.message,
      revolut_pay_called: false,
      hold_placed: false,
    }, 200);
  }

  if (!isRevolutBusinessRelayConfigured()) {
    await supabase.rpc("finalize_company_transfer_submission", {
      p_transfer_id: transferId,
      p_claim_token: String(claim.claim_token),
      p_execution_status: "UNKNOWN",
      p_provider_failure_code: SUBMISSION_ERROR.RELAY_UNREACHABLE,
      p_provider_failure_reason_safe: "relay not configured",
      p_evidence_redacted: {},
      p_release_hold: false,
    });
    return json({
      ok: false,
      error: SUBMISSION_ERROR.RELAY_UNREACHABLE,
      revolut_pay_called: false,
      hold_placed: true,
    }, 200);
  }

  let accessToken: string;
  try {
    const tok = await ensureFreshRevolutBusinessAccessToken(supabase);
    accessToken = tok.accessToken;
  } catch (err) {
    await supabase.rpc("finalize_company_transfer_submission", {
      p_transfer_id: transferId,
      p_claim_token: String(claim.claim_token),
      p_execution_status: "UNKNOWN",
      p_provider_failure_code: SUBMISSION_ERROR.ACCESS_TOKEN_REQUIRED,
      p_provider_failure_reason_safe: err instanceof Error ? err.message : "token unavailable",
      p_evidence_redacted: {},
      p_release_hold: false,
    });
    return json({
      ok: false,
      error: SUBMISSION_ERROR.ACCESS_TOKEN_REQUIRED,
      revolut_pay_called: false,
      hold_placed: true,
    }, 200);
  }

  const payBlocked = await relayProbePayBlocked();
  if (!payBlocked.blocked) {
    return json({
      ok: false,
      error: SUBMISSION_ERROR.ARBITRARY_PAYMENT_BLOCKED,
      message: "Raw /pay must remain blocked on relay",
      revolut_pay_called: false,
    }, 200);
  }

  const relayStarted = Date.now();
  let timedOut = false;
  let relayResult: Awaited<ReturnType<typeof relayApprovedCompanyTransferPayment>>;
  try {
    relayResult = await relayApprovedCompanyTransferPayment({
      body: {
        transfer_id: validated.normalized.transfer_id,
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

  const outcome = mapCompanyTransferProviderSubmissionOutcome({
    http_ok: relayResult.status >= 200 && relayResult.status < 300,
    timed_out: timedOut,
    provider_payment_id: relayResult.provider_payment_id,
    provider_state: relayResult.provider_state,
    hard_reject: relayResult.error === "PROVIDER_HARD_REJECT",
  });

  const evidence = redactCompanyTransferSubmissionEvidence({
    provider_payment_id: relayResult.provider_payment_id,
    provider_state: relayResult.provider_state,
    provider_request_id: validated.normalized.provider_request_id,
    http_status: relayResult.status,
    failure_code: relayResult.error,
  });

  const { data: finalizeRaw } = await supabase.rpc("finalize_company_transfer_submission", {
    p_transfer_id: transferId,
    p_claim_token: String(claim.claim_token),
    p_execution_status: outcome.execution_status,
    p_provider_payment_id: relayResult.provider_payment_id,
    p_provider_state: relayResult.provider_state,
    p_provider_created_at: typeof relayResult.json?.created_at === "string"
      ? relayResult.json.created_at
      : null,
    p_provider_failure_code: relayResult.error,
    p_provider_failure_reason_safe: relayResult.error,
    p_evidence_redacted: evidence,
    p_release_hold: outcome.release_hold,
  });

  assertSlice12SubmissionMoneySafety({
    company_debited: false,
    hold_consumed: false,
    live_company_transfer_execution_enabled: liveCompanyExec,
    revolut_pay_called: relayResult.revolut_pay_called,
    driver_wallet_mutated: false,
  });

  return json({
    ok: outcome.execution_status === "SUBMITTED" || outcome.execution_status === "UNKNOWN",
    slice: 12,
    transfer_id: transferId,
    execution_status: outcome.execution_status,
    transfer_status: outcome.transfer_status,
    provider_payment_id: relayResult.provider_payment_id,
    provider_payment_id_masked: maskProviderId(relayResult.provider_payment_id),
    provider_state: relayResult.provider_state,
    provider_request_id: validated.normalized.provider_request_id,
    revolut_pay_called: relayResult.revolut_pay_called,
    company_debited: false,
    hold_placed: outcome.keep_hold_active,
    hold_released: outcome.release_hold,
    paid: false,
    finalize: finalizeRaw,
    live_company_transfer_execution_enabled: liveCompanyExec,
    driver_wallet_mutated: false,
  }, outcome.execution_status === "SUBMITTED" ? 200 : 409);
});
