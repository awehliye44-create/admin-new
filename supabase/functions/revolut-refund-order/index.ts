// Legacy refund entry. Must apply the same atomic local refund as
// admin-refund-trip-payment — a provider refund that only flips payment_status
// leaves TRIP_EARNING_NET and DRIVER_TIP_CREDIT with the driver.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  refundRevolutOrder,
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
} from "../_shared/revolutOrders.ts";
import { applyProviderRefundToOnecab } from "../_shared/applyProviderRefund.ts";
import { tripProviderOrderId } from "../_shared/tripPaymentProviderSSOT.ts";
import { extractConfirmedCaptureAmountPence } from "../../../shared/paymentHoldProviderTerminalPure.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  amount_pence: z.number().int().positive().optional(),
  reason: z.string().trim().min(5).max(1000),
});

function positiveCapturedPence(raw: unknown): number | null {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) return jsonResponse({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    const { trip_id, amount_pence, reason } = parsed.data;

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select("id, payment_provider, provider_order_id, provider_payment_id, provider_charge_id, capture_amount_pence, refund_amount_pence, payment_status")
      .eq("id", trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    const orderId = tripProviderOrderId(trip);
    if (!orderId) return jsonResponse({ error: "Trip has no Revolut order" }, 400);

    const { secretKey, environment } = getRevolutMerchantConfig();
    const orderBefore = await retrieveRevolutOrder(environment, secretKey, orderId);
    const state = (orderBefore.state ?? "").toUpperCase();
    if (state !== "COMPLETED" && state !== "REFUNDED") {
      return jsonResponse({ error: `Cannot refund — Revolut order state is "${state}" (must be COMPLETED)` }, 400);
    }

    const { data: sessionRow } = await gate.supabase
      .from("payment_sessions")
      .select("captured_amount_pence, refunded_amount_pence")
      .eq("trip_id", trip_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const confirmedCapture = extractConfirmedCaptureAmountPence(
      orderBefore as unknown as Record<string, unknown>,
      orderBefore.state,
    );
    const captured = confirmedCapture
      ?? positiveCapturedPence(sessionRow?.captured_amount_pence)
      ?? positiveCapturedPence(trip.capture_amount_pence)
      ?? 0;
    const alreadyRefunded = Math.max(
      0,
      trip.refund_amount_pence ?? sessionRow?.refunded_amount_pence ?? 0,
    );
    const refundable = Math.max(0, captured - alreadyRefunded);
    const refundAmount = amount_pence ?? refundable;
    if (refundAmount <= 0 || refundAmount > refundable) {
      return jsonResponse({ error: `amount_pence must be between 1 and ${refundable}` }, 400);
    }

    const refund = await refundRevolutOrder(
      environment,
      secretKey,
      orderId,
      refundAmount,
      reason,
    );
    const providerRefundId = String(refund.id ?? "").trim();
    if (!providerRefundId) {
      return jsonResponse({
        error: "Provider refund succeeded but provider_refund_id missing",
        failure_stage: "provider_refund",
        retry_provider_refund: true,
      }, 502);
    }

    if (trip.capture_amount_pence == null && captured > 0) {
      await gate.supabase
        .from("trips")
        .update({ capture_amount_pence: captured, updated_at: new Date().toISOString() })
        .eq("id", trip_id);
    }

    const localResult = await applyProviderRefundToOnecab(gate.supabase, {
      tripId: trip_id,
      amountRefundedPence: alreadyRefunded + refundAmount,
      thisRefundAmountPence: refundAmount,
      provider: "revolut",
      providerRefundId,
      providerOrderId: orderId,
      source: "revolut_refund_order",
      refundReason: reason,
    });

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id,
      admin_user_id: gate.userId,
      action: "refund",
      reason,
      amount_pence_before: alreadyRefunded,
      amount_pence_after: alreadyRefunded + refundAmount,
      delta_pence: refundAmount,
      provider: "revolut",
      provider_payment_id: orderId,
      metadata: {
        environment,
        refund_id: providerRefundId,
        revolut_state: refund.state ?? null,
        local_rpc_status: localResult.rpc_status,
      },
    });

    return jsonResponse({
      success: true,
      provider: "revolut",
      provider_order_id: orderId,
      refunded_pence: refundAmount,
      refund_id: providerRefundId,
      state: refund.state ?? null,
      already_applied: localResult.already_applied,
    });
  } catch (e) {
    console.error("[revolut-refund-order] Error:", e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
