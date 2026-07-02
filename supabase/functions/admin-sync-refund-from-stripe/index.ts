import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { applyStripeRefundToOnecab } from "../_shared/applyStripeRefund.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid().optional(),
  trip_code: z.string().trim().min(1).optional(),
  payment_intent_id: z.string().trim().min(1).optional(),
}).refine(
  (v) => Boolean(v.trip_id || v.trip_code || v.payment_intent_id),
  { message: "Provide trip_id, trip_code, or payment_intent_id" },
);

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

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return jsonResponse({ error: "STRIPE_SECRET_KEY not configured" }, 500);

    const { trip_id, trip_code, payment_intent_id } = parsed.data;

    let tripQuery = gate.supabase
      .from("trips")
      .select("id, trip_code, stripe_payment_intent_id, stripe_charge_id, refund_amount_pence");
    if (trip_id) tripQuery = tripQuery.eq("id", trip_id);
    else if (trip_code) tripQuery = tripQuery.eq("trip_code", trip_code);
    else if (payment_intent_id) tripQuery = tripQuery.eq("stripe_payment_intent_id", payment_intent_id);

    const { data: trip, error: tripErr } = await tripQuery.maybeSingle();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    const piId = trip.stripe_payment_intent_id ?? payment_intent_id;
    if (!piId) return jsonResponse({ error: "Trip has no Stripe PaymentIntent" }, 400);

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const pi = await stripe.paymentIntents.retrieve(String(piId), { expand: ["latest_charge"] });
    const charge = pi.latest_charge && typeof pi.latest_charge === "object"
      ? pi.latest_charge as Stripe.Charge
      : null;
    if (!charge) return jsonResponse({ error: "No charge on PaymentIntent" }, 400);

    const amountRefunded = charge.amount_refunded ?? 0;
    if (amountRefunded <= 0) {
      return jsonResponse({ error: "Stripe charge has no refunds — nothing to sync" }, 400);
    }

    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 10 });
    const latestRefund = refunds.data[0] ?? null;

    const result = await applyStripeRefundToOnecab(gate.supabase, {
      tripId: String(trip.id),
      amountRefundedPence: amountRefunded,
      stripeRefundId: latestRefund?.id ?? null,
      stripeChargeId: charge.id,
      stripePaymentIntentId: pi.id,
      source: "admin_sync",
      refundReason: latestRefund?.reason ?? "sync_from_stripe",
    });

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id: trip.id,
      admin_user_id: gate.userId,
      action: "refund_sync",
      reason: "Sync refund from Stripe Dashboard",
      amount_pence_before: trip.refund_amount_pence ?? 0,
      amount_pence_after: amountRefunded,
      delta_pence: amountRefunded - (trip.refund_amount_pence ?? 0),
      stripe_payment_intent_id: pi.id,
      stripe_refund_id: latestRefund?.id ?? null,
      metadata: { charge_id: charge.id, captured: charge.amount_captured },
    });

    return jsonResponse({
      success: true,
      message: `Synced ${(amountRefunded / 100).toFixed(2)} refund from Stripe`,
      stripe_refund_id: latestRefund?.id ?? null,
      ...result,
    });
  } catch (e) {
    console.error("[admin-sync-refund-from-stripe]", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
