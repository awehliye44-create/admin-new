/**
 * Apply saved-card provider order truth onto a payment_sessions row.
 * Shared by reconcile-payment-session, confirm-revolut-payment, and webhook
 * payment-level failure enrichment.
 *
 * NEVER creates a new Revolut order / payment. NEVER deletes cards.
 * NEVER creates trips or posts ledger.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { applyPaymentSessionWebhookLifecycleUpdate } from "./applyPaymentSessionWebhookLifecycleUpdate.ts";
import { markPaymentSessionAuthorised } from "./paymentSessionSSOT.ts";
import {
  retrieveRevolutOrder,
  type RevolutOrder,
} from "./revolutOrders.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import {
  buildSavedCardPendingHandoff,
  computeTerminalFailureRetryAfterMs,
  mapSavedCardProviderOrderToReconcileState,
  SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS,
  type SavedCardReconcileClientState,
  type SavedCardReconcileMapping,
  verifySavedCardReconcileToken,
} from "./savedCardPaymentReconcileSSOT.ts";

export type ApplySavedCardOrderReconcileArgs = {
  supabase: SupabaseClient;
  session: Record<string, unknown>;
  order: RevolutOrder;
  /** Who is applying — for provider_state_verified_by. */
  verifiedBy: "reconcile" | "confirm" | "webhook" | "create_preauth";
  /** When true, skip DB writes (mapper-only). */
  dryRun?: boolean;
};

export type ApplySavedCardOrderReconcileResult = {
  mapping: SavedCardReconcileMapping;
  session_id: string;
  client_action_id: string | null;
  provider_order_id: string;
  previous_status: string;
  applied: boolean;
  terminalized: boolean;
  retry_after_ms: number;
  client_payload: Record<string, unknown>;
};

function sessionMeta(session: Record<string, unknown>): Record<string, unknown> {
  return session.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
}

