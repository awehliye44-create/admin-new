/**
 * Same-order Revolut incremental authorisation orchestrator.
 * ONE payment session → ONE primary order → zero or more increments.
 * Never creates a second provider order.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  claimPaymentSessionFinancialLock,
  releasePaymentSessionFinancialLock,
} from "./paymentSessionFinancialLockSSOT.ts";
import {
  buildRevolutIncrementBusinessKey,
  evaluateRevolutIncrementEligibility,
  planSameOrderIncrement,
  type IncrementEligibility,
} from "./revolutIncrementAuthorisationSSOT.ts";
import {
  incrementRevolutOrderAuthorisation,
  retrieveRevolutOrder,
  revolutProviderAuthorisedTotalPence,
  type ProviderEnvironment,
  type RevolutOrder,
} from "./revolutOrders.ts";

export type SameOrderIncrementSource =
  | "trip_modification"
  | "completion_capture"
  | "admin_increment"
  | "retry_worker";

export type SameOrderIncrementResult =
  | {
    ok: true;
    kind: "not_required" | "confirmed" | "already_confirmed";
    providerConfirmedTotalPence: number;
    sequenceNumber: number | null;
    businessKey: string | null;
    eligibility: IncrementEligibility | null;
  }
  | {
    ok: false;
    kind:
      | "lock_busy"
      | "ineligible"
      | "provider_limit"
      | "declined"
      | "unsupported"
      | "customer_action_required"
      | "unknown"
      | "retryable"
      | "terminal"
      | "persist_failed";
    message: string;
    providerConfirmedTotalPence: number;
    eligibility: IncrementEligibility | null;
    errorClassification: string;
  };

function maskId(id: string | null | undefined): string {
  const s = String(id ?? "");
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function logIncrementEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  console.log(JSON.stringify({ event, ...payload, ts: new Date().toISOString() }));
}

/**
 * Raise authorised total on the existing Revolut order to cover requiredTotalPence.
 * Provider state wins over local totals. Idempotent per target total business key.
 */
