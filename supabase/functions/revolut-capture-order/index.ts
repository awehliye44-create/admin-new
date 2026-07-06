import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { captureRevolutOrder, getRevolutMerchantConfig } from "../_shared/revolutOrders.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  amount_pence: z.number().int().positive().optional(),
  reason: z.string().trim().min(5).max(1000),
});

/**
 * Admin-triggered capture of a Revolut order. Driver-side settlement
 * (transfer to driver, commission ledger) is handled by Phase 3's
 * driver-payout flow — this function only captures the customer charge
 * and updates the trip's payment_status.
 */
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
      .select("id, payment_provider, provider_order_id, capture_amount_pence, authorised_amount_pence, payment_status, currency_code, currency")
      .eq("id", trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    if (trip.payment_provider !== "revolut" || !trip.provider_order_id) {
      return jsonResponse(
        { error: "Trip is not paid via Revolut. Use the legacy Stripe capture endpoint for historical trips." },
        400,
      );
    }

    const { secretKey, environment } = getRevolutMerchantConfig();
    const before = trip.capture_amount_pence ?? 0;
    const captured = await captureRevolutOrder(environment, secretKey, trip.provider_order_id, amount_pence);
    const capturedAmount = amount_pence ?? trip.authorised_amount_pence ?? 0;

    await gate.supabase
      .from("trips")
      .update({
        payment_status: "captured",
        capture_amount_pence: capturedAmount,
        provider_charge_id: captured.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", trip_id);

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id,
      admin_user_id: gate.userId,
      action: "capture",
      reason,
      amount_pence_before: before,
      amount_pence_after: capturedAmount,
      delta_pence: capturedAmount - before,
      provider: "revolut",
      provider_payment_id: trip.provider_order_id,
      metadata: {
        environment,
        revolut_state: captured.state ?? null,
        requested_amount_pence: amount_pence ?? null,
      },
    });

    return jsonResponse({
      success: true,
      provider: "revolut",
      provider_order_id: trip.provider_order_id,
      captured_pence: capturedAmount,
      state: captured.state,
      message: `Captured ${(capturedAmount / 100).toFixed(2)} via Revolut`,
    });
  } catch (e) {
    console.error("[revolut-capture-order] Error:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
