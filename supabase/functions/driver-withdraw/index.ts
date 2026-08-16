/**
 * Driver-triggered Revolut Business Withdraw.
 * Reuses Slice 6/7 reservation + claim + relay /pay + completion SSOT.
 * Revolut/bank payouts only. Separate trigger from weekly admin payout.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveAuthenticatedDriver } from "../_shared/resolveAuthenticatedDriver.ts";
import { fetchDriverPayoutEligibility } from "../_shared/fetchDriverPayoutEligibility.ts";
import {
  canonicalIdempotencyKey,
  canonicalProviderRequestId,
  validateApprovedDriverPayoutPayment,
} from "../_shared/revolutDriverPayoutPaymentSSOT.ts";
import {
  evaluateDriverWithdrawExecutionGate,
  evaluateSourceAccountGate,
  mapProviderSubmissionOutcome,
  maskProviderId,
  redactProviderEvidence,
  SUBMISSION_ERROR,
} from "../_shared/driverPayoutSubmissionSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayApprovedDriverPayoutPayment,
} from "../_shared/revolutBusinessRelayClient.ts";
import { resolveLiveCompanyBalanceSnapshot } from "../_shared/companyBalanceResolveSSOT.ts";
import { ensureFreshRevolutBusinessAccessToken } from "../_shared/revolutBusinessAccessTokenRefresh.ts";
import { reconcileSubmittedDriverWithdrawPayout } from "../_shared/driverWithdrawProviderReconcile.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function mapItemStatusToCashoutStatus(status: string | null | undefined): string {
  const s = String(status ?? "").toUpperCase();
  if (s === "COMPLETED" || s === "PAID") return "paid";
  if (s === "FAILED" || s === "DECLINED" || s === "RELEASED" || s === "CANCELLED") {
    return "failed";
  }
  if (s === "SUBMITTED" || s === "SUBMITTING" || s === "RESERVED" || s === "UNKNOWN") {
    return "processing";
  }
  return "pending";
}

function projectCashout(args: {
  payoutItemId: string;
  amountPence: number;
  status: string;
  feePence?: number;
  receivesPence?: number;
  createdAt?: string | null;
  paidAt?: string | null;
  failedAt?: string | null;
  failureReason?: string | null;
}) {
  const fee = Math.max(0, Math.round(Number(args.feePence ?? 0)));
  const receives = Math.round(
    Number(
      args.receivesPence
        ?? Math.max(0, args.amountPence - fee),
    ),
  );
  return {
    id: args.payoutItemId,
    status: mapItemStatusToCashoutStatus(args.status),
    requested_cashout_pence: args.amountPence,
    early_cashout_fee_pence: fee,
    onecab_cashout_fee_pence: fee,
    driver_receives_pence: receives,
    created_at: args.createdAt ?? new Date().toISOString(),
    paid_at: args.paidAt ?? null,
    failed_at: args.failedAt ?? null,
    failure_reason: args.failureReason ?? null,
    payout_item_id: args.payoutItemId,
  };
}

function normalizeClientIdempotency(raw: unknown, driverId: string): string {
  const token = String(raw ?? "").trim();
  if (token.length >= 8 && token.length <= 128) {
    return `driver-withdraw:${driverId}:${token}`;
  }
  return `driver-withdraw:${driverId}:${crypto.randomUUID()}`;
}

/**
 * Pre-provider hard failure: release rolls item back to VALIDATED (weekly Slice 6
 * semantics), which wallet SSOT treats as CASHOUT_ALREADY_PROCESSING forever.
 * Driver Withdraw must mark the EARLY_CASHOUT item terminal FAILED so the Driver
 * can retry. Never call this after Revolut /pay / UNKNOWN provider state.
 */
