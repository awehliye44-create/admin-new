import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { calculateCommission } from "../_shared/commission.ts";
import { capturePaymentIntentWithSettlement } from "../_shared/stripeSettlement.ts";
import {
  calculateTripSettlement,
  tripSettlementDbColumns,
  tripSettlementSnapshotJson,
} from "../_shared/tripSettlement.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  new_total_pence: z.number().int().positive(),
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
    const { trip_id, new_total_pence, reason } = parsed.data;

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return jsonResponse({ error: 'STRIPE_SECRET_KEY not configured' }, 500);

    const { data: trip, error: tripErr } = await gate.supabase
      .from('trips')
      .select('id, driver_id, stripe_payment_intent_id, stripe_charge_id, capture_amount_pence, authorised_amount_pence, refund_amount_pence, gross_fare_pence, final_fare_pence, commission_pence, commission_pct, driver_tier_commission_percent, airport_charge_pence, other_pass_through_charges_pence, tip_amount_pence, tip_pence, fare_snapshot_json, currency_code, currency')
      .eq('id', trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: 'Trip not found' }, 404);
    if (!trip.stripe_payment_intent_id) return jsonResponse({ error: 'Trip has no PaymentIntent' }, 400);
    if (!trip.driver_id) return jsonResponse({ error: 'Trip has no assigned driver' }, 400);

    const tipPence = trip.tip_amount_pence ?? trip.tip_pence ?? 0;
    const airportPence = trip.airport_charge_pence ?? 0;
    const passThroughPence = trip.other_pass_through_charges_pence ?? 0;

    const { commission_pct } = await calculateCommission(gate.supabase, trip.driver_id, new_total_pence, {
      airport_charge_pence: airportPence,
      other_pass_through_charges_pence: passThroughPence,
      tips_pence: tipPence,
    });

    let settlementResult = calculateTripSettlement({
      final_fare_pence: new_total_pence,
      airport_charge_pence: airportPence,
      other_pass_through_charges_pence: passThroughPence,
      tips_pence: tipPence,
      driver_tier_commission_percent: trip.driver_tier_commission_percent ?? trip.commission_pct ?? commission_pct,
    });

    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
    const pi = await stripe.paymentIntents.retrieve(trip.stripe_payment_intent_id, {
      expand: ['latest_charge'],
    });

    const beforeFare = trip.final_fare_pence ?? trip.gross_fare_pence ?? 0;
    let stripeRefundId: string | null = null;
    let stripeChargeId: string | null = null;
    let resultingCaptured = 0;
    let resultingRefunded = trip.refund_amount_pence ?? 0;
    let scenario: string;
    let settlementMetadata: Record<string, unknown> = {};

    const captureWithTipPence = new_total_pence + tipPence;

    if (pi.status === 'requires_capture') {
      const authorized = pi.amount_capturable ?? pi.amount ?? 0;
      if (captureWithTipPence > authorized) {
        return jsonResponse({
          error: `Cannot edit fare to ${new_total_pence}p (+ ${tipPence}p tip) — only ${authorized}p was authorized. Authorize a new amount first.`,
        }, 400);
      }
      const settlement = await capturePaymentIntentWithSettlement({
        stripe,
        supabase: gate.supabase,
        tripId: trip_id,
        driverId: trip.driver_id,
        paymentIntentId: trip.stripe_payment_intent_id,
        captureAmountPence: captureWithTipPence,
        commissionPence: settlementResult.commission_pence,
        driverPayoutPence: Math.max(0, captureWithTipPence - settlementResult.commission_pence),
        currencyCode: (trip.currency_code ?? trip.currency ?? pi.currency ?? 'gbp').toLowerCase(),
        idempotencyKey: `admin_edit_capture_${trip_id}_${captureWithTipPence}_${Date.now()}`,
      });
      stripeChargeId = settlement.chargeId;
      resultingCaptured = settlement.capturedAmountPence;
      settlementMetadata = {
        application_fee_id: settlement.applicationFeeId,
        application_fee_amount_pence: settlement.applicationFeeAmountPence,
        expected_commission_pence: settlementResult.commission_pence,
        destination_account_id: settlement.destinationAccountId,
        transfer_id: settlement.transferId,
        transfer_amount_pence: settlement.transferAmountPence,
        settlement_verified: settlement.settlementVerified,
        settlement_warning: settlement.settlementWarning,
        stripe_fee_pence: settlement.stripeFeePence,
      };
      settlementResult = calculateTripSettlement({
        final_fare_pence: new_total_pence,
        airport_charge_pence: airportPence,
        other_pass_through_charges_pence: passThroughPence,
        tips_pence: tipPence,
        driver_tier_commission_percent: settlementResult.tier_percent_used,
        stripe_fee_pence: settlement.stripeFeePence,
      });
      scenario = 'captured_at_new_total';
    } else {
      const charge = pi.latest_charge && typeof pi.latest_charge === 'object'
        ? pi.latest_charge as Stripe.Charge : null;
      if (!charge) return jsonResponse({ error: 'PaymentIntent has no charge to edit' }, 400);

      const captured = charge.amount_captured ?? 0;
      const alreadyRefunded = charge.amount_refunded ?? 0;
      const netCaptured = captured - alreadyRefunded;
      stripeChargeId = charge.id;

      if (captureWithTipPence === netCaptured) {
        resultingCaptured = captured;
        resultingRefunded = alreadyRefunded;
        scenario = 'no_change';
      } else if (captureWithTipPence < netCaptured) {
        const delta = netCaptured - captureWithTipPence;
        const refund = await stripe.refunds.create(
          { charge: charge.id, amount: delta, reason: 'requested_by_customer', metadata: { trip_id, admin_reason: reason, edit_fare: 'true' } },
          { idempotencyKey: `admin_edit_refund_${trip_id}_${delta}_${Date.now()}` },
        );
        stripeRefundId = refund.id;
        resultingCaptured = captured;
        resultingRefunded = alreadyRefunded + delta;
        scenario = 'refunded_delta';
      } else {
        return jsonResponse({
          error: 'Cannot charge more after capture; create a new PaymentIntent for the additional amount.',
        }, 400);
      }
    }

    const netCapturedAfter = Math.max(0, resultingCaptured - resultingRefunded);
    const existingSnapshot =
      typeof trip.fare_snapshot_json === 'object' && trip.fare_snapshot_json
        ? trip.fare_snapshot_json as Record<string, unknown>
        : {};

    await gate.supabase
      .from('trips')
      .update({
        ...tripSettlementDbColumns(settlementResult),
        capture_amount_pence: resultingCaptured,
        refund_amount_pence: resultingRefunded,
        refund_reason: stripeRefundId ? reason : null,
        refunded_at: stripeRefundId ? new Date().toISOString() : null,
        stripe_charge_id: stripeChargeId,
        payment_status: netCapturedAfter > 0
          ? (resultingRefunded > 0 ? 'partially_refunded' : 'captured')
          : 'refunded',
        fare_snapshot_json: {
          ...existingSnapshot,
          ...tripSettlementSnapshotJson(settlementResult),
        },
        ...(Object.keys(settlementMetadata).length > 0 ? {
          stripe_application_fee_id: settlementMetadata.application_fee_id,
          stripe_application_fee_amount_pence: settlementMetadata.application_fee_amount_pence,
          stripe_destination_account_id: settlementMetadata.destination_account_id,
          stripe_transfer_id: settlementMetadata.transfer_id,
          stripe_transfer_amount_pence: settlementMetadata.transfer_amount_pence,
          stripe_settlement_verified: settlementMetadata.settlement_verified,
          stripe_settlement_warning: settlementMetadata.settlement_warning,
        } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', trip_id);

    await gate.supabase.from('admin_payment_audit').insert({
      trip_id,
      admin_user_id: gate.userId,
      action: 'edit_fare',
      reason,
      amount_pence_before: beforeFare,
      amount_pence_after: new_total_pence,
      delta_pence: new_total_pence - beforeFare,
      stripe_payment_intent_id: trip.stripe_payment_intent_id,
      stripe_refund_id: stripeRefundId,
      metadata: {
        scenario,
        resulting_captured: resultingCaptured,
        resulting_refunded: resultingRefunded,
        settlement_formula_version: settlementResult.formula_version,
        commission_pence: settlementResult.commission_pence,
        driver_net_pence: settlementResult.driver_net_pence,
        ...settlementMetadata,
      },
    });

    return jsonResponse({
      success: true,
      scenario,
      stripe_payment_intent_id: trip.stripe_payment_intent_id,
      stripe_charge_id: stripeChargeId,
      stripe_refund_id: stripeRefundId,
      new_total_pence,
      settlement: settlementResult,
      captured_pence: resultingCaptured,
      refunded_pence: resultingRefunded,
      message:
        scenario === 'captured_at_new_total' ? `Captured ${(new_total_pence / 100).toFixed(2)}; remainder voided.`
        : scenario === 'refunded_delta' ? `Refunded delta to set fare to ${(new_total_pence / 100).toFixed(2)}.`
        : 'Fare unchanged.',
    });
  } catch (e) {
    console.error('[admin-edit-trip-fare] Error:', e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
