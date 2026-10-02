/**
 * Customer reconcile for an existing saved-card payment session / provider order.
 *
 * - Auth customer (JWT) — fail-closed Unauthorized
 * - Ownership check server-side (user_id)
 * - Provider order id from owned DB session only (client cannot replace)
 * - GET existing Revolut order (no create / no pay / no capture / no cancel)
 * - Map → AUTHORISED | CUSTOMER_ACTION_REQUIRED | PAYMENT_PROCESSING |
 *         PAYMENT_FAILED | DECLINED | CANCELLED
 * - Terminalize pending_payment → failed on PAYMENT_FAILED / DECLINED / CANCELLED
 * - Never invalidates saved cards on technical_error
 * - Rate limited per user; min interval while processing
 *
 * Deploy: NOT in release-prep (Edge deploy NONE until approved).
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import { retrieveAndReconcileSavedCardSession } from "../_shared/applySavedCardOrderReconcile.ts";
import { listRevolutOrderPayments, type RevolutOrder } from "../_shared/revolutOrders.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { checkRateLimit } from "../_shared/security.ts";
import { SAVED_CARD_RECONCILE_MIN_INTERVAL_MS } from "../_shared/savedCardPaymentReconcileSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serveWithEdgeTiming("reconcile-payment-session", corsHeaders, async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseAnonKey) {
    return json({ error: "SUPABASE_ANON_KEY not set" }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const token = authHeader.replace("Bearer ", "");
  const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
  if (claimsError || !claimsData?.claims) return json({ error: "Unauthorized" }, 401);
  const userId = claimsData.claims.sub as string;

  // Poll abuse guard — soft per-isolate limit (40 / 60s / user).
  const rl = checkRateLimit(userId, {
    limit: 40,
    windowMs: 60_000,
    keyPrefix: "reconcile-payment-session",
  });
  if (!rl.allowed) {
    return json({
      error: "Too many reconciliation requests. Please wait.",
      code: "rate_limited",
      retry_after_ms: (rl.retryAfter ?? 1) * 1000,
      client_state: "PAYMENT_PROCESSING",
      in_flight: true,
      no_new_order: true,
    }, 429);
  }

  const body = await req.json().catch(() => ({})) as {
    payment_session_id?: string;
    client_action_id?: string;
    booking_attempt_id?: string;
    /** Echo-only — never used as lookup / replace source. */
    provider_order_id?: string;
    payment_intent_id?: string;
    reconcile_token?: string;
  };

  const paymentSessionId = String(body.payment_session_id ?? "").trim() || null;
  const clientActionId = String(
    body.client_action_id ?? body.booking_attempt_id ?? "",
  ).trim() || null;
  // Echo for mismatch check only — retrieve always uses session.provider_order_id.
  const providerOrderIdEcho = String(
    body.provider_order_id ?? body.payment_intent_id ?? "",
  ).trim() || null;
  const reconcileToken = String(body.reconcile_token ?? "").trim() || null;

  if (!paymentSessionId && !clientActionId) {
    return json({
      error: "payment_session_id or client_action_id required",
      code: "missing_correlation",
    }, 400);
  }

  try {
    const merchant = await resolveRevolutMerchantContext(supabase, "live");

    // Soft min-interval: if client re-polls same session faster than 1.5s, return
    // PROCESSING without a fresh provider GET (DB evidence stamp only).
    if (paymentSessionId) {
      const { data: peek } = await supabase
        .from("payment_sessions")
        .select("id, user_id, status, metadata")
        .eq("id", paymentSessionId)
        .maybeSingle();
      if (peek && String((peek as { user_id?: string }).user_id ?? "") === userId) {
        const meta = (peek as { metadata?: Record<string, unknown> }).metadata ?? {};
        const lastAt = typeof meta.saved_card_reconcile_at === "string"
          ? Date.parse(meta.saved_card_reconcile_at)
          : NaN;
        const status = String((peek as { status?: string }).status ?? "").toLowerCase();
        if (
          Number.isFinite(lastAt) &&
          Date.now() - lastAt < SAVED_CARD_RECONCILE_MIN_INTERVAL_MS &&
          (status === "pending_payment" || status === "processing")
        ) {
          return json({
            success: true,
            client_state: "PAYMENT_PROCESSING",
            terminal: false,
            payment_session_id: paymentSessionId,
            client_action_id: clientActionId,
            in_flight: true,
            no_new_order: true,
            code: "saved_card_pending",
            retry_after_ms: SAVED_CARD_RECONCILE_MIN_INTERVAL_MS - (Date.now() - lastAt),
            mapping_reason: "min_interval_throttle",
          });
        }
      }
    }

    const outcome = await retrieveAndReconcileSavedCardSession({
      supabase,
      environment: merchant.environment,
      secretKey: merchant.secretKey,
      userId,
      paymentSessionId,
      clientActionId,
      providerOrderId: providerOrderIdEcho,
      reconcileToken,
      verifiedBy: "reconcile",
      retrieveOrder: async (environment, secretKey, orderId) => {
        const order = await import("../_shared/revolutOrders.ts").then((m) =>
          m.retrieveRevolutOrder(environment, secretKey, orderId)
        );
        // Ensure payment-level state is present (order PENDING + payment FAILED).
        if (!Array.isArray(order.payments) || order.payments.length === 0) {
          const payments = await listRevolutOrderPayments(environment, secretKey, orderId);
          return {
            ...order,
            payments: payments.map((p) => ({
              id: p.id,
              state: p.state,
              amount: p.amount,
              authorised_amount: undefined,
              decline_reason: p.decline_reason,
              authentication_challenge: p.authentication_challenge,
              payment_method: p.payment_method
                ? {
                  type: p.payment_method.type,
                  card_brand: p.payment_method.card_brand,
                }
                : undefined,
            })),
          } as RevolutOrder;
        }
        return order;
      },
    });

    if (!outcome.ok) {
      return json({ error: outcome.error, code: outcome.code ?? "reconcile_failed" }, outcome.status);
    }

    const { result } = outcome;
    console.info("[reconcile-payment-session]", {
      session_id: result.session_id,
      client_state: result.mapping.client_state,
      terminalized: result.terminalized,
      applied: result.applied,
      no_new_order: true,
      preserve_saved_card: result.mapping.preserve_saved_card,
    });

    // Strip any accidental sensitive fields from client payload.
    const payload = { ...result.client_payload };
    for (const key of Object.keys(payload)) {
      if (/secret|token_value|sk_|pk_|card_number|cvv|pan/i.test(key)) {
        delete payload[key];
      }
    }

    return json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reconcile-payment-session] error", { message });
    return json({
      error: "Unable to reconcile payment right now. Please try again shortly.",
      code: "reconcile_error",
      in_flight: true,
      client_state: "PAYMENT_PROCESSING",
      no_new_order: true,
    }, 503);
  }
});

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