async function markDriverWithdrawPreProviderFailed(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  payoutItemId: string,
  failureCode: string,
  failureReason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("payout_items")
    .update({
      status: "FAILED",
      execution_status: "FAILED",
      failure_code: failureCode,
      failure_reason: failureReason,
      error_message: failureReason,
      failed_at: now,
      updated_at: now,
    })
    .eq("id", payoutItemId)
    .in("status", [
      "VALIDATED",
      "RESERVING",
      "RESERVED",
      "BLOCKED_EXECUTION_DISABLED",
      "SUBMITTING",
    ]);

  const { data: item } = await supabase
    .from("payout_items")
    .select("batch_id")
    .eq("id", payoutItemId)
    .maybeSingle();
  const batchId = item?.batch_id ? String(item.batch_id) : "";
  if (!batchId) return;

  await supabase
    .from("payout_batches")
    .update({
      status: "FAILED",
      failure_code: failureCode,
      failure_reason: failureReason,
      failed_at: now,
      updated_at: now,
    })
    .eq("id", batchId)
    .eq("kind", "EARLY_CASHOUT")
    .in("status", [
      "FUNDS_RESERVED_EXECUTION_DISABLED",
      "BLOCKED_EXECUTION_DISABLED",
      "ITEMS_CREATED",
      "DRAFT",
    ]);
}

