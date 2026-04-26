import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";

const InputSchema = z.object({ trip_id: z.string().uuid() });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) return jsonResponse({ error: 'Invalid input', details: parsed.error.flatten() }, 400);
    const { trip_id } = parsed.data;

    const { data: trip, error: tripErr } = await gate.supabase
      .from('trips')
      .select('id, stripe_payment_intent_id, payment_status, payment_method, gross_fare_pence, capture_amount_pence, authorised_amount_pence, refund_amount_pence, final_fare_pence')
      .eq('id', trip_id)
      .single();

    if (tripErr || !trip) return jsonResponse({ error: 'Trip not found' }, 404);

    let authorized_pence = trip.authorised_amount_pence ?? 0;
    let captured_pence = trip.capture_amount_pence ?? 0;
    let refunded_pence = trip.refund_amount_pence ?? 0;
    let stripe_status: string | null = null;
    let amount_capturable: number | null = null;
    let stripe_currency: string | null = null;

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (stripeKey && trip.stripe_payment_intent_id) {
      try {
        const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
        const pi = await stripe.paymentIntents.retrieve(trip.stripe_payment_intent_id, {
          expand: ['latest_charge', 'latest_charge.refunds'],
        });
        stripe_status = pi.status;
        stripe_currency = pi.currency?.toUpperCase() ?? null;
        amount_capturable = pi.amount_capturable ?? 0;
        // Stripe is the source of truth when available
        authorized_pence = pi.amount ?? authorized_pence;
        const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
        if (charge) {
          captured_pence = (charge as Stripe.Charge).amount_captured ?? captured_pence;
          refunded_pence = (charge as Stripe.Charge).amount_refunded ?? refunded_pence;
        }
      } catch (e) {
        console.error('[admin-get-trip-payment-state] Stripe fetch failed:', (e as Error).message);
      }
    }

    return jsonResponse({
      trip_id,
      payment_intent_id: trip.stripe_payment_intent_id,
      payment_method: trip.payment_method,
      payment_status: trip.payment_status,
      authorized_pence,
      captured_pence,
      refunded_pence,
      net_captured_pence: Math.max(0, captured_pence - refunded_pence),
      amount_capturable_pence: amount_capturable,
      stripe_status,
      stripe_currency,
      final_fare_pence: trip.final_fare_pence ?? trip.gross_fare_pence ?? 0,
    });
  } catch (e) {
    console.error('[admin-get-trip-payment-state] Error:', e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
