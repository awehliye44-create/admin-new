import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { capturePaymentIntentWithSettlement } from "../_shared/stripeSettlement.ts";

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
      .select('id, driver_id, stripe_payment_intent_id, capture_amount_pence, authorised_amount_pence, payment_status, commission_pence, driver_total_earnings_pence, driver_net_pence, tip_amount_pence, currency_code, currency')
      .eq('id', trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: 'Trip not found' }, 404);
    if (!trip.stripe_payment_intent_id) return jsonResponse({ error: 'Trip has no PaymentIntent' }, 400);

    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
    const pi = await stripe.paymentIntents.retrieve(trip.stripe_payment_intent_id);

    if (pi.status !== 'requires_capture') {
      return jsonResponse({ error: `Cannot capture — PaymentIntent status is "${pi.status}"` }, 400);
    }

    const authorizedTotal = pi.amount ?? 0;
    const capturable = pi.amount_capturable ?? authorizedTotal;
    const captureAmount = amount_pence ?? capturable;

    if (captureAmount <= 0) return jsonResponse({ error: 'amount_pence must be > 0' }, 400);
    if (captureAmount > capturable) {
      return jsonResponse({ error: `amount_pence (${captureAmount}) exceeds capturable (${capturable})` }, 400);
    }

    const before = trip.capture_amount_pence ?? 0;

    const commission = trip.commission_pence ?? 0;
    const driverPayout = trip.driver_total_earnings_pence ?? ((trip.driver_net_pence ?? Math.max(0, captureAmount - commission)) + (trip.tip_amount_pence ?? 0));
    const settlement = await capturePaymentIntentWithSettlement({
      stripe,
      supabase: gate.supabase,
      tripId: trip_id,
      driverId: trip.driver_id,
      paymentIntentId: trip.stripe_payment_intent_id,
      captureAmountPence: captureAmount,
      commissionPence: commission,
      driverPayoutPence: driverPayout,
      currencyCode: (trip.currency_code ?? trip.currency ?? pi.currency ?? 'gbp').toLowerCase(),
      idempotencyKey: `admin_capture_${trip_id}_${captureAmount}_${Date.now()}`,
    });

    const newCaptured = settlement.capturedAmountPence;
    const stripeFee = settlement.stripeFeePence;
    const onecabNet = Math.max(0, commission - stripeFee);

    await gate.supabase
      .from('trips')
      .update({
        payment_status: 'captured',
        capture_amount_pence: newCaptured,
        stripe_charge_id: settlement.chargeId,
        stripe_processing_fee_pence: stripeFee,
        onecab_net_pence: onecabNet,
        stripe_application_fee_id: settlement.applicationFeeId,
        stripe_application_fee_amount_pence: settlement.applicationFeeAmountPence,
        stripe_destination_account_id: settlement.destinationAccountId,
        stripe_transfer_id: settlement.transferId,
        stripe_transfer_amount_pence: settlement.transferAmountPence,
        stripe_settlement_verified: settlement.settlementVerified,
        stripe_settlement_warning: settlement.settlementWarning,
        updated_at: new Date().toISOString(),
      })
      .eq('id', trip_id);

    await gate.supabase.from('admin_payment_audit').insert({
      trip_id,
      admin_user_id: gate.userId,
      action: 'capture',
      reason,
      amount_pence_before: before,
      amount_pence_after: newCaptured,
      delta_pence: newCaptured - before,
      stripe_payment_intent_id: trip.stripe_payment_intent_id,
      metadata: {
        authorized_total: authorizedTotal,
        requested_amount: amount_pence ?? null,
        application_fee_amount_pence: settlement.applicationFeeAmountPence,
        expected_commission_pence: commission,
        destination_account_id: settlement.destinationAccountId,
        transfer_id: settlement.transferId,
        transfer_amount_pence: settlement.transferAmountPence,
        settlement_verified: settlement.settlementVerified,
        settlement_warning: settlement.settlementWarning,
      },
    });

    return jsonResponse({
      success: true,
      stripe_payment_intent_id: trip.stripe_payment_intent_id,
      stripe_charge_id: settlement.chargeId,
      stripe_application_fee_id: settlement.applicationFeeId,
      stripe_application_fee_amount_pence: settlement.applicationFeeAmountPence,
      stripe_settlement_verified: settlement.settlementVerified,
      stripe_settlement_warning: settlement.settlementWarning,
      captured_pence: newCaptured,
      message: `Captured ${(newCaptured / 100).toFixed(2)} successfully`,
    });
  } catch (e) {
    console.error('[admin-capture-trip-payment] Error:', e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
