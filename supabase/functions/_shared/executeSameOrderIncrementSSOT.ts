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
  isConfirmedIncrementRowStatus,
  isPriorIncrementAttemptStatus,
  planSameOrderIncrement,
  type IncrementEligibility,
} from "./revolutIncrementAuthorisationSSOT.ts";
import {
  classifyIncrementCoverage,
  incrementRevolutOrderAuthorisation,
  listRevolutOrderPayments,
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

function paymentsLackAuthorisedTotal(
  order: RevolutOrder | null | undefined,
): boolean {
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  if (payments.length === 0) return true;
  return payments.every((payment) => {
    const n = Math.round(Number(payment?.authorised_amount));
    return !Number.isFinite(n) || n <= 0;
  });
}

async function hydrateOrderPayments(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  orderId: string;
  order: RevolutOrder;
  sessionId: string;
}): Promise<RevolutOrder> {
  if (!paymentsLackAuthorisedTotal(args.order)) return args.order;
  try {
    const payments = await listRevolutOrderPayments(
      args.environment,
      args.secretKey,
      args.orderId,
    );
    if (payments.length === 0) return args.order;
    return {
      ...args.order,
      payments: payments.map((p) => ({
        id: p.id,
        state: p.state,
        amount: p.amount,
        authorised_amount: p.authorised_amount,
        payment_method: p.payment_method
          ? { type: p.payment_method.type, card_brand: p.payment_method.card_brand }
          : undefined,
      })),
    };
  } catch (payErr) {
    logIncrementEvent("increment_payments_hydrate_failed", {
      payment_session_id: maskId(args.sessionId),
      provider_order_id: maskId(args.orderId),
      message: (payErr as Error).message,
    });
    return args.order;
  }
}

