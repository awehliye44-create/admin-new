// Admin: cancel an uncaptured PaymentIntent (release the customer's bank hold).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
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
    const { trip_id, reason } = parsed.data;

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return jsonResponse({ error: 'STRIPE_SECRET_KEY not configured' }, 500);

    const { data: trip, error: tripErr } = await gate.supabase
      .from('trips')
      .select('id, stripe_payment_intent_id, authorised_amount_pence, payment_status')
      .eq('id', trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: 'Trip not found' }, 404);
    if (!trip.stripe_payment_intent_id) return jsonResponse({ error: 'Trip has no PaymentIntent' }, 400);

    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
    const pi = await stripe.paymentIntents.retrieve(trip.stripe_payment_intent_id);

    const cancellable = ['requires_capture', 'requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'];
    if (!cancellable.includes(pi.status)) {
      return jsonResponse({ error: `Cannot cancel — PaymentIntent status is "${pi.status}"` }, 400);
    }

    const before = pi.amount ?? trip.authorised_amount_pence ?? 0;

    const cancelled = await stripe.paymentIntents.cancel(
      trip.stripe_payment_intent_id,
      { cancellation_reason: 'requested_by_customer' },
    );

    await gate.supabase
      .from('trips')
      .update({
        payment_status: 'cancelled',
        capture_amount_pence: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', trip_id);

    await gate.supabase.from('admin_payment_audit').insert({
      trip_id,
      admin_user_id: gate.userId,
      action: 'cancel',
      reason,
      amount_pence_before: before,
      amount_pence_after: 0,
      delta_pence: -before,
      stripe_payment_intent_id: trip.stripe_payment_intent_id,
      metadata: { previous_status: pi.status, cancelled_status: cancelled.status },
    });

    return jsonResponse({
      success: true,
      stripe_payment_intent_id: trip.stripe_payment_intent_id,
      released_pence: before,
      message: `Hold released — ${(before / 100).toFixed(2)} returned to customer.`,
    });
  } catch (e) {
    console.error('[admin-cancel-trip-payment] Error:', e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
