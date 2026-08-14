import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  attemptHoldRecoveryOnce,
  releaseHoldForPaymentSession,
  releaseHoldOnTripTerminal,
} from "../_shared/holdReleaseSSOT.ts";
import { emitHoldTelemetry } from "../_shared/holdTelemetrySSOT.ts";
import { loadPaymentSession } from "../_shared/paymentSessionSSOT.ts";
import {
  classifyPaymentHoldAttention,
  mapRevolutProviderHoldState,
  paymentHoldActionPolicy,
} from "../../../shared/paymentHoldClassificationSSOT.ts";
import {
  assertActionAllowed,
  derivePaymentSessionAllowedActions,
} from "../../../shared/paymentSessionsAllowedActionsSSOT.ts";
import { evaluateStaleHoldAction } from "../../../shared/paymentHoldProviderTerminalPure.ts";
import { retrieveRevolutOrder } from "../_shared/revolutOrders.ts";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import { persistProviderTerminalHoldState } from "../_shared/paymentHoldProviderTerminalSSOT.ts";

const InputSchema = z.object({
  payment_session_id: z.string().uuid().optional(),
  provider_order_id: z.string().trim().min(1).optional(),
  action: z.enum(["release", "retry_release", "retry_recovery"]),
  dry_run: z.boolean().optional().default(false),
}).refine((v) => v.payment_session_id || v.provider_order_id, {
  message: "payment_session_id or provider_order_id required",
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    let session: Record<string, unknown> | null = null;
    if (parsed.data.payment_session_id) {
      const { data } = await gate.supabase
        .from("payment_sessions")
        .select("*")
        .eq("id", parsed.data.payment_session_id)
        .maybeSingle();
      session = data as Record<string, unknown> | null;
    } else if (parsed.data.provider_order_id) {
      session = await loadPaymentSession(gate.supabase, {
        providerOrderId: parsed.data.provider_order_id,
      });
    }

    if (!session) {
      return jsonResponse({ success: false, error: "payment_session_not_found" }, 404);
    }

    const sessionId = String(session.id);
    const providerOrderId = String(session.provider_order_id ?? parsed.data.provider_order_id ?? "");
    const tripId = session.trip_id as string | null;

    // Verify live provider state before any mutating action.
    let providerStateRaw: string | null = null;
    let providerRetrieved = false;
    let providerRetrieveFailed = false;
    let providerOrderNotFound = false;
    let providerAuthorised: number | null = null;
    let providerCaptured: number | null = null;
    let providerReleased: number | null = null;
    if (!providerOrderId) {
      providerOrderNotFound = true;
    } else {
      try {
        const merchant = await resolveRevolutMerchantContext(gate.supabase, "live");
        const order = await retrieveRevolutOrder(
          merchant.environment,
          merchant.secretKey,
          providerOrderId,
        );
        providerRetrieved = true;
        providerStateRaw = String(order.state ?? "").toUpperCase();
        const orderPayload = order as unknown as Record<string, unknown>;
        const authRaw = orderPayload.amount ?? orderPayload.authorised_amount
          ?? (orderPayload.order_amount as { value?: unknown } | undefined)?.value;
        if (authRaw != null && Number.isFinite(Number(authRaw))) {
          providerAuthorised = Math.round(Number(authRaw));
        }
        const capRaw = orderPayload.captured_amount
          ?? (Array.isArray(orderPayload.payments)
            ? (orderPayload.payments[0] as { amount?: { value?: unknown } | number })?.amount
            : null);
        if (capRaw != null) {
          const n = typeof capRaw === "object" && capRaw !== null && "value" in capRaw
            ? Number((capRaw as { value: unknown }).value)
            : Number(capRaw);
          if (Number.isFinite(n) && n > 0) providerCaptured = Math.round(n);
        }
        const canonical = mapRevolutProviderHoldState(providerStateRaw);
        if (
          canonical === "CANCELLED"
          || canonical === "REVERTED"
          || canonical === "CAPTURED"
          || canonical === "REFUNDED"
          || canonical === "FAILED"
        ) {
          const terminal = await persistProviderTerminalHoldState(gate.supabase, {
            paymentProvider: "revolut",
            providerOrderId,
            providerStateRaw,
            source: "admin_refresh",
            providerPayload: orderPayload,
            idempotencyKey: `admin_action_verify_${sessionId}_${providerStateRaw}`,
          });
          if (parsed.data.action === "release" || parsed.data.action === "retry_release") {
            return jsonResponse({
              success: false,
              error: canonical === "CAPTURED" ? "PAYMENT_ALREADY_CAPTURED" : "NO_ACTIVE_HOLD",
              already_resolved: true,
              action: parsed.data.action,
              payment_session_id: sessionId,
              provider_order_id: providerOrderId,
              provider_order_state: providerStateRaw,
              result: {
                ok: false,
                released: false,
                skipped: true,
                status: "no_active_hold",
                provider_state: canonical,
                orphan_closed: terminal.orphan_closed,
              },
            }, 409);
          }
        }
      } catch (verifyErr) {
        providerRetrieveFailed = true;
        console.warn("[admin-hold-action] provider verify failed", String(verifyErr));
        return jsonResponse({
          success: false,
          error: "PROVIDER_REFRESH_REQUIRED",
          message: "Provider evidence must be refreshed before this action",
          payment_session_id: sessionId,
          provider_order_id: providerOrderId,
        }, 409);
      }
    }

    if (providerOrderNotFound) {
      return jsonResponse({
        success: false,
        error: "PROVIDER_ORDER_NOT_FOUND",
        payment_session_id: sessionId,
      }, 409);
    }

    // Re-read session after possible prior resolution.
    const { data: fresh } = await gate.supabase
      .from("payment_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    if (fresh) session = fresh as Record<string, unknown>;

    const ageMinutes = session.authorised_at || session.created_at
      ? (Date.now() - new Date(String(session.authorised_at ?? session.created_at)).getTime()) / 60_000
      : 0;

    const classified = classifyPaymentHoldAttention({
      sessionStatus: String(session.status ?? ""),
      tripStatus: null,
      paymentHoldStatus: null,
      releasedAt: session.released_at as string | null,
      capturedAt: session.captured_at as string | null,
      tripId,
      ageMinutes,
      releaseFailureReason: session.release_failure_reason as string | null,
      holdReleaseState: session.hold_release_state as string | null,
      holdTerminalReason: session.hold_terminal_reason as string | null,
      providerOrderState: providerStateRaw,
      recoveryAttemptCount: Number(session.recovery_attempt_count ?? 0),
    });

    const allowed = derivePaymentSessionAllowedActions({
      providerOrderId,
      providerState: providerStateRaw ?? (session.provider_state as string | null),
      providerRetrieved,
      providerRetrieveFailed,
      providerOrderNotFound,
      providerVerifiedAt: new Date().toISOString(),
      providerVerificationStatus: providerRetrieved ? "VERIFIED" : "UNAVAILABLE",
      authorisedPence: providerAuthorised
        ?? (session.authorised_amount_pence as number | null)
        ?? (session.total_authorised_amount_pence as number | null),
      capturedPence: providerCaptured ?? (session.captured_amount_pence as number | null),
      releasedPence: providerReleased ?? (session.released_amount_pence as number | null),
      releasedAt: session.released_at as string | null,
      capturedAt: session.captured_at as string | null,
      canonicalPayablePence: (session.estimated_total_pence as number | null),
      localHoldReleaseState: session.hold_release_state as string | null,
      localAttentionClass: classified.attention_class,
      providerReleaseRequestSubmitted: Boolean(session.provider_release_reference),
      providerReleaseRequestId: session.provider_release_reference as string | null,
      recoveryAttemptCount: Number(session.recovery_attempt_count ?? 0),
      recoveryAttemptRetryableFailed: Boolean(session.release_failure_reason)
        || String(session.hold_release_state ?? "").toLowerCase() === "release_failed",
      purpose: session.purpose as string | null,
      hasTrip: Boolean(tripId),
    });

    const actionCheck = assertActionAllowed(allowed, parsed.data.action);
    if (!actionCheck.ok) {
      return jsonResponse({
        success: false,
        error: actionCheck.error_code,
        message: actionCheck.message,
        attention_class: classified.attention_class,
        action_classification: allowed.classification,
        allowed_actions: allowed.allowed_actions,
        releasable_pence: allowed.releasable_pence,
        provider_order_state: providerStateRaw,
        refresh_required: actionCheck.error_code === "PAYMENT_ACTION_STALE_REFRESH_REQUIRED"
          || actionCheck.error_code === "PROVIDER_REFRESH_REQUIRED"
          || actionCheck.error_code === "NO_ACTIVE_HOLD",
      }, 409);
    }

    const policy = paymentHoldActionPolicy({
      attentionClass: classified.attention_class,
      hasTrip: Boolean(tripId),
      recoveryAttemptCount: Number(session.recovery_attempt_count ?? 0),
      releaseFailureReason: session.release_failure_reason as string | null,
      capturedAt: session.captured_at as string | null,
    });
    // Align legacy policy with provider-truth allowed actions.
    policy.can_release = allowed.can_release;
    policy.can_retry_release = allowed.can_retry_release;
    policy.can_retry_recovery = allowed.can_retry_recovery;

    const gateResult = evaluateStaleHoldAction({
      providerCanonical: providerStateRaw
        ? mapRevolutProviderHoldState(providerStateRaw)
        : null,
      sessionReleasedAt: session.released_at as string | null,
      sessionCapturedAt: session.captured_at as string | null,
      inActiveQueue: classified.in_active_queue,
      action: parsed.data.action,
      canRelease: allowed.can_release,
      canRetryRelease: allowed.can_retry_release,
      canRetryRecovery: allowed.can_retry_recovery,
    });

    if (gateResult.already_resolved) {
      return jsonResponse({
        success: true,
        already_resolved: true,
        action: parsed.data.action,
        payment_session_id: sessionId,
        provider_order_id: providerOrderId,
        attention_class: classified.attention_class,
        result: {
          ok: true,
          released: true,
          skipped: true,
          status: "already_resolved",
        },
      });
    }

    if (!gateResult.allow) {
      return jsonResponse({
        success: false,
        error: gateResult.reject_reason ?? "action_not_permitted",
        attention_class: classified.attention_class,
        policy,
        provider_order_state: providerStateRaw,
      }, 409);
    }

    if (parsed.data.dry_run) {
      return jsonResponse({
        success: true,
        dry_run: true,
        action: parsed.data.action,
        payment_session_id: sessionId,
        provider_order_id: providerOrderId,
        trip_id: tripId,
        attention_class: classified.attention_class,
        policy,
        provider_order_state: providerStateRaw,
      });
    }

    await emitHoldTelemetry(gate.supabase, "HOLD_RELEASE_REQUESTED", {
      paymentSessionId: sessionId,
      providerOrderId,
      tripId,
      source: "admin-hold-action",
      terminalReason: `admin_${parsed.data.action}`,
      metadata: { admin_user_id: gate.userId, provider_order_state: providerStateRaw },
    });

    let result;
    const idempotencyKey = `admin_${parsed.data.action}_${sessionId}_${Date.now()}`;

    if (parsed.data.action === "retry_recovery") {
      result = await attemptHoldRecoveryOnce(gate.supabase, session, {
        supabaseUrl,
        serviceRoleKey,
        source: "admin-hold-action",
      });
    } else if (tripId) {
      result = await releaseHoldOnTripTerminal(gate.supabase, {
        tripId,
        terminalReason: `admin_${parsed.data.action}`,
        source: "admin-hold-action",
        idempotencyKey,
        forceRelease: true,
      });
    } else {
      result = await releaseHoldForPaymentSession(gate.supabase, {
        providerOrderId,
        clientActionId: session.client_action_id as string | null,
        terminalReason: `admin_${parsed.data.action}`,
        source: "admin-hold-action",
        idempotencyKey,
        session,
      });
    }

    await gate.supabase.from("admin_payment_audit").insert({
      action: `admin_hold_${parsed.data.action}`,
      trip_id: tripId,
      provider: "revolut",
      provider_payment_id: providerOrderId,
      admin_user_id: gate.userId,
      metadata: {
        payment_session_id: sessionId,
        result,
        provider_order_state: providerStateRaw,
        attention_class: classified.attention_class,
      },
    });

    return jsonResponse({
      success: true,
      action: parsed.data.action,
      result,
      attention_class: classified.attention_class,
      provider_order_state: providerStateRaw,
    });
  } catch (err) {
    console.error("[admin-hold-action]", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
