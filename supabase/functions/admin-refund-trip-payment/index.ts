import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { applyStripeRefundToOnecab } from "../_shared/applyStripeRefund.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  amount_pence: z.number().int().positive().optional(),
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(1000),
});

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) return jsonResponse({ error: 'Invalid input', details: parsed.error.flatten() }, 400);
    const { trip_id, amount_pence, reason } = parsed.data;

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return jsonResponse({ error: 'STRIPE_SECRET_KEY not configured' }, 500);

    const { data: trip, error: tripErr } = await gate.supabase
      .from('trips')
      .select('id, stripe_payment_intent_id, stripe_charge_id, refund_amount_pence')
      .eq('id', trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: 'Trip not found' }, 404);
    if (!trip.stripe_payment_intent_id) return jsonResponse({ error: 'Trip has no PaymentIntent' }, 400);

    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
    const pi = await stripe.paymentIntents.retrieve(trip.stripe_payment_intent_id, {
      expand: ['latest_charge'],
    });

    const charge = pi.latest_charge && typeof pi.latest_charge === 'object'
      ? pi.latest_charge as Stripe.Charge
      : null;
    if (!charge) return jsonResponse({ error: 'No charge found on PaymentIntent — capture first' }, 400);

    const captured = charge.amount_captured ?? 0;
    const alreadyRefunded = charge.amount_refunded ?? 0;
    const refundable = Math.max(0, captured - alreadyRefunded);

    if (refundable <= 0) return jsonResponse({ error: 'Nothing left to refund' }, 400);

    const refundAmount = amount_pence ?? refundable;
    if (refundAmount <= 0) return jsonResponse({ error: 'amount_pence must be > 0' }, 400);
    if (refundAmount > refundable) {
      return jsonResponse({ error: `amount_pence (${refundAmount}) exceeds refundable (${refundable})` }, 400);
    }

    const refund = await stripe.refunds.create(
      { charge: charge.id, amount: refundAmount, reason: 'requested_by_customer', metadata: { trip_id, admin_reason: reason } },
      { idempotencyKey: `admin_refund_${trip_id}_${refundAmount}_${Date.now()}` },
    );

    const applyResult = await applyStripeRefundToOnecab(gate.supabase, {
      tripId: trip_id,
      amountRefundedPence: alreadyRefunded + refundAmount,
      stripeRefundId: refund.id,
      stripeChargeId: charge.id,
      stripePaymentIntentId: trip.stripe_payment_intent_id,
      source: "admin_refund",
      refundReason: reason,
    });

    await gate.supabase.from('admin_payment_audit').insert({
      trip_id,
      admin_user_id: gate.userId,
      action: 'refund',
      reason,
      amount_pence_before: alreadyRefunded,
      amount_pence_after: alreadyRefunded + refundAmount,
      delta_pence: refundAmount,
      stripe_payment_intent_id: trip.stripe_payment_intent_id,
      stripe_refund_id: refund.id,
      metadata: { captured_total: captured, refundable_before: refundable },
    });

    return jsonResponse({
      success: true,
      stripe_refund_id: refund.id,
      stripe_payment_intent_id: trip.stripe_payment_intent_id,
      refunded_pence: refundAmount,
      total_refunded_pence: alreadyRefunded + refundAmount,
      payment_status: applyResult.payment_status,
      refund_status: applyResult.refund_status,
      net_paid_pence: applyResult.net_paid_pence,
      driver_reversal_pence: applyResult.driver_reversal_pence,
      message: `Refunded ${(refundAmount / 100).toFixed(2)} successfully`,
    });
  } catch (e) {
    console.error('[admin-refund-trip-payment] Error:', e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