async function persistConfirmedIncrementProjection(args: {
  supabase: SupabaseClient;
  sessionId: string;
  incrementRowId: string | null | undefined;
  confirmed: number;
  providerState: string | null;
  businessKey: string;
  sessionMetadata: Record<string, unknown>;
  verifiedBy: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const nowIso = new Date().toISOString();
  if (args.incrementRowId) {
    const { error: authErr } = await args.supabase
      .from("payment_session_authorisations")
      .update({
        status: "ADDITIONAL_AUTHORISATION_CONFIRMED",
        provider_confirmed_total_pence: args.confirmed,
        cumulative_total_authorised_pence: args.confirmed,
        provider_operation_reference: args.businessKey,
        error_classification: null,
        failed_at: null,
      })
      .eq("id", args.incrementRowId);
    if (authErr) {
      return { ok: false, message: authErr.message };
    }
  }
  const { error: sessErr } = await args.supabase
    .from("payment_sessions")
    .update({
      total_authorised_amount_pence: args.confirmed,
      provider_state: args.providerState ?? "AUTHORISED",
      status: "authorised_hold",
      provider_state_verified_at: nowIso,
      provider_state_verified_by: args.verifiedBy,
      updated_at: nowIso,
      metadata: {
        ...args.sessionMetadata,
        last_increment_business_key: args.businessKey,
        last_increment_confirmed_total_pence: args.confirmed,
        last_increment_at: nowIso,
        last_increment_status: "ADDITIONAL_AUTHORISATION_CONFIRMED",
      },
    })
    .eq("id", args.sessionId);
  if (sessErr) {
    return { ok: false, message: sessErr.message };
  }
  return { ok: true };
}

/**
 * Raise authorised total on the existing Revolut order to cover requiredTotalPence.
 * Provider state wins over local totals. Idempotent per target total business key.
 *
 * PRIMARY path: persist pending row → POST increment (target TOTAL) → confirm.
 * persist_failed means Revolut was never asked — retry/reconcile this path.
 * Do not treat persist_failed as a provider decline.
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
  /** Trip/session payment method when retrieve omits payments[].payment_method. */
  fallbackPaymentMethodType?: string | null;
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

    order = await hydrateOrderPayments({
      environment: args.environment,
      secretKey: args.secretKey,
      orderId,
      order,
      sessionId,
    });

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
      const businessKey = buildRevolutIncrementBusinessKey({
        paymentSessionId: sessionId,
        providerOrderId: orderId,
        targetTotalAuthorisedPence: required,
      });
      const { data: existingCovered } = await args.supabase
        .from("payment_session_authorisations")
        .select("id, status, sequence_number")
        .eq("payment_session_id", sessionId)
        .eq("provider_order_id", orderId)
        .eq("requested_target_total_pence", required)
        .maybeSingle();
      if (existingCovered && isPriorIncrementAttemptStatus(existingCovered.status)) {
        const sessionMetadata = (session.metadata && typeof session.metadata === "object")
          ? session.metadata as Record<string, unknown>
          : {};
        const persisted = await persistConfirmedIncrementProjection({
          supabase: args.supabase,
          sessionId,
          incrementRowId: existingCovered.id,
          confirmed: providerTotal,
          providerState: String(order.state ?? "AUTHORISED").toUpperCase(),
          businessKey,
          sessionMetadata,
          verifiedBy: "same_order_increment_retrieve",
        });
        if (!persisted.ok) {
          return {
            ok: false,
            kind: "persist_failed",
            message: "Provider authorised the increase but local confirmation failed",
            providerConfirmedTotalPence: providerTotal,
            eligibility: null,
            errorClassification: "INCREMENT_CONFIRM_PERSIST_FAILED",
          };
        }
      }
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
        sequenceNumber: existingCovered?.sequence_number != null
          ? Number(existingCovered.sequence_number)
          : null,
        businessKey,
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
      fallbackPaymentMethodType: args.fallbackPaymentMethodType ?? null,
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

    if (existingAuth && isConfirmedIncrementRowStatus(existingAuth.status)) {
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

    if (existingAuth && isPriorIncrementAttemptStatus(existingAuth.status)) {
      // Prior POST may already have succeeded (018 FAILED_TERMINAL). Never POST again.
      const sessionMetadata = (session.metadata && typeof session.metadata === "object")
        ? session.metadata as Record<string, unknown>
        : {};
      const priorCoverage = classifyIncrementCoverage(order, plan.targetTotalPence);
      const confirmedFromPrior = priorCoverage.class === "confirmed"
        ? priorCoverage.authorisedTotalPence
        : providerTotal >= plan.targetTotalPence
        ? providerTotal
        : 0;
      if (confirmedFromPrior >= plan.targetTotalPence) {
        const persisted = await persistConfirmedIncrementProjection({
          supabase: args.supabase,
          sessionId,
          incrementRowId: existingAuth.id,
          confirmed: confirmedFromPrior,
          providerState: String(order.state ?? "AUTHORISED").toUpperCase(),
          businessKey,
          sessionMetadata,
          verifiedBy: "same_order_increment_retrieve",
        });
        if (!persisted.ok) {
          return {
            ok: false,
            kind: "persist_failed",
            message: "Provider authorised the increase but local confirmation failed",
            providerConfirmedTotalPence: confirmedFromPrior,
            eligibility,
            errorClassification: "INCREMENT_CONFIRM_PERSIST_FAILED",
          };
        }
        logIncrementEvent("duplicate_increment_prevented", {
          payment_session_id: maskId(sessionId),
          provider_order_id: maskId(orderId),
          requested_target: plan.targetTotalPence,
          source: args.source,
          prior_status: existingAuth.status,
        });
        return {
          ok: true,
          kind: "confirmed",
          providerConfirmedTotalPence: confirmedFromPrior,
          sequenceNumber: existingAuth.sequence_number != null
            ? Number(existingAuth.sequence_number)
            : null,
          businessKey,
          eligibility,
        };
      }
      logIncrementEvent("increment_prior_attempt_no_second_post", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        prior_status: existingAuth.status,
        coverage_class: priorCoverage.class,
        source: args.source,
      });
      if (priorCoverage.class === "insufficient") {
        return {
          ok: false,
          kind: "declined",
          message: "Provider authorised total remains below the required fare.",
          providerConfirmedTotalPence: providerTotal,
          eligibility,
          errorClassification: "AUTHORISED_TOTAL_BELOW_TARGET",
        };
      }
      return {
        ok: false,
        kind: "unknown",
        message: "Prior increment still pending/unknown after retrieve; not submitting another.",
        providerConfirmedTotalPence: providerTotal,
        eligibility,
        errorClassification: "AUTHORISATION_RECONCILIATION_PENDING",
      };
    }

    const sequenceNumber = (localIncCount ?? 0) + 1;
    const nowIso = new Date().toISOString();
    const providerPaymentId = Array.isArray(order.payments) && order.payments[0]
      ? String((order.payments[0] as { id?: string }).id ?? "").trim() || null
      : null;
    // Plain insert — do not upsert on a guessed unique target.
    // persist_failed is an INTERNAL failure before Revolut is asked; never treat it
    // as a provider decline / safe-capture fallback.
    const incrementReason = args.reason ?? `same_order_increment_${args.source}`;
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
      authorised_at: nowIso,
      cumulative_total_authorised_pence: plan.targetTotalPence,
      currency,
      status: "ADDITIONAL_AUTHORISATION_PENDING",
      source: args.source,
      idempotency_key: businessKey,
      submitted_at: nowIso,
      created_at: nowIso,
      metadata: {
        reason: incrementReason,
        source: args.source,
        requested_target_total_pence: plan.targetTotalPence,
      },
    };

    const { data: inserted, error: insertErr } = await args.supabase
      .from("payment_session_authorisations")
      .insert(authRow)
      .select("id, sequence_number")
      .maybeSingle();

    if (insertErr) {
      const { data: racedByKey } = await args.supabase
        .from("payment_session_authorisations")
        .select("*")
        .eq("idempotency_key", businessKey)
        .maybeSingle();
      const raced = racedByKey ?? existingAuth;
      if (raced && isConfirmedIncrementRowStatus(raced.status)) {
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
      if (raced && isPriorIncrementAttemptStatus(raced.status)) {
        const racedCoverage = classifyIncrementCoverage(order, plan.targetTotalPence);
        const confirmedFromRace = racedCoverage.class === "confirmed"
          ? racedCoverage.authorisedTotalPence
          : providerTotal >= plan.targetTotalPence
          ? providerTotal
          : 0;
        if (confirmedFromRace >= plan.targetTotalPence) {
          const sessionMetadata = (session.metadata && typeof session.metadata === "object")
            ? session.metadata as Record<string, unknown>
            : {};
          const persisted = await persistConfirmedIncrementProjection({
            supabase: args.supabase,
            sessionId,
            incrementRowId: raced.id,
            confirmed: confirmedFromRace,
            providerState: String(order.state ?? "AUTHORISED").toUpperCase(),
            businessKey,
            sessionMetadata,
            verifiedBy: "same_order_increment_retrieve",
          });
          if (!persisted.ok) {
            return {
              ok: false,
              kind: "persist_failed",
              message: "Provider authorised the increase but local confirmation failed",
              providerConfirmedTotalPence: confirmedFromRace,
              eligibility,
              errorClassification: "INCREMENT_CONFIRM_PERSIST_FAILED",
            };
          }
          return {
            ok: true,
            kind: "already_confirmed",
            providerConfirmedTotalPence: confirmedFromRace,
            sequenceNumber: raced.sequence_number != null ? Number(raced.sequence_number) : null,
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
          errorClassification: "AUTHORISATION_RECONCILIATION_PENDING",
        };
      }
      logIncrementEvent("increment_persist_failed", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        requested_target: plan.targetTotalPence,
        source: args.source,
        message: insertErr.message,
      });
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
    const incrementRowId = inserted?.id ?? existingAuth?.id ?? null;
    const sessionMetadata = (session.metadata && typeof session.metadata === "object")
      ? session.metadata as Record<string, unknown>
      : {};

    let coverage = classifyIncrementCoverage(result.order, plan.targetTotalPence);
    let coverageOrder = result.order;
    if (coverage.class !== "confirmed") {
      // Ambiguous POST — GET the same order. Never POST a second increment.
      try {
        coverageOrder = await retrieveRevolutOrder(
          args.environment,
          args.secretKey,
          orderId,
        );
        coverageOrder = await hydrateOrderPayments({
          environment: args.environment,
          secretKey: args.secretKey,
          orderId,
          order: coverageOrder,
          sessionId,
        });
        coverage = classifyIncrementCoverage(coverageOrder, plan.targetTotalPence);
        logIncrementEvent("increment_post_retrieve_reconcile", {
          payment_session_id: maskId(sessionId),
          provider_order_id: maskId(orderId),
          requested_target: plan.targetTotalPence,
          coverage_class: coverage.class,
          confirmed_total: coverage.authorisedTotalPence,
          source: args.source,
          elapsed_ms: elapsed,
        });
        // Same-order GET only. Revolut increment bookkeeping can lag the card
        // hold by a few hundred ms (MK-260815-020). Never POST again.
        let retrieveAttempt = 0;
        while (
          coverage.class !== "confirmed"
          && (coverage.class === "processing" || coverage.class === "unknown")
          && retrieveAttempt < 3
        ) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          retrieveAttempt += 1;
          coverageOrder = await retrieveRevolutOrder(
            args.environment,
            args.secretKey,
            orderId,
          );
          coverageOrder = await hydrateOrderPayments({
            environment: args.environment,
            secretKey: args.secretKey,
            orderId,
            order: coverageOrder,
            sessionId,
          });
          coverage = classifyIncrementCoverage(coverageOrder, plan.targetTotalPence);
          logIncrementEvent("increment_post_retrieve_retry", {
            payment_session_id: maskId(sessionId),
            provider_order_id: maskId(orderId),
            requested_target: plan.targetTotalPence,
            coverage_class: coverage.class,
            confirmed_total: coverage.authorisedTotalPence,
            attempt: retrieveAttempt,
            source: args.source,
          });
        }
      } catch (retrieveErr) {
        logIncrementEvent("increment_post_retrieve_failed", {
          payment_session_id: maskId(sessionId),
          provider_order_id: maskId(orderId),
          message: (retrieveErr as Error).message,
          source: args.source,
        });
        await args.supabase
          .from("payment_session_authorisations")
          .update({
            status: "ADDITIONAL_AUTHORISATION_PENDING",
            error_classification: "AUTHORISATION_RECONCILIATION_PENDING",
          })
          .eq("id", incrementRowId);
        return {
          ok: false,
          kind: "unknown",
          message: "Increment response was ambiguous and provider retrieve failed.",
          providerConfirmedTotalPence: coverage.authorisedTotalPence,
          eligibility,
          errorClassification: "AUTHORISATION_RECONCILIATION_PENDING",
        };
      }
    }

    if (coverage.class === "confirmed") {
      const confirmed = coverage.authorisedTotalPence;
      const persisted = await persistConfirmedIncrementProjection({
        supabase: args.supabase,
        sessionId,
        incrementRowId,
        confirmed,
        providerState: String(coverageOrder?.state ?? "AUTHORISED").toUpperCase(),
        businessKey,
        sessionMetadata,
        verifiedBy: result.ok && result.outcome === "confirmed"
          ? "same_order_increment_api"
          : "same_order_increment_retrieve",
      });
      if (!persisted.ok) {
        logIncrementEvent("increment_confirm_persist_failed", {
          payment_session_id: maskId(sessionId),
          provider_order_id: maskId(orderId),
          confirmed_total: confirmed,
          message: persisted.message,
          source: args.source,
        });
        return {
          ok: false,
          kind: "persist_failed",
          message: "Provider authorised the increase but local confirmation failed",
          providerConfirmedTotalPence: confirmed,
          eligibility,
          errorClassification: "INCREMENT_CONFIRM_PERSIST_FAILED",
        };
      }

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

    if (coverage.class === "processing" || coverage.class === "unknown") {
      logIncrementEvent("increment_provider_unknown", {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        requested_target: plan.targetTotalPence,
        source: args.source,
        elapsed_ms: elapsed,
        decision_reason: coverage.class,
      });
      await args.supabase
        .from("payment_session_authorisations")
        .update({
          status: "ADDITIONAL_AUTHORISATION_PENDING",
          error_classification: coverage.class === "processing"
            ? "PROCESSING"
            : "AUTHORISATION_RECONCILIATION_PENDING",
        })
        .eq("id", incrementRowId);
      return {
        ok: false,
        kind: "unknown",
        message: coverage.class === "processing"
          ? "Increment is processing; retrieve required before retry or fallback."
          : "Increment authorised total is still ambiguous after retrieve.",
        providerConfirmedTotalPence: coverage.authorisedTotalPence,
        eligibility,
        errorClassification: coverage.class === "processing"
          ? "PROCESSING"
          : "AUTHORISATION_RECONCILIATION_PENDING",
      };
    }

    // Failure outcomes only below. Provider retrieve proved authorised total < target.
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
        .eq("id", incrementRowId);
      return {
        ok: false,
        kind: "customer_action_required",
        message: failMessage,
        providerConfirmedTotalPence: coverage.authorisedTotalPence,
        eligibility,
        errorClassification: "CUSTOMER_ACTION_REQUIRED",
      };
    }

    const failKind =
      failOutcome === "unsupported"
        ? "unsupported"
        : failOutcome === "retryable"
        ? "retryable"
        : coverage.class === "insufficient" || failOutcome === "declined"
        ? "declined"
        : failOutcome === "unknown"
        ? "unknown"
        : "terminal";

    logIncrementEvent(
      failKind === "declined" ? "increment_provider_declined" : "increment_provider_unknown",
      {
        payment_session_id: maskId(sessionId),
        provider_order_id: maskId(orderId),
        outcome: failOutcome,
        coverage_class: coverage.class,
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
          : failKind === "unknown"
          ? "ADDITIONAL_AUTHORISATION_PENDING"
          : "ADDITIONAL_AUTHORISATION_FAILED_TERMINAL",
        failed_at: failKind === "unknown" ? null : new Date().toISOString(),
        error_classification: failKind === "declined"
          ? "AUTHORISED_TOTAL_BELOW_TARGET"
          : failCode ?? failOutcome,
      })
      .eq("id", incrementRowId);

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
      message: failKind === "declined"
        ? "Provider authorised total remains below the required fare."
        : failMessage,
      providerConfirmedTotalPence: coverage.authorisedTotalPence,
      eligibility,
      errorClassification: failKind === "declined"
        ? "AUTHORISED_TOTAL_BELOW_TARGET"
        : failCode ?? String(failOutcome).toUpperCase(),
    };
  } finally {
    await releasePaymentSessionFinancialLock(args.supabase, {
      paymentSessionId: sessionId,
      owner: args.owner,
      nextState: "IDLE",
    });
  }
}
