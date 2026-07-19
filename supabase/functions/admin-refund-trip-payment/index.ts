// Admin: refund trip payment — routes Revolut vs legacy Stripe by trip provider.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  refundRevolutOrder,
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
} from "../_shared/revolutOrders.ts";
import { applyProviderRefundToOnecab } from "../_shared/applyProviderRefund.ts";
import { resolveTripPaymentProvider, tripProviderOrderId } from "../_shared/tripPaymentProviderSSOT.ts";
import { assertStripeMutationAllowed } from "../_shared/stripeRuntimeDisabled.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  amount_pence: z.number().int().positive().optional(),
  reason: z.string().trim().min(5).max(1000),
});

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
      .select("id, payment_provider, provider_order_id, stripe_payment_intent_id, stripe_charge_id, capture_amount_pence, refund_amount_pence, payment_status, final_fare_pence, final_customer_fare_pence")
      .eq("id", trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    const provider = resolveTripPaymentProvider(trip);

    if (provider === "stripe") {
      const retired = assertStripeMutationAllowed(corsHeaders, "admin-refund-trip-payment");
      if (retired) return retired;
      return jsonResponse({
        error: "Stripe is permanently retired from active ONECAB finance.",
        error_code: "STRIPE_RETIRED",
      }, 422);
    }

    const orderId = tripProviderOrderId(trip);
    if (!orderId) return jsonResponse({ error: "Trip has no Revolut order" }, 400);

    const { data: sessionRow } = await gate.supabase
      .from("payment_sessions")
      .select("captured_amount_pence, refunded_amount_pence, authorised_amount_pence")
      .eq("trip_id", trip_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { secretKey, environment } = getRevolutMerchantConfig();
    const orderBefore = await retrieveRevolutOrder(environment, secretKey, orderId);
    const state = (orderBefore.state ?? "").toUpperCase();
    if (state !== "COMPLETED" && state !== "REFUNDED") {
      return jsonResponse({ error: `Cannot refund — Revolut order state is "${state}" (must be COMPLETED)` }, 400);
    }

    const captured = Math.max(
      0,
      trip.capture_amount_pence
        ?? sessionRow?.captured_amount_pence
        ?? Number(orderBefore.amount ?? 0),
    );
    const alreadyRefunded = Math.max(
      0,
      trip.refund_amount_pence
        ?? sessionRow?.refunded_amount_pence
        ?? 0,
    );
    const refundable = Math.max(0, captured - alreadyRefunded);
    if (refundable <= 0) return jsonResponse({ error: "Nothing left to refund" }, 400);

    const refundAmount = amount_pence ?? refundable;
    if (refundAmount <= 0) return jsonResponse({ error: "amount_pence must be > 0" }, 400);
    if (refundAmount > refundable) {
      return jsonResponse({ error: `amount_pence (${refundAmount}) exceeds refundable (${refundable})` }, 400);
    }

    const refund = await refundRevolutOrder(environment, secretKey, orderId, refundAmount, reason);

    // Persist capture baseline when trip.capture_amount_pence was never written (common for Revolut).
    if (trip.capture_amount_pence == null && captured > 0) {
      await gate.supabase
        .from("trips")
        .update({ capture_amount_pence: captured, updated_at: new Date().toISOString() })
        .eq("id", trip_id);
    }

    await applyProviderRefundToOnecab(gate.supabase, {
      tripId: trip_id,
      amountRefundedPence: alreadyRefunded + refundAmount,
      provider: "revolut",
      providerRefundId: refund.id ?? null,
      providerOrderId: orderId,
      source: "admin_refund",
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
      metadata: { captured_total: captured, refundable_before: refundable, revolut_refund_id: refund.id },
    });

    return jsonResponse({
      success: true,
      provider: "revolut",
      provider_order_id: orderId,
      refunded_pence: refundAmount,
      total_refunded_pence: alreadyRefunded + refundAmount,
      message: `Refunded ${(refundAmount / 100).toFixed(2)} successfully`,
    });
  } catch (e) {
    console.error("[admin-refund-trip-payment] Error:", e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
