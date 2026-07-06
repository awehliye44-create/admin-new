import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { refundRevolutOrder, getRevolutMerchantConfig } from "../_shared/revolutOrders.ts";

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
      .select("id, payment_provider, provider_order_id, capture_amount_pence, payment_status")
      .eq("id", trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);
    if (trip.payment_provider !== "revolut" || !trip.provider_order_id) {
      return jsonResponse({ error: "Trip is not paid via Revolut" }, 400);
    }

    const captured = trip.capture_amount_pence ?? 0;
    const refundAmount = amount_pence ?? captured;
    if (refundAmount <= 0 || refundAmount > captured) {
      return jsonResponse({ error: `amount_pence must be between 1 and ${captured}` }, 400);
    }

    const { secretKey, environment } = getRevolutMerchantConfig();
    const refund = await refundRevolutOrder(
      environment,
      secretKey,
      trip.provider_order_id,
      refundAmount,
      reason,
    );

    await gate.supabase
      .from("trips")
      .update({
        payment_status: refundAmount === captured ? "refunded" : "partially_refunded",
        updated_at: new Date().toISOString(),
      })
      .eq("id", trip_id);

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id,
      admin_user_id: gate.userId,
      action: "refund",
      reason,
      amount_pence_before: captured,
      amount_pence_after: Math.max(0, captured - refundAmount),
      delta_pence: -refundAmount,
      provider: "revolut",
      provider_payment_id: trip.provider_order_id,
      metadata: { environment, refund_id: refund.id ?? null, revolut_state: refund.state ?? null },
    });

    return jsonResponse({
      success: true,
      provider: "revolut",
      provider_order_id: trip.provider_order_id,
      refunded_pence: refundAmount,
      refund_id: refund.id ?? null,
      state: refund.state ?? null,
    });
  } catch (e) {
    console.error("[revolut-refund-order] Error:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
