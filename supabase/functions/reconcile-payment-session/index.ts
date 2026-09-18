/**
 * Customer reconcile for an existing saved-card payment session / provider order.
 *
 * - Auth customer (JWT)
 * - Ownership check
 * - GET existing Revolut order (no create / no pay / no capture)
 * - Map → AUTHORISED | CUSTOMER_ACTION_REQUIRED | PAYMENT_PROCESSING |
 *         PAYMENT_FAILED | DECLINED | CANCELLED
 * - Terminalize pending_payment → failed on PAYMENT_FAILED / DECLINED / CANCELLED
 * - Never invalidates saved cards on technical_error
 *
 * Deploy: NOT in this task (Edge deploy NONE).
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import { retrieveAndReconcileSavedCardSession } from "../_shared/applySavedCardOrderReconcile.ts";
import { listRevolutOrderPayments, type RevolutOrder } from "../_shared/revolutOrders.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

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

  const body = await req.json().catch(() => ({})) as {
    payment_session_id?: string;
    client_action_id?: string;
    booking_attempt_id?: string;
    provider_order_id?: string;
    payment_intent_id?: string;
    reconcile_token?: string;
  };

  const paymentSessionId = String(body.payment_session_id ?? "").trim() || null;
  const clientActionId = String(
    body.client_action_id ?? body.booking_attempt_id ?? "",
  ).trim() || null;
  const providerOrderId = String(
    body.provider_order_id ?? body.payment_intent_id ?? "",
  ).trim() || null;
  const reconcileToken = String(body.reconcile_token ?? "").trim() || null;

  try {
    const merchant = await resolveRevolutMerchantContext(supabase, "live");

    const outcome = await retrieveAndReconcileSavedCardSession({
      supabase,
      environment: merchant.environment,
      secretKey: merchant.secretKey,
      userId,
      paymentSessionId,
      clientActionId,
      providerOrderId,
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

    return json(result.client_payload);
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