export async function applySavedCardOrderReconcile(
  args: ApplySavedCardOrderReconcileArgs,
): Promise<ApplySavedCardOrderReconcileResult> {
  const mapping = mapSavedCardProviderOrderToReconcileState({
    id: args.order.id,
    state: args.order.state,
    payments: (args.order.payments ?? []).map((p) => ({
      id: p?.id ?? null,
      state: p?.state ?? null,
      decline_reason: (p as { decline_reason?: string | null })?.decline_reason ?? null,
      authentication_challenge: (p as {
        authentication_challenge?: { acs_url?: string | null };
      })?.authentication_challenge ?? null,
    })),
  });

  const sessionId = String(args.session.id ?? "");
  const clientActionId = args.session.client_action_id
    ? String(args.session.client_action_id)
    : null;
  const providerOrderId = String(
    args.session.provider_order_id ?? args.order.id ?? "",
  );
  const previousStatus = String(args.session.status ?? "");
  const nowIso = new Date().toISOString();
  const meta = sessionMeta(args.session);

  let applied = false;
  let terminalized = false;

  if (!args.dryRun && mapping.client_state === "AUTHORISED") {
    await markPaymentSessionAuthorised(args.supabase, {
      providerOrderId,
      clientActionId,
    });
    applied = true;
  } else if (!args.dryRun && mapping.terminal) {
    const lifecycle = await applyPaymentSessionWebhookLifecycleUpdate({
      supabase: args.supabase,
      context: {
        sessionId,
        tripId: (args.session.trip_id as string | null) ?? null,
        providerOrderId,
        currentStatus: previousStatus,
        financialOperationState:
          (args.session.financial_operation_state as string | null) ?? null,
        purpose: (args.session.purpose as string | null) ?? null,
        storedCapturedAmountPence:
          (args.session.captured_amount_pence as number | null) ?? null,
        refundedAmountPence:
          (args.session.refunded_amount_pence as number | null) ?? null,
        holdReleaseState:
          (args.session.hold_release_state as string | null) ?? null,
        storedProviderCaptureId:
          (args.session.provider_capture_id as string | null) ?? null,
        storedProviderOrderId:
          (args.session.provider_order_id as string | null) ?? providerOrderId,
        priorProviderState:
          (args.session.provider_state as string | null) ?? null,
      },
      providerState: mapping.lifecycle_provider_state,
      providerEvidencePatch: {
        provider_state: mapping.lifecycle_provider_state,
        provider_state_verified_at: nowIso,
        provider_state_verified_by: args.verifiedBy,
        metadata: {
          ...meta,
          saved_card_reconcile_client_state: mapping.client_state,
          saved_card_reconcile_payment_state: mapping.payment_state,
          saved_card_reconcile_decline_reason: mapping.decline_reason,
          saved_card_reconcile_at: nowIso,
          saved_card_terminal_failed_at: nowIso,
          saved_card_preserve_card: mapping.preserve_saved_card,
          // Throttle marker for fresh Book after terminal failure.
          saved_card_terminal_throttle_ms: SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS,
        },
        updated_at: nowIso,
      },
      statusAdvanceExtras: {
        failure_reason: mapping.failure_reason,
      },
    });
    applied = lifecycle.applied;
    terminalized = lifecycle.decision === "ADVANCE" ||
      lifecycle.reason.includes("terminal_negative_idempotent") ||
      lifecycle.reason.includes("already_terminal");
  } else if (!args.dryRun && mapping.client_state === "PAYMENT_PROCESSING") {
    // Evidence-only — keep pending_payment; stamp last reconcile.
    await applyPaymentSessionWebhookLifecycleUpdate({
      supabase: args.supabase,
      context: {
        sessionId,
        tripId: (args.session.trip_id as string | null) ?? null,
        providerOrderId,
        currentStatus: previousStatus,
        financialOperationState:
          (args.session.financial_operation_state as string | null) ?? null,
        purpose: (args.session.purpose as string | null) ?? null,
        storedCapturedAmountPence:
          (args.session.captured_amount_pence as number | null) ?? null,
        refundedAmountPence:
          (args.session.refunded_amount_pence as number | null) ?? null,
        holdReleaseState:
          (args.session.hold_release_state as string | null) ?? null,
        storedProviderCaptureId:
          (args.session.provider_capture_id as string | null) ?? null,
        storedProviderOrderId:
          (args.session.provider_order_id as string | null) ?? providerOrderId,
        priorProviderState:
          (args.session.provider_state as string | null) ?? null,
      },
      providerState: mapping.lifecycle_provider_state,
      providerEvidencePatch: {
        provider_state: mapping.lifecycle_provider_state,
        provider_state_verified_at: nowIso,
        provider_state_verified_by: args.verifiedBy,
        metadata: {
          ...meta,
          saved_card_reconcile_client_state: mapping.client_state,
          saved_card_reconcile_payment_state: mapping.payment_state,
          saved_card_reconcile_at: nowIso,
        },
        updated_at: nowIso,
      },
    });
    applied = true;
  }

  const failedAt = mapping.terminal
    ? nowIso
    : (typeof meta.saved_card_terminal_failed_at === "string"
      ? meta.saved_card_terminal_failed_at
      : null);
  const retryAfterMs = mapping.terminal
    ? computeTerminalFailureRetryAfterMs({ failedAtIso: failedAt })
    : 0;

  const handoff = clientActionId && sessionId && providerOrderId
    ? buildSavedCardPendingHandoff({
      paymentSessionId: sessionId,
      clientActionId,
      providerOrderId,
      providerPaymentId: mapping.payment_id,
      clientState: mapping.client_state,
      declineReason: mapping.decline_reason,
    })
    : {};

  const clientPayload: Record<string, unknown> = {
    ...handoff,
    success: true,
    client_state: mapping.client_state,
    terminal: mapping.terminal,
    preserve_saved_card: mapping.preserve_saved_card,
    failure_reason: mapping.failure_reason,
    order_state: mapping.order_state,
    payment_state: mapping.payment_state,
    authentication_acs_url: mapping.acs_url,
    retry_after_ms: retryAfterMs,
    throttle_ms: SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS,
    no_new_order: true,
    mapping_reason: mapping.reason,
  };

  // Clear pending-specific flags when terminal / authorised
  if (mapping.terminal || mapping.client_state === "AUTHORISED") {
    delete clientPayload.saved_card_pending;
    if (mapping.terminal) {
      clientPayload.code = mapping.client_state === "DECLINED"
        ? "card_declined"
        : mapping.client_state === "CANCELLED"
        ? "payment_cancelled"
        : "payment_failed";
    } else {
      clientPayload.code = "AUTHORISED";
    }
  }

  return {
    mapping,
    session_id: sessionId,
    client_action_id: clientActionId,
    provider_order_id: providerOrderId,
    previous_status: previousStatus,
    applied,
    terminalized,
    retry_after_ms: retryAfterMs,
    client_payload: clientPayload,
  };
}

