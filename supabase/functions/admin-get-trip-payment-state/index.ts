import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  formatSettlementWarning,
  getSettlementWarningSeverity,
  isInformationalSettlementWarning,
} from "../_shared/stripeSettlementWarnings.ts";

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
      .select(`
        id, stripe_payment_intent_id, stripe_charge_id, payment_status, payment_method,
        gross_fare_pence, capture_amount_pence, authorised_amount_pence, refund_amount_pence,
        final_fare_pence, commission_pence, driver_net_pence,
        stripe_processing_fee_pence, onecab_net_pence, stripe_application_fee_id,
        stripe_application_fee_amount_pence, stripe_destination_account_id, stripe_transfer_id,
        stripe_transfer_amount_pence, stripe_settlement_verified, stripe_settlement_warning,
        passenger_id, refund_reason, refunded_at, created_at, completed_at
      `)
      .eq('id', trip_id)
      .single();

    if (tripErr || !trip) return jsonResponse({ error: 'Trip not found' }, 404);

    let customer_email: string | null = null;
    if (trip.passenger_id) {
      const { data: c } = await gate.supabase
        .from('customers')
        .select('email')
        .eq('user_id', trip.passenger_id)
        .maybeSingle();
      customer_email = c?.email ?? null;
    }

    let authorized_pence = trip.authorised_amount_pence ?? 0;
    let captured_pence = trip.capture_amount_pence ?? 0;
    let refunded_pence = trip.refund_amount_pence ?? 0;
    let stripe_status: string | null = null;
    let amount_capturable: number | null = null;
    let stripe_currency: string | null = null;
    let charge_id: string | null = trip.stripe_charge_id ?? null;
    let payment_created: string | null = trip.created_at ?? null;
    let captured_at: string | null = null;
    let charge_payment_method: string | null = null;
    let payment_method_brand: string | null = null;
    let last4: string | null = null;
    let stripe_fee_pence: number = trip.stripe_processing_fee_pence ?? 0;
    let stripe_application_fee_id: string | null = trip.stripe_application_fee_id ?? null;
    let stripe_application_fee_amount_pence: number | null = trip.stripe_application_fee_amount_pence ?? null;
    let stripe_destination_account_id: string | null = trip.stripe_destination_account_id ?? null;
    let stripe_transfer_id: string | null = trip.stripe_transfer_id ?? null;
    let stripe_transfer_amount_pence: number | null = trip.stripe_transfer_amount_pence ?? null;
    let stripe_settlement_verified: boolean = trip.stripe_settlement_verified ?? false;
    let stripe_settlement_warning: string | null = trip.stripe_settlement_warning ?? null;

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (stripeKey && trip.stripe_payment_intent_id) {
      try {
        const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
        const pi = await stripe.paymentIntents.retrieve(trip.stripe_payment_intent_id, {
          expand: ['latest_charge', 'latest_charge.balance_transaction', 'latest_charge.payment_method_details', 'latest_charge.application_fee', 'latest_charge.transfer'],
        });
        stripe_status = pi.status;
        stripe_currency = pi.currency?.toUpperCase() ?? null;
        amount_capturable = pi.amount_capturable ?? 0;
        authorized_pence = pi.amount ?? authorized_pence;
        payment_created = new Date((pi.created || 0) * 1000).toISOString();
        const piDestination = pi.transfer_data?.destination;
        if (piDestination) stripe_destination_account_id = typeof piDestination === 'string' ? piDestination : piDestination.id;

        const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge as Stripe.Charge : null;
        if (charge) {
          charge_id = charge.id;
          captured_pence = charge.amount_captured ?? captured_pence;
          refunded_pence = charge.amount_refunded ?? refunded_pence;
          if (charge.created) captured_at = new Date(charge.created * 1000).toISOString();
          if (!customer_email && charge.billing_details?.email) customer_email = charge.billing_details.email;
          const pmd = charge.payment_method_details;
          if (pmd?.type) charge_payment_method = pmd.type;
          if (pmd?.card?.brand) payment_method_brand = pmd.card.brand;
          if (pmd?.card?.last4) last4 = pmd.card.last4;
          const bt = charge.balance_transaction;
          if (bt && typeof bt === 'object' && 'fee' in bt) stripe_fee_pence = (bt as Stripe.BalanceTransaction).fee ?? stripe_fee_pence;
          if (charge.application_fee) {
            stripe_application_fee_id = typeof charge.application_fee === 'string' ? charge.application_fee : charge.application_fee.id;
            if (typeof charge.application_fee === 'object') stripe_application_fee_amount_pence = charge.application_fee.amount ?? stripe_application_fee_amount_pence;
          }
          const transfer = (charge as unknown as { transfer?: string | { id: string; amount?: number } }).transfer;
          if (transfer) {
            stripe_transfer_id = typeof transfer === 'string' ? transfer : transfer.id;
            if (typeof transfer === 'object') stripe_transfer_amount_pence = transfer.amount ?? stripe_transfer_amount_pence;
          }
        }
      } catch (e) {
        console.error('[admin-get-trip-payment-state] Stripe fetch failed:', (e as Error).message);
      }
    }

    const final_fare_pence = trip.final_fare_pence ?? trip.gross_fare_pence ?? 0;
    const buffer_pence = Math.max(0, authorized_pence - final_fare_pence);
    const commission_pence = trip.commission_pence ?? 0;
    const onecab_net_pence = trip.onecab_net_pence != null
      ? trip.onecab_net_pence
      : Math.max(0, commission_pence - stripe_fee_pence);
    const driver_net_pence = trip.driver_net_pence ?? Math.max(0, final_fare_pence - commission_pence);
    if (stripe_application_fee_amount_pence === commission_pence && stripe_application_fee_id && stripe_destination_account_id) {
      stripe_settlement_verified = true;
      stripe_settlement_warning = null;
    } else if (stripe_transfer_amount_pence === driver_net_pence && stripe_transfer_id && stripe_destination_account_id) {
      stripe_settlement_verified = true;
      stripe_settlement_warning = 'SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT';
    } else if (stripe_status === 'succeeded' && commission_pence > 0 && !stripe_application_fee_id && !stripe_transfer_id) {
      if (!(trip.stripe_settlement_verified && isInformationalSettlementWarning(stripe_settlement_warning))) {
        stripe_settlement_verified = false;
        stripe_settlement_warning = 'STRIPE_SETTLEMENT_NOT_VERIFIED_NO_APPLICATION_FEE_OR_TRANSFER';
      }
    } else if (trip.stripe_settlement_verified && stripe_settlement_verified && isInformationalSettlementWarning(stripe_settlement_warning)) {
      // Preserve backfilled verified trips with informational settlement notes.
      stripe_settlement_verified = true;
    }

    const stripe_settlement_warning_severity = getSettlementWarningSeverity(
      stripe_settlement_verified,
      stripe_settlement_warning,
    );

    return jsonResponse({
      trip_id,
      payment_intent_id: trip.stripe_payment_intent_id,
      charge_id,
      payment_method: charge_payment_method ?? trip.payment_method,
      payment_method_brand,
      last4,
      payment_status: trip.payment_status,
      stripe_status,
      stripe_currency,
      authorized_pence,
      captured_pence,
      refunded_pence,
      net_captured_pence: Math.max(0, captured_pence - refunded_pence),
      refundable_pence: Math.max(0, captured_pence - refunded_pence),
      amount_capturable_pence: amount_capturable,
      final_fare_pence,
      buffer_pence,
      commission_pence,
      stripe_fee_pence,
      onecab_net_pence,
      driver_net_pence,
      stripe_application_fee_id,
      stripe_application_fee_amount_pence,
      stripe_destination_account_id,
      stripe_transfer_id,
      stripe_transfer_amount_pence,
      stripe_settlement_verified,
      stripe_settlement_warning,
      stripe_settlement_warning_severity,
      stripe_settlement_warning_label: formatSettlementWarning(stripe_settlement_warning),
      customer_email,
      payment_created_at: payment_created,
      captured_at,
      refunded_at: trip.refunded_at,
    });
  } catch (e) {
    console.error('[admin-get-trip-payment-state] Error:', e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