async function releaseAndFailPreProvider(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  payoutItemId: string,
  failureCode: string,
  failureReason: string,
): Promise<void> {
  await supabase.rpc("release_driver_payout_reservation", {
    p_reservation_id: null,
    p_payout_item_id: payoutItemId,
    p_release_reason: failureCode,
  });
  await markDriverWithdrawPreProviderFailed(
    supabase,
    payoutItemId,
    failureCode,
    failureReason,
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const flagGate = evaluateDriverWithdrawExecutionGate(Deno.env);
  if (!flagGate.ok) {
    return json({
      ok: false,
      error: flagGate.code,
      driver_message: flagGate.message,
      revolut_pay_called: false,
    }, 503);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, error: "server_misconfigured" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "unauthorized", driver_message: "Sign in to continue." }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Service-role probes only (no new /pay).
  const bearer = authHeader.slice("Bearer ".length).trim();
  let jwtRole = "";
  try {
    const payloadB64 = bearer.split(".")[1] ?? "";
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
    jwtRole = String(payload?.role ?? "");
  } catch {
    jwtRole = "";
  }
  const isServiceRole = jwtRole === "service_role" || bearer === serviceKey;

  if (body.probe_company_balance === true) {
    if (!isServiceRole) {
      return json({ ok: false, error: "forbidden", revolut_pay_called: false }, 403);
    }
    const supabase = createClient(supabaseUrl, serviceKey);
    const snap = await resolveLiveCompanyBalanceSnapshot({
      supabase,
      currency: "GBP",
      refresh: true,
    });
    const available = snap.provider_available_balance_pence
      ?? snap.provider_cash_balance_pence
      ?? null;
    return json({
      ok: snap.status_code === "AVAILABLE",
      probe: true,
      revolut_pay_called: false,
      status_code: snap.status_code,
      source_account_id: snap.source_account_id ?? null,
      currency: snap.currency ?? "GBP",
      provider_available_balance_pence: available,
      last_provider_sync_at: snap.last_provider_sync_at ?? null,
      source_account_label: snap.source_account_label ?? null,
      covers_803p: typeof available === "number" && available >= 803,
    });
  }

  // Service-role: reconcile one SUBMITTED withdraw via GET /transaction (never /pay).
  if (
    isServiceRole
    && typeof body.reconcile_payout_item_id === "string"
    && body.reconcile_payout_item_id.trim()
  ) {
    const supabase = createClient(supabaseUrl, serviceKey);
    const result = await reconcileSubmittedDriverWithdrawPayout({
      supabase,
      payoutItemId: body.reconcile_payout_item_id.trim(),
    });
    return json({
      ...result,
      reconcile: true,
      revolut_pay_called: false,
    }, result.ok || result.provider_state === "pending" || result.provider_state === "created"
      ? 200
      : 409);
  }

  const userClient = createClient(supabaseUrl, anonKey || serviceKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return json({ ok: false, error: "unauthorized", driver_message: "Sign in to continue." }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const resolved = await resolveAuthenticatedDriver(supabase, userData.user.id, "DRIVER_WITHDRAW");
  if (!resolved.ok) {
    return json({
      ok: false,
      error: resolved.reason,
      driver_message: resolved.message,
    }, 403);
  }
  const driverId = resolved.driver.driver_id;

  // Never trust client driver_id / amount.
  if (body.driver_id && String(body.driver_id) !== driverId) {
    return json({
      ok: false,
      error: "driver_mismatch",
      driver_message: "Withdrawal driver mismatch.",
    }, 403);
  }

  const clientIdempotency = normalizeClientIdempotency(
    body.idempotency_key ?? body.client_request_id,
    driverId,
  );

  // Reuse in-flight EARLY_CASHOUT item for same idempotency key.
  const { data: existingItem } = await supabase
    .from("payout_items")
    .select("id, status, amount_pence, net_driver_payout_pence, created_at, completed_at, failed_at, failure_reason, batch_id, eligibility_snapshot")
    .eq("driver_id", driverId)
    .eq("idempotency_key", clientIdempotency)
    .maybeSingle();

  if (existingItem?.id) {
    const status = String(existingItem.status ?? "");
    const upper = status.toUpperCase();
    if (["SUBMITTED", "SUBMITTING", "RESERVED", "UNKNOWN"].includes(upper)) {
      const reconciled = await reconcileSubmittedDriverWithdrawPayout({
        supabase,
        payoutItemId: String(existingItem.id),
        expectedDriverId: driverId,
      });
      const feeFromSnap = Number(
        (existingItem.eligibility_snapshot as Record<string, unknown> | null)
          ?.withdrawal_fee_pence ?? 0,
      );
      const receives = Number(
        existingItem.net_driver_payout_pence
          ?? Math.max(0, Number(existingItem.amount_pence ?? 0) - feeFromSnap),
      );
      return json({
        ok: reconciled.ok || reconciled.provider_state === "pending"
          || reconciled.provider_state === "created",
        reused: true,
        reconciled: true,
        cashout: projectCashout({
          payoutItemId: existingItem.id,
          amountPence: Number(existingItem.amount_pence ?? 0),
          feePence: feeFromSnap,
          receivesPence: receives,
          status: reconciled.item_status ?? status,
          createdAt: existingItem.created_at,
          paidAt: reconciled.financially_applied
            ? new Date().toISOString()
            : existingItem.completed_at,
          failedAt: existingItem.failed_at,
          failureReason: existingItem.failure_reason,
        }),
        payout_item_id: existingItem.id,
        provider_payment_id: reconciled.provider_payment_id,
        provider_state: reconciled.provider_state,
        wallet_debited: reconciled.wallet_debited,
        reservation_consumed: reconciled.reservation_consumed,
        revolut_pay_called: false,
      });
    }
    if (["COMPLETED", "PAID"].includes(upper)) {
      const feeFromSnap = Number(
        (existingItem.eligibility_snapshot as Record<string, unknown> | null)
          ?.withdrawal_fee_pence ?? 0,
      );
      return json({
        ok: true,
        reused: true,
        cashout: projectCashout({
          payoutItemId: existingItem.id,
          amountPence: Number(existingItem.amount_pence ?? 0),
          feePence: feeFromSnap,
          receivesPence: Number(existingItem.net_driver_payout_pence ?? 0) || undefined,
          status,
          createdAt: existingItem.created_at,
          paidAt: existingItem.completed_at,
          failedAt: existingItem.failed_at,
          failureReason: existingItem.failure_reason,
        }),
        payout_item_id: existingItem.id,
        revolut_pay_called: false,
        wallet_debited: true,
      });
    }
  }

  // Explicit driver reconcile of a known SUBMITTED item (no new /pay).
  if (typeof body.reconcile_payout_item_id === "string" && body.reconcile_payout_item_id.trim()) {
    const reconciled = await reconcileSubmittedDriverWithdrawPayout({
      supabase,
      payoutItemId: body.reconcile_payout_item_id.trim(),
      expectedDriverId: driverId,
    });
    return json({
      ...reconciled,
      reconcile: true,
      revolut_pay_called: false,
    }, reconciled.ok || reconciled.provider_state === "pending" ? 200 : 409);
  }

  const { data: summaryRaw, error: summaryErr } = await supabase.rpc(
    "driver_wallet_summary_ssot",
    { p_driver_id: driverId, p_service_area_id: null },
  );
  if (summaryErr) {
    return json({
      ok: false,
      error: "wallet_summary_failed",
      driver_message: "Unable to load wallet eligibility.",
      message: summaryErr.message,
    }, 500);
  }
  const summary = (summaryRaw ?? {}) as Record<string, unknown>;
  if (summary.ok !== true) {
    return json({
      ok: false,
      error: "wallet_summary_failed",
      driver_message: "Unable to load wallet eligibility.",
    }, 500);
  }

  if (summary.early_cash_out_enabled !== true) {
    return json({
      ok: false,
      error: "FEATURE_DISABLED",
      error_code: "FEATURE_DISABLED",
      driver_message: "Withdrawals are not available at this time.",
    }, 409);
  }
  if (summary.early_cash_out_eligible !== true) {
    const block = String(summary.early_cash_out_block_reason ?? "NOT_ELIGIBLE");
    return json({
      ok: false,
      error: block,
      error_code: block,
      driver_message: "Withdrawals are not available at this time.",
    }, 409);
  }

  const provider = String(summary.early_cash_out_provider ?? "").toLowerCase();
  if (provider !== "revolut") {
    return json({
      ok: false,
      error: "PROVIDER_UNAVAILABLE",
      error_code: "PROVIDER_UNAVAILABLE",
      driver_message: "Withdrawals are not available for this payout provider.",
    }, 409);
  }

  const eligibility = await fetchDriverPayoutEligibility(supabase, { driver_id: driverId });
  const ssotAvailable = Math.max(0, Math.round(Number(eligibility.available_balance_pence ?? 0)));
  const summaryRequested = Math.round(Number(summary.early_cash_out_requested_pence ?? 0));
  const amountPence = Math.min(
    Number.isFinite(summaryRequested) ? Math.max(0, summaryRequested) : 0,
    ssotAvailable,
  );
  if (!Number.isFinite(amountPence) || amountPence <= 0 || ssotAvailable <= 0) {
    return json({
      ok: false,
      error: "NO_AVAILABLE_BALANCE",
      error_code: "NO_AVAILABLE_BALANCE",
      driver_message: "No balance available to withdraw.",
      live_balance_pence: eligibility.live_balance_pence,
      available_balance_pence: ssotAvailable,
      pending_balance_pence: eligibility.pending_balance_pence,
      withdrawal_in_progress_pence: eligibility.withdrawal_in_progress_pence,
    }, 409);
  }

  const feePence = Math.max(0, Math.round(Number(summary.early_cash_out_fee_pence ?? 0)));
  const receivesPence = Math.round(
    Number(
      summary.early_cash_out_driver_receives_pence
        ?? Math.max(0, amountPence - feePence),
    ),
  );
  // Fee must be deducted from provider transfer before /pay (never after).
  if (feePence > 0 && receivesPence <= 0) {
    return json({
      ok: false,
      error: "BALANCE_NOT_GREATER_THAN_FEE",
      error_code: "BALANCE_NOT_GREATER_THAN_FEE",
      driver_message: "Available balance does not cover the withdrawal fee.",
      revolut_pay_called: false,
    }, 409);
  }
  if (receivesPence <= 0 || receivesPence > amountPence) {
    return json({
      ok: false,
      error: "INVALID_WITHDRAWAL_AMOUNT",
      error_code: "INVALID_WITHDRAWAL_AMOUNT",
      driver_message: "Withdrawal amount is invalid.",
      revolut_pay_called: false,
    }, 409);
  }
  const providerTransferPence = receivesPence;

  const serviceAreaId = summary.service_area_id
    ? String(summary.service_area_id)
    : null;

  const { data: dest } = await supabase
    .from("driver_payout_destinations")
    .select(
      "id, driver_id, currency_code, verification_status, provider_link_status, provider_counterparty_id, provider_recipient_account_id, is_active, archived_at, provider",
    )
    .eq("driver_id", driverId)
    .eq("is_active", true)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (
    !dest?.id ||
    String(dest.provider_link_status ?? "").toUpperCase() !== "PROVIDER_VERIFIED" ||
    !dest.provider_counterparty_id ||
    !dest.provider_recipient_account_id
  ) {
    return json({
      ok: false,
      error: "PAYOUT_ACCOUNT_NOT_VERIFIED",
      error_code: "PAYOUT_ACCOUNT_NOT_VERIFIED",
      driver_message: "Add a verified payout account before withdrawing.",
      revolut_pay_called: false,
    }, 409);
  }

  const occurrenceKey = clientIdempotency;
  let payoutItemId = existingItem?.id ? String(existingItem.id) : null;
  let batchId: string | null = existingItem?.batch_id
    ? String(existingItem.batch_id)
    : null;

  if (!payoutItemId) {
    const { data: batch, error: batchErr } = await supabase
      .from("payout_batches")
      .insert({
        kind: "EARLY_CASHOUT",
        status: "ITEMS_CREATED",
        service_area_id: serviceAreaId,
        schedule_occurrence_key: occurrenceKey,
        currency: "GBP",
        eligible_driver_count: 1,
      })
      .select("id")
      .single();
    if (batchErr || !batch?.id) {
      // Unique occurrence → reuse
      const { data: reusedBatch } = await supabase
        .from("payout_batches")
        .select("id")
        .eq("schedule_occurrence_key", occurrenceKey)
        .maybeSingle();
      if (!reusedBatch?.id) {
        return json({
          ok: false,
          error: "batch_create_failed",
          message: batchErr?.message ?? "Could not create withdrawal batch",
        }, 500);
      }
      batchId = String(reusedBatch.id);
    } else {
      batchId = String(batch.id);
    }

    const { data: item, error: itemErr } = await supabase
      .from("payout_items")
      .insert({
        batch_id: batchId,
        driver_id: driverId,
        amount_pence: amountPence,
        net_driver_payout_pence: providerTransferPence,
        currency: "GBP",
        status: "VALIDATED",
        payout_destination_id: dest.id,
        provider_counterparty_id: dest.provider_counterparty_id,
        provider_recipient_account_id: dest.provider_recipient_account_id,
        idempotency_key: clientIdempotency,
        payout_type: "EARLY_CASHOUT",
        wallet_snapshot_available_pence: amountPence,
        eligibility_snapshot: {
          source: "driver_wallet_summary_ssot",
          early_cash_out_block_reason: null,
          withdrawal_fee_pence: feePence,
          provider_transfer_pence: providerTransferPence,
          wallet_gross_pence: amountPence,
          fee_formula: "provider_transfer = wallet_gross - withdrawal_fee",
        },
      })
      .select("id, status, amount_pence, created_at")
      .single();

    if (itemErr || !item?.id) {
      const { data: reusedItem } = await supabase
        .from("payout_items")
        .select("id, status, amount_pence, created_at, completed_at, failed_at, failure_reason")
        .eq("idempotency_key", clientIdempotency)
        .maybeSingle();
      if (!reusedItem?.id) {
        return json({
          ok: false,
          error: "item_create_failed",
          message: itemErr?.message ?? "Could not create withdrawal item",
        }, 500);
      }
      payoutItemId = String(reusedItem.id);
    } else {
      payoutItemId = String(item.id);
    }
  }

  const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
    "reserve_driver_payout_item",
    { p_payout_item_id: payoutItemId },
  );
  if (reserveErr) {
    return json({
      ok: false,
      error: "reserve_failed",
      message: reserveErr.message,
      driver_message: "Could not reserve withdrawal funds.",
    }, 500);
  }
  const reserve = (reserveRaw ?? {}) as Record<string, unknown>;
  if (reserve.ok !== true) {
    const code = String(reserve.error_code ?? "reserve_failed");
    return json({
      ok: false,
      error: code,
      error_code: code,
      driver_message: code === "ACTIVE_RESERVATION_EXISTS"
        ? "A payout is already in progress for these funds."
        : "Could not reserve withdrawal funds.",
      revolut_pay_called: false,
    }, 409);
  }

  const companyBalance = await resolveLiveCompanyBalanceSnapshot({
    supabase,
    currency: "GBP",
    refresh: true,
  });
  if (!companyBalance.source_account_id || companyBalance.status_code !== "AVAILABLE") {
    await releaseAndFailPreProvider(
      supabase,
      payoutItemId,
      SUBMISSION_ERROR.SOURCE_BALANCE_UNAVAILABLE,
      `Company Balance not AVAILABLE (${companyBalance.status_code})`,
    );
    return json({
      ok: false,
      error: SUBMISSION_ERROR.SOURCE_BALANCE_UNAVAILABLE,
      company_balance_status: companyBalance.status_code,
      source_account_label: companyBalance.source_account_label ?? null,
      driver_message: "Payout source is temporarily unavailable. Try again later.",
      revolut_pay_called: false,
    }, 409);
  }

  const amountGate = evaluateSourceAccountGate({
    source_account_id: companyBalance.source_account_id,
    currency: "GBP",
    available_pence: companyBalance.provider_available_balance_pence
      ?? companyBalance.provider_cash_balance_pence,
    amount_pence: providerTransferPence,
    account_active: true,
  });
  if (!amountGate.ok) {
    await releaseAndFailPreProvider(
      supabase,
      payoutItemId,
      amountGate.code,
      "Payout source cannot cover this withdrawal right now.",
    );
    return json({
      ok: false,
      error: amountGate.code,
      driver_message: "Payout source cannot cover this withdrawal right now.",
      revolut_pay_called: false,
    }, 409);
  }

  let accessToken: string;
  try {
    const tok = await ensureFreshRevolutBusinessAccessToken(supabase);
    accessToken = tok.accessToken;
  } catch (err) {
    await releaseAndFailPreProvider(
      supabase,
      payoutItemId,
      SUBMISSION_ERROR.ACCESS_TOKEN_REQUIRED,
      "Payout provider authentication unavailable.",
    );
    return json({
      ok: false,
      error: SUBMISSION_ERROR.ACCESS_TOKEN_REQUIRED,
      driver_message: "Payout provider authentication unavailable.",
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
    }, 500);
  }
  const claim = (claimRaw ?? {}) as Record<string, unknown>;
  if (claim.ok !== true) {
    if (String(claim.error ?? "") === SUBMISSION_ERROR.ALREADY_SUBMITTED) {
      const reconciled = await reconcileSubmittedDriverWithdrawPayout({
        supabase,
        payoutItemId,
        expectedDriverId: driverId,
      });
      return json({
        ok: reconciled.ok
          || reconciled.provider_state === "pending"
          || reconciled.provider_state === "created"
          || reconciled.already_applied,
        reused_existing_execution: true,
        reconciled: true,
        cashout: projectCashout({
          payoutItemId,
          amountPence,
          feePence,
          receivesPence: providerTransferPence,
          status: reconciled.item_status ?? "SUBMITTED",
          paidAt: reconciled.financially_applied ? new Date().toISOString() : null,
        }),
        payout_item_id: payoutItemId,
        provider_payment_id: reconciled.provider_payment_id,
        provider_state: reconciled.provider_state,
        wallet_debited: reconciled.wallet_debited,
        reservation_consumed: reconciled.reservation_consumed,
        revolut_pay_called: false,
      });
    }
    return json({
      ok: false,
      error: claim.error ?? SUBMISSION_ERROR.CLAIM_CONFLICT,
      driver_message: "Could not start provider submission.",
      revolut_pay_called: false,
    }, 409);
  }

  const paymentBody: Record<string, unknown> = {
    payout_item_id: String(claim.payout_item_id),
    driver_id: String(claim.driver_id),
    payout_destination_id: String(claim.payout_destination_id),
    source_account_id: String(claim.source_account_id),
    provider_counterparty_id: String(claim.provider_counterparty_id),
    provider_recipient_account_id: String(claim.provider_recipient_account_id),
    // Provider transfer is net of withdrawal fee (SSOT: driver_receives).
    amount_pence: providerTransferPence,
    currency: String(claim.currency ?? "GBP"),
    payment_reference: claim.payment_reference ?? `ONECAB WD ${String(payoutItemId).slice(0, 8)}`,
    provider_request_id: canonicalProviderRequestId(String(claim.payout_item_id)),
    idempotency_key: canonicalIdempotencyKey(String(claim.payout_item_id)),
  };

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
      driver_message: validated.message,
      revolut_pay_called: false,
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
      driver_message: "Payout transport unavailable.",
      revolut_pay_called: false,
      reservation_kept_active: true,
    }, 503);
  }

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

  const providerPaymentId = relayResult.provider_payment_id
    ?? (typeof relayResult.json?.id === "string" ? String(relayResult.json.id) : null);
  const providerState = relayResult.provider_state
    ?? (typeof relayResult.json?.state === "string" ? String(relayResult.json.state) : null);
  const providerCreatedAt = typeof relayResult.json?.created_at === "string"
    ? String(relayResult.json.created_at)
    : null;

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

  await supabase.rpc("finalize_driver_payout_submission", {
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
  });

  let walletDebited = false;
  let finalStatus = outcome.item_status;
  let paidAt: string | null = null;
  let finalProviderState = providerState;

  if (
    !outcome.release_reservation
    && providerPaymentId
    && String(providerState ?? "").toLowerCase() === "completed"
  ) {
    const { data: completionRaw } = await supabase.rpc("finalize_driver_payout_completion", {
      p_payout_item_id: payoutItemId,
      p_provider_payment_id: providerPaymentId,
      p_provider_state: providerState,
      p_provider_completed_at: providerCreatedAt,
      p_evidence_redacted: evidence,
    });
    const completion = (completionRaw ?? {}) as Record<string, unknown>;
    if (completion.ok === true) {
      walletDebited = true;
      finalStatus = "COMPLETED";
      paidAt = new Date().toISOString();
    }
  } else if (
    !outcome.release_reservation
    && providerPaymentId
    && String(providerState ?? "").toLowerCase() !== "completed"
    && (outcome.execution_status === "SUBMITTED" || outcome.execution_status === "UNKNOWN")
  ) {
    // Immediate read-only status sync — never second /pay.
    const reconciled = await reconcileSubmittedDriverWithdrawPayout({
      supabase,
      payoutItemId,
      expectedDriverId: driverId,
    });
    finalProviderState = reconciled.provider_state ?? providerState;
    if (reconciled.financially_applied) {
      walletDebited = true;
      finalStatus = "COMPLETED";
      paidAt = new Date().toISOString();
    }
  }

  const ok = outcome.execution_status === "SUBMITTED"
    || outcome.execution_status === "UNKNOWN"
    || walletDebited;

  return json({
    ok,
    cashout: projectCashout({
      payoutItemId,
      amountPence,
      feePence,
      receivesPence: providerTransferPence,
      status: finalStatus,
      paidAt,
      failedAt: outcome.release_reservation ? new Date().toISOString() : null,
      failureReason: outcome.release_reservation
        ? String(relayResult.error ?? "provider rejected")
        : null,
    }),
    payout_item_id: payoutItemId,
    provider_payment_id: providerPaymentId,
    provider_payment_id_masked: maskProviderId(providerPaymentId),
    provider_state: finalProviderState,
    provider_request_id: validated.normalized.provider_request_id,
    execution_status: outcome.execution_status,
    reservation_active: outcome.keep_reservation_active && !walletDebited,
    wallet_debited: walletDebited,
    withdrawal_fee_pence: feePence,
    provider_transfer_pence: providerTransferPence,
    revolut_pay_called: relayResult.revolut_pay_called === true,
  }, ok ? 200 : 422);
});
