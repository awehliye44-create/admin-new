import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { cancelRevolutOrder, getRevolutMerchantConfig } from "../_shared/revolutOrders.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
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
    const { trip_id, reason } = parsed.data;

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select("id, payment_provider, provider_order_id, payment_status, authorised_amount_pence")
      .eq("id", trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);
    if (trip.payment_provider !== "revolut" || !trip.provider_order_id) {
      return jsonResponse({ error: "Trip is not paid via Revolut" }, 400);
    }

    const { secretKey, environment } = getRevolutMerchantConfig();
    const cancelled = await cancelRevolutOrder(environment, secretKey, trip.provider_order_id);

    await gate.supabase
      .from("trips")
      .update({ payment_status: "canceled", updated_at: new Date().toISOString() })
      .eq("id", trip_id);

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id,
      admin_user_id: gate.userId,
      action: "cancel",
      reason,
      amount_pence_before: trip.authorised_amount_pence ?? 0,
      amount_pence_after: 0,
      delta_pence: -(trip.authorised_amount_pence ?? 0),
      provider: "revolut",
      provider_payment_id: trip.provider_order_id,
      metadata: { environment, revolut_state: cancelled.state ?? null },
    });

    return jsonResponse({
      success: true,
      provider: "revolut",
      provider_order_id: trip.provider_order_id,
      state: cancelled.state,
    });
  } catch (e) {
    console.error("[revolut-cancel-order] Error:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