export async function executeSameOrderIncrement(args: {
  supabase: SupabaseClient;
  environment: ProviderEnvironment;
  secretKey: string;
  paymentSessionId: string;
  providerOrderId: string;
  requiredTotalPence: number;
  currency: string;
  source: SameOrderIncrementSource;
  reason?: string;
  owner: string;
  /** Kill switch — when false, returns unsupported for controlled fallback. */
  featureEnabled?: boolean;
}): Promise<SameOrderIncrementResult> {
  const sessionId = String(args.paymentSessionId).trim();
  const orderId = String(args.providerOrderId).trim();
  const required = Math.max(0, Math.round(Number(args.requiredTotalPence)));
  const currency = String(args.currency ?? "GBP").toUpperCase();
  const featureEnabled = args.featureEnabled !== false;

  if (!featureEnabled) {
    return {
      ok: false,
      kind: "unsupported",
      message: "Same-order incremental authorisation is disabled by feature flag.",
      providerConfirmedTotalPence: 0,
      eligibility: null,
      errorClassification: "FEATURE_DISABLED",
    };
  }

  const { data: session } = await args.supabase
    .from("payment_sessions")
    .select(
      "id, provider_order_id, authorised_amount_pence, total_authorised_amount_pence, "
        + "captured_amount_pence, currency, status, metadata, financial_operation_state",
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (!session) {
    return {
      ok: false,
      kind: "terminal",
      message: "Payment session not found",
      providerConfirmedTotalPence: 0,
      eligibility: null,
      errorClassification: "SESSION_NOT_FOUND",
    };
  }

  if (
    session.provider_order_id
    && String(session.provider_order_id) !== orderId
  ) {
    return {
      ok: false,
      kind: "terminal",
      message: "Provider order does not belong to this Payment Session",
      providerConfirmedTotalPence: 0,
      eligibility: null,
      errorClassification: "ORDER_SESSION_MISMATCH",
    };
  }

  const lock = await claimPaymentSessionFinancialLock(args.supabase, {
    paymentSessionId: sessionId,
    owner: args.owner,
    state: "INCREMENTING",
    operationKey: `increment:${orderId}:${required}`,
  });
  if (!lock.ok) {
    logIncrementEvent("increment_lock_busy", {
      payment_session_id: maskId(sessionId),
      provider_order_id: maskId(orderId),
      current_state: lock.currentState,
      source: args.source,
    });
    return {
      ok: false,
      kind: "lock_busy",
      message: `Financial operation busy (${lock.currentState ?? "unknown"})`,
      providerConfirmedTotalPence: Math.round(
        Number(session.total_authorised_amount_pence ?? session.authorised_amount_pence ?? 0),
      ),
      eligibility: null,
      errorClassification: "OPERATION_BUSY",
    };
  }

  logIncrementEvent("increment_lock_acquired", {
    payment_session_id: maskId(sessionId),
    provider_order_id: maskId(orderId),
    source: args.source,
  });

  try {
    let order: RevolutOrder;
    try {
      order = await retrieveRevolutOrder(args.environment, args.secretKey, orderId);
    } catch (err) {
      return {
        ok: false,
        kind: "unknown",
        message: `Failed to retrieve provider order: ${(err as Error).message}`,
        providerConfirmedTotalPence: Math.round(
          Number(session.total_authorised_amount_pence ?? 0),
        ),
        eligibility: null,
        errorClassification: "RETRIEVE_FAILED",
      };
    }

    const providerTotal = revolutProviderAuthorisedTotalPence(order);
    const orderCurrency = String(order.currency ?? "").toUpperCase();
    const sessionCurrency = String(session.currency ?? currency).toUpperCase();
    if (orderCurrency && sessionCurrency && orderCurrency !== sessionCurrency) {
      return {
        ok: false,
        kind: "terminal",
        message: `Currency mismatch: session ${sessionCurrency} vs provider ${orderCurrency}`,
        providerConfirmedTotalPence: providerTotal,
        eligibility: null,
        errorClassification: "CURRENCY_MISMATCH",
      };
    }
    if (orderCurrency && orderCurrency !== currency) {
      return {
        ok: false,
        kind: "terminal",
        message: `Requested currency ${currency} does not match provider order ${orderCurrency}`,
        providerConfirmedTotalPence: providerTotal,
        eligibility: null,
        errorClassification: "CURRENCY_MISMATCH",
      };
    }

    const localTotal = Math.round(
      Number(session.total_authorised_amount_pence ?? session.authorised_amount_pence ?? 0),
    );
    if (providerTotal > 0 && providerTotal !== localTotal) {
      logIncrementEvent("increment_reconciled_from_retrieve", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        previous_total: localTotal,
        confirmed_total: providerTotal,
        source: args.source,
      });
      await args.supabase
        .from("payment_sessions")
        .update({
          total_authorised_amount_pence: providerTotal,
          provider_state: String(order.state ?? "").toUpperCase() || null,
          provider_state_verified_at: new Date().toISOString(),
          provider_state_verified_by: "same_order_increment_retrieve",
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId);
    }

    const plan = planSameOrderIncrement({
      requiredTotalPence: required,
      providerConfirmedTotalPence: providerTotal,
    });
    if (plan.kind === "not_required") {
      logIncrementEvent("increment_not_required", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        confirmed_total: providerTotal,
        required_total: required,
        source: args.source,
      });
      return {
        ok: true,
        kind: "not_required",
        providerConfirmedTotalPence: providerTotal,
        sequenceNumber: null,
        businessKey: null,
        eligibility: null,
      };
    }

    const { count: localIncCount } = await args.supabase
      .from("payment_session_authorisations")
      .select("id", { count: "exact", head: true })
      .eq("payment_session_id", sessionId)
      .eq("provider_order_id", orderId)
      .in("status", ["confirmed", "pending", "ADDITIONAL_AUTHORISATION_PENDING", "ADDITIONAL_AUTHORISATION_CONFIRMED"]);

    const eligibility = evaluateRevolutIncrementEligibility({
      order,
      targetTotalAuthorisedPence: plan.targetTotalPence,
      initialAuthorisedPence: session.authorised_amount_pence,
      localIncrementCount: localIncCount ?? 0,
    });

    logIncrementEvent("increment_eligibility_checked", {
      payment_session_id: maskId(sessionId),
      provider_order_id: maskId(orderId),
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      payment_method_type: eligibility.paymentMethodType,
      increment_count: eligibility.incrementCount,
      source: args.source,
    });

    if (!eligibility.eligible) {
      const isLimit =
        eligibility.reason === "limit_count_exceeded"
        || eligibility.reason === "limit_amount_exceeded";
      if (isLimit) {
        logIncrementEvent("increment_limit_exceeded", {
          payment_session_id: maskId(sessionId),
          provider_order_id: maskId(orderId),
          reason: eligibility.reason,
          source: args.source,
        });
      }
      return {
        ok: false,
        kind: isLimit
          ? "provider_limit"
          : eligibility.reason === "unsupported_payment_method"
          || eligibility.reason === "wrong_authorisation_type"
          || eligibility.reason === "wrong_capture_mode"
          ? "unsupported"
          : eligibility.reason === "unknown_state"
          ? "unknown"
          : "ineligible",
        message: `Increment ineligible: ${eligibility.reason}`,
        providerConfirmedTotalPence: providerTotal,
        eligibility,
        errorClassification: isLimit
          ? "PROVIDER_INCREMENT_LIMIT_EXCEEDED"
          : eligibility.reason.toUpperCase(),
      };
    }

    const businessKey = buildRevolutIncrementBusinessKey({
      paymentSessionId: sessionId,
      providerOrderId: orderId,
      targetTotalAuthorisedPence: plan.targetTotalPence,
    });

    const { data: existingAuth } = await args.supabase
      .from("payment_session_authorisations")
      .select("*")
      .eq("payment_session_id", sessionId)
      .eq("provider_order_id", orderId)
      .eq("requested_target_total_pence", plan.targetTotalPence)
      .maybeSingle();

    if (
      existingAuth
      && ["confirmed", "ADDITIONAL_AUTHORISATION_CONFIRMED"].includes(
        String(existingAuth.status ?? ""),
      )
    ) {
      const confirmed = Math.round(
        Number(
          existingAuth.provider_confirmed_total_pence
            ?? existingAuth.cumulative_total_authorised_pence
            ?? plan.targetTotalPence,
        ),
      );
      logIncrementEvent("increment_existing_operation_reused", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        confirmed_total: confirmed,
        source: args.source,
      });
      logIncrementEvent("duplicate_increment_prevented", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        requested_target: plan.targetTotalPence,
        source: args.source,
      });
      return {
        ok: true,
        kind: "already_confirmed",
        providerConfirmedTotalPence: confirmed,
        sequenceNumber: existingAuth.sequence_number != null
          ? Number(existingAuth.sequence_number)
          : null,
        businessKey,
        eligibility,
      };
    }

    if (
      existingAuth
      && ["pending", "ADDITIONAL_AUTHORISATION_PENDING", "unknown"].includes(
        String(existingAuth.status ?? "").toLowerCase(),
      )
    ) {
      // Pending/unknown → retrieve already done; if still short, do not blind-retry.
      if (providerTotal >= plan.targetTotalPence) {
        await args.supabase
          .from("payment_session_authorisations")
          .update({
            status: "ADDITIONAL_AUTHORISATION_CONFIRMED",
            provider_confirmed_total_pence: providerTotal,
            confirmed_at: new Date().toISOString(),
          })
          .eq("id", existingAuth.id);
        await args.supabase
          .from("payment_sessions")
          .update({
            total_authorised_amount_pence: providerTotal,
            status: "ADDITIONAL_AUTHORISATION_CONFIRMED",
            updated_at: new Date().toISOString(),
          })
          .eq("id", sessionId);
        return {
          ok: true,
          kind: "confirmed",
          providerConfirmedTotalPence: providerTotal,
          sequenceNumber: existingAuth.sequence_number != null
            ? Number(existingAuth.sequence_number)
            : null,
          businessKey,
          eligibility,
        };
      }
      return {
        ok: false,
        kind: "unknown",
        message: "Prior increment still pending/unknown after retrieve; not submitting another.",
        providerConfirmedTotalPence: providerTotal,
        eligibility,
        errorClassification: "INCREMENT_PENDING_UNKNOWN",
      };
    }

    const sequenceNumber = (localIncCount ?? 0) + 1;
    const nowIso = new Date().toISOString();
    const providerPaymentId = Array.isArray(order.payments) && order.payments[0]
      ? String((order.payments[0] as { id?: string }).id ?? "").trim() || null
      : null;
    const authRow = {
      payment_session_id: sessionId,
      payment_provider: "revolut",
      provider_order_id: orderId,
      provider_payment_id: providerPaymentId,
      sequence_number: sequenceNumber,
      previous_authorised_total_pence: providerTotal,
      requested_increment_pence: plan.deltaPence,
      requested_target_total_pence: plan.targetTotalPence,
      authorised_amount_pence: plan.deltaPence,
      cumulative_total_authorised_pence: plan.targetTotalPence,
      currency,
      status: "ADDITIONAL_AUTHORISATION_PENDING",
      source: args.source,
      reason: args.reason ?? `same_order_increment_${args.source}`,
      idempotency_key: businessKey,
      submitted_at: nowIso,
      created_at: nowIso,
    };

    const { data: inserted, error: insertErr } = await args.supabase
      .from("payment_session_authorisations")
      .upsert(authRow, {
        onConflict: "payment_session_id,provider_order_id,requested_target_total_pence",
        ignoreDuplicates: false,
      })
      .select("id, sequence_number")
      .maybeSingle();

    if (insertErr) {
      // Unique conflict → reuse path
      const { data: raced } = await args.supabase
        .from("payment_session_authorisations")
        .select("*")
        .eq("idempotency_key", businessKey)
        .maybeSingle();
      if (
        raced
        && ["confirmed", "ADDITIONAL_AUTHORISATION_CONFIRMED"].includes(String(raced.status))
      ) {
        return {
          ok: true,
          kind: "already_confirmed",
          providerConfirmedTotalPence: Math.round(
            Number(raced.provider_confirmed_total_pence ?? plan.targetTotalPence),
          ),
          sequenceNumber: raced.sequence_number != null ? Number(raced.sequence_number) : null,
          businessKey,
          eligibility,
        };
      }
      return {
        ok: false,
        kind: "persist_failed",
        message: insertErr.message,
        providerConfirmedTotalPence: providerTotal,
        eligibility,
        errorClassification: "PERSIST_FAILED",
      };
    }

    await args.supabase
      .from("payment_sessions")
      .update({
        status: "ADDITIONAL_AUTHORISATION_PENDING",
        updated_at: nowIso,
      })
      .eq("id", sessionId);

    logIncrementEvent("increment_required", {
      payment_session_id: maskId(sessionId),
      provider_order_id: maskId(orderId),
      sequence_number: sequenceNumber,
      previous_total: providerTotal,
      requested_target: plan.targetTotalPence,
      currency,
      source: args.source,
    });
    logIncrementEvent("increment_provider_request_started", {
      payment_session_id: maskId(sessionId),
      provider_order_id: maskId(orderId),
      requested_target: plan.targetTotalPence,
      source: args.source,
    });

    const started = Date.now();
    const result = await incrementRevolutOrderAuthorisation({
      environment: args.environment,
      secretKey: args.secretKey,
      orderId,
      targetTotalAuthorisedPence: plan.targetTotalPence,
      currency,
      reference: businessKey.slice(0, 100),
      previousAuthorisedPence: providerTotal,
    });
    const elapsed = Date.now() - started;

    if (result.ok && result.outcome === "confirmed") {
      const confirmed = result.providerConfirmedTotalPence;
      await args.supabase
        .from("payment_session_authorisations")
        .update({
          status: "ADDITIONAL_AUTHORISATION_CONFIRMED",
          provider_confirmed_total_pence: confirmed,
          cumulative_total_authorised_pence: confirmed,
          confirmed_at: new Date().toISOString(),
          provider_operation_reference: result.order?.id ?? null,
        })
        .eq("id", inserted?.id ?? existingAuth?.id);

      await args.supabase
        .from("payment_sessions")
        .update({
          total_authorised_amount_pence: confirmed,
          provider_state: String(result.order?.state ?? "AUTHORISED").toUpperCase(),
          // Return to authorised hold after confirmed increment (lifecycle SSOT).
          status: "authorised_hold",
          provider_state_verified_at: new Date().toISOString(),
          provider_state_verified_by: "same_order_increment_api",
          updated_at: new Date().toISOString(),
          metadata: {
            ...((session.metadata && typeof session.metadata === "object")
              ? session.metadata as Record<string, unknown>
              : {}),
            last_increment_business_key: businessKey,
            last_increment_confirmed_total_pence: confirmed,
            last_increment_at: new Date().toISOString(),
            last_increment_status: "ADDITIONAL_AUTHORISATION_CONFIRMED",
          },
        })
        .eq("id", sessionId);

      logIncrementEvent("increment_provider_confirmed", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        sequence_number: sequenceNumber,
        previous_total: providerTotal,
        confirmed_total: confirmed,
        currency,
        source: args.source,
        elapsed_ms: elapsed,
      });

      return {
        ok: true,
        kind: "confirmed",
        providerConfirmedTotalPence: confirmed,
        sequenceNumber,
        businessKey,
        eligibility,
      };
    }

    if (result.ok && result.outcome === "processing") {
      logIncrementEvent("increment_provider_unknown", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        requested_target: plan.targetTotalPence,
        source: args.source,
        elapsed_ms: elapsed,
        decision_reason: "processing",
      });
      await args.supabase
        .from("payment_session_authorisations")
        .update({
          status: "ADDITIONAL_AUTHORISATION_PENDING",
          error_classification: "PROCESSING",
        })
        .eq("id", inserted?.id);
      return {
        ok: false,
        kind: "unknown",
        message: "Increment is processing; retrieve required before retry or fallback.",
        providerConfirmedTotalPence: result.providerConfirmedTotalPence,
        eligibility,
        errorClassification: "PROCESSING",
      };
    }

    // Failure outcomes only below.
    const failOutcome = !result.ok ? result.outcome : "unknown";
    const failMessage = !result.ok ? result.message : "Increment failed";
    const failCode = !result.ok ? result.errorCode : null;

    if (failOutcome === "customer_action_required") {
      logIncrementEvent("increment_customer_action_required", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        requested_target: plan.targetTotalPence,
        source: args.source,
        elapsed_ms: elapsed,
      });
      await args.supabase
        .from("payment_session_authorisations")
        .update({
          status: "ADDITIONAL_AUTHORISATION_ACTION_REQUIRED",
          error_classification: "CUSTOMER_ACTION_REQUIRED",
        })
        .eq("id", inserted?.id);
      return {
        ok: false,
        kind: "customer_action_required",
        message: failMessage,
        providerConfirmedTotalPence: result.providerConfirmedTotalPence,
        eligibility,
        errorClassification: "CUSTOMER_ACTION_REQUIRED",
      };
    }

    const failKind =
      failOutcome === "declined"
        ? "declined"
        : failOutcome === "unsupported"
        ? "unsupported"
        : failOutcome === "retryable"
        ? "retryable"
        : failOutcome === "unknown"
        ? "unknown"
        : "terminal";

    logIncrementEvent(
      failOutcome === "declined" ? "increment_provider_declined" : "increment_provider_unknown",
      {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        outcome: failOutcome,
        source: args.source,
        elapsed_ms: elapsed,
      },
    );

    await args.supabase
      .from("payment_session_authorisations")
      .update({
        status: failKind === "declined"
          ? "ADDITIONAL_AUTHORISATION_DECLINED"
          : failKind === "unsupported"
          ? "ADDITIONAL_AUTHORISATION_UNSUPPORTED"
          : failKind === "retryable"
          ? "ADDITIONAL_AUTHORISATION_FAILED_RETRYABLE"
          : "ADDITIONAL_AUTHORISATION_FAILED_TERMINAL",
        failed_at: new Date().toISOString(),
        error_classification: failCode ?? failOutcome,
      })
      .eq("id", inserted?.id);

    await args.supabase
      .from("payment_sessions")
      .update({
        status: failKind === "declined"
          ? "ADDITIONAL_AUTHORISATION_DECLINED"
          : "ADDITIONAL_AUTHORISATION_REQUIRED",
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);

    return {
      ok: false,
      kind: failKind,
      message: failMessage,
      providerConfirmedTotalPence: result.providerConfirmedTotalPence,
      eligibility,
      errorClassification: failCode ?? String(failOutcome).toUpperCase(),
    };
  } finally {
    await releasePaymentSessionFinancialLock(args.supabase, {
      paymentSessionId: sessionId,
      owner: args.owner,
      nextState: "IDLE",
    });
  }
}