export type RetrieveAndReconcileSavedCardSessionArgs = {
  supabase: SupabaseClient;
  environment: ProviderEnvironment;
  secretKey: string;
  userId: string;
  paymentSessionId?: string | null;
  clientActionId?: string | null;
  providerOrderId?: string | null;
  reconcileToken?: string | null;
  verifiedBy?: ApplySavedCardOrderReconcileArgs["verifiedBy"];
  /** Injected retrieve for unit tests — NEVER live in tests. */
  retrieveOrder?: (
    environment: ProviderEnvironment,
    secretKey: string,
    orderId: string,
  ) => Promise<RevolutOrder>;
};

export async function retrieveAndReconcileSavedCardSession(
  args: RetrieveAndReconcileSavedCardSessionArgs,
): Promise<
  | { ok: true; result: ApplySavedCardOrderReconcileResult }
  | { ok: false; status: number; error: string; code?: string }
> {
  const paymentSessionId = String(args.paymentSessionId ?? "").trim() || null;
  const clientActionId = String(args.clientActionId ?? "").trim() || null;
  const providerOrderId = String(args.providerOrderId ?? "").trim() || null;

  // Ownership keys only — client may NOT look up / replace by provider order id.
  if (!paymentSessionId && !clientActionId) {
    return {
      ok: false,
      status: 400,
      error: "payment_session_id or client_action_id required",
      code: "missing_correlation",
    };
  }

  let session: Record<string, unknown> | null = null;
  if (paymentSessionId) {
    const { data } = await args.supabase
      .from("payment_sessions")
      .select("*")
      .eq("id", paymentSessionId)
      .maybeSingle();
    session = (data as Record<string, unknown> | null) ?? null;
  } else if (clientActionId) {
    const { data } = await args.supabase
      .from("payment_sessions")
      .select("*")
      .eq("client_action_id", clientActionId)
      .eq("user_id", args.userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    session = (data as Record<string, unknown> | null) ?? null;
  }

  if (!session) {
    return { ok: false, status: 404, error: "Payment session not found", code: "not_found" };
  }

  if (String(session.user_id ?? "") !== args.userId) {
    return {
      ok: false,
      status: 403,
      error: "Payment session does not belong to this user",
      code: "forbidden",
    };
  }

  // Provider reference always from owned DB session — never from client body.
  const sessionOrderId = String(session.provider_order_id ?? "").trim();
  if (!sessionOrderId) {
    return {
      ok: false,
      status: 409,
      error: "Payment session has no provider order to reconcile",
      code: "missing_provider_order",
    };
  }

  // Optional client echo of order id is verification-only; mismatches fail closed.
  if (providerOrderId && providerOrderId !== sessionOrderId) {
    return {
      ok: false,
      status: 403,
      error: "provider_order_id does not match session",
      code: "order_mismatch",
    };
  }

  const sessionClientActionId = String(session.client_action_id ?? "").trim();
  if (
    args.reconcileToken &&
    sessionClientActionId &&
    !verifySavedCardReconcileToken(args.reconcileToken, {
      paymentSessionId: String(session.id),
      clientActionId: sessionClientActionId,
      providerOrderId: sessionOrderId,
    })
  ) {
    return {
      ok: false,
      status: 403,
      error: "Invalid reconcile token",
      code: "invalid_reconcile_token",
    };
  }

  const statusLower = String(session.status ?? "").toLowerCase();

  // Already authorised — never overwrite with stale failed evidence (no regress).
  if (
    statusLower === "payment_authorised" ||
    statusLower === "authorised" ||
    statusLower === "authorised_hold" ||
    statusLower === "trip_created"
  ) {
    return {
      ok: true,
      result: {
        mapping: {
          client_state: "AUTHORISED",
          lifecycle_provider_state: "AUTHORISED",
          order_state: String(session.provider_state ?? "AUTHORISED"),
          payment_state: null,
          payment_id: null,
          decline_reason: null,
          acs_url: null,
          terminal: false,
          preserve_saved_card: true,
          failure_reason: null,
          reason: "session_already_authorised",
        },
        session_id: String(session.id),
        client_action_id: sessionClientActionId || null,
        provider_order_id: sessionOrderId,
        previous_status: String(session.status ?? ""),
        applied: false,
        terminalized: false,
        retry_after_ms: 0,
        client_payload: {
          success: true,
          client_state: "AUTHORISED",
          terminal: false,
          code: "AUTHORISED",
          payment_session_id: session.id,
          client_action_id: sessionClientActionId || null,
          provider_order_id: sessionOrderId,
          no_new_order: true,
          preserve_saved_card: true,
        },
      },
    };
  }

  // Already terminal in DB — idempotent return, no new provider create.
  if (
    statusLower === "failed" ||
    statusLower === "cancelled" ||
    statusLower === "canceled" ||
    statusLower === "released" ||
    statusLower === "abandoned"
  ) {
    const meta = sessionMeta(session);
    const retryAfter = computeTerminalFailureRetryAfterMs({
      failedAtIso: typeof meta.saved_card_terminal_failed_at === "string"
        ? meta.saved_card_terminal_failed_at
        : (session.updated_at as string | null),
    });
    const clientState: SavedCardReconcileClientState =
      statusLower === "failed" ? "PAYMENT_FAILED" : "CANCELLED";
    return {
      ok: true,
      result: {
        mapping: {
          client_state: clientState,
          lifecycle_provider_state: statusLower === "failed" ? "FAILED" : "CANCELLED",
          order_state: String(session.provider_state ?? "UNKNOWN"),
          payment_state: null,
          payment_id: null,
          decline_reason: null,
          acs_url: null,
          terminal: true,
          preserve_saved_card: true,
          failure_reason: (session.failure_reason as string | null) ?? null,
          reason: "session_already_terminal",
        },
        session_id: String(session.id),
        client_action_id: sessionClientActionId || null,
        provider_order_id: sessionOrderId,
        previous_status: String(session.status ?? ""),
        applied: false,
        terminalized: true,
        retry_after_ms: retryAfter,
        client_payload: {
          success: true,
          client_state: clientState,
          terminal: true,
          code: statusLower === "failed" ? "payment_failed" : "payment_cancelled",
          payment_session_id: session.id,
          client_action_id: sessionClientActionId || null,
          provider_order_id: sessionOrderId,
          failure_reason: session.failure_reason ?? null,
          retry_after_ms: retryAfter,
          throttle_ms: SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS,
          no_new_order: true,
          preserve_saved_card: true,
        },
      },
    };
  }

  const retrieve = args.retrieveOrder ?? retrieveRevolutOrder;
  const order = await retrieve(args.environment, args.secretKey, sessionOrderId);

  const result = await applySavedCardOrderReconcile({
    supabase: args.supabase,
    session,
    order,
    verifiedBy: args.verifiedBy ?? "reconcile",
  });

  return { ok: true, result };
}

/** Customer-facing copy keys aligned with client_state (no spinner wording). */
export function customerCopyKeyForReconcileState(
  state: SavedCardReconcileClientState,
): string {
  switch (state) {
    case "AUTHORISED":
      return "authorised";
    case "CUSTOMER_ACTION_REQUIRED":
      return "bank_approval_required";
    case "PAYMENT_PROCESSING":
      return "processing";
    case "PAYMENT_FAILED":
      return "payment_failed_technical";
    case "DECLINED":
      return "declined";
    case "CANCELLED":
      return "cancelled";
    default:
      return "uncertain";
  }
}
