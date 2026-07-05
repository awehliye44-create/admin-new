import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  buildTripFinancialAuditContext,
  mapTripToFinancialAuditRow,
  type TripAuditSourceRow,
} from "../_shared/financeSettlementSummary.ts";
import {
  formatSettlementWarning,
  getSettlementWarningSeverity,
  isInformationalSettlementWarning,
} from "../_shared/stripeSettlementWarnings.ts";

const InputSchema = z.object({ trip_id: z.string().uuid() });

const TRIP_AUDIT_SELECT = `
  id,
  trip_code,
  commission_pence,
  stripe_processing_fee_pence,
  onecab_net_pence,
  driver_net_pence,
  gross_fare_pence,
  final_fare_pence,
  commissionable_fare_pence,
  capture_amount_pence,
  authorised_amount_pence,
  outstanding_balance_pence,
  payment_coverage_status,
  refund_amount_pence,
  pickup_waiting_charge_pence,
  stop_waiting_charge_pence,
  airport_charge_pence,
  other_pass_through_charges_pence,
  tip_pence,
  tip_amount_pence,
  payment_method,
  payment_status,
  financial_outcome,
  stripe_payment_intent_id,
  stripe_charge_id,
  provider_status,
  driver_id,
  passenger_id,
  passenger_name,
  stripe_settlement_verified,
  stripe_settlement_warning,
  stripe_application_fee_id,
  stripe_application_fee_amount_pence,
  stripe_destination_account_id,
  stripe_transfer_id,
  stripe_transfer_amount_pence,
  created_at,
  refunded_at,
  driver_tier_commission_percent,
  commission_pct,
  completed_at,
  service_area_id,
  driver:drivers!trips_driver_id_fkey(first_name, last_name)
`;

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
      .select(TRIP_AUDIT_SELECT)
      .eq('id', trip_id)
      .single();

    if (tripErr || !trip) return jsonResponse({ error: 'Trip not found' }, 404);

    const [paymentsRes, payoutItemsRes, ledgerRes] = await Promise.all([
      gate.supabase
        .from('payments')
        .select('trip_id, captured_amount_pence, amount_pence, status, provider_status, stripe_payment_intent_id, provider_available_on')
        .eq('trip_id', trip_id),
      gate.supabase
        .from('payout_items')
        .select('trip_id, status, driver_amount_pence, amount_pence, batch_id')
        .eq('trip_id', trip_id),
      gate.supabase
        .from('driver_wallet_ledger')
        .select('related_trip_id, type, amount_pence, stripe_payout_id, stripe_transfer_id')
        .eq('related_trip_id', trip_id),
    ]);

    const auditContext = buildTripFinancialAuditContext({
      payments: paymentsRes.data ?? [],
      payoutItems: payoutItemsRes.data ?? [],
      ledgerRows: (ledgerRes.data ?? []).map((row) => ({
        related_trip_id: row.related_trip_id ?? null,
        type: row.type,
        amount_pence: row.amount_pence,
        stripe_payout_id: row.stripe_payout_id ?? null,
        stripe_transfer_id: row.stripe_transfer_id ?? null,
      })),
    });

    const auditRow = mapTripToFinancialAuditRow(trip as TripAuditSourceRow, auditContext);

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
    let captured_pence = auditRow.captured_pence;
    let refunded_pence = auditRow.refunded_pence;
    let stripe_status: string | null = null;
    let amount_capturable: number | null = null;
    let stripe_currency: string | null = null;
    let charge_id: string | null = trip.stripe_charge_id ?? null;
    let payment_created: string | null = trip.created_at ?? null;
    let captured_at: string | null = null;
    let charge_payment_method: string | null = null;
    let payment_method_brand: string | null = null;
    let last4: string | null = null;
    let stripe_fee_pence: number = auditRow.processing_fee_pence;
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
          if (charge.amount_captured != null) captured_pence = charge.amount_captured;
          if (charge.amount_refunded != null) refunded_pence = charge.amount_refunded;
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

    const final_fare_pence = auditRow.final_fare_pence;
    const settlement_total_pence = auditRow.settlement_total_pence;
    const commission_pence = auditRow.onecab_gross_commission_pence;
    const onecab_net_pence = auditRow.onecab_net_pence;
    const driver_net_pence = auditRow.driver_net_pence;
    const buffer_pence = Math.max(0, authorized_pence - final_fare_pence);

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
      stripe_settlement_verified = true;
    }

    const stripe_settlement_warning_severity = getSettlementWarningSeverity(
      stripe_settlement_verified,
      stripe_settlement_warning,
    );

    const paymentMethod = String(charge_payment_method ?? trip.payment_method ?? '').toLowerCase();
    const isDigital = paymentMethod !== '' && paymentMethod !== 'cash';
    const financialOutcome = String(trip.financial_outcome ?? '').toLowerCase();
    const tripCancelled =
      financialOutcome.includes('cancel')
      || String(trip.payment_status ?? '').toLowerCase().includes('cancel');
    const refundableAmount = Math.max(0, captured_pence - refunded_pence);
    const refundStatus: 'none' | 'partial' | 'full' =
      captured_pence > 0 && refunded_pence >= captured_pence
        ? 'full'
        : refunded_pence > 0
          ? 'partial'
          : 'none';

    const can_capture =
      isDigital
      && !!trip.stripe_payment_intent_id
      && stripe_status === 'requires_capture'
      && (amount_capturable ?? 0) > 0
      && !tripCancelled
      && refundStatus !== 'full';

    const can_refund =
      isDigital
      && captured_pence > 0
      && refundableAmount > 0
      && refundStatus !== 'full'
      && !tripCancelled;

    const can_cancel_authorisation =
      isDigital
      && !!trip.stripe_payment_intent_id
      && stripe_status === 'requires_capture'
      && (amount_capturable ?? 0) > 0
      && !tripCancelled;

    const actions_allowed = {
      can_capture,
      can_refund,
      can_partial_refund: can_refund && refundableAmount > 0,
      can_cancel_authorisation,
      can_sync_stripe: isDigital && !!trip.stripe_payment_intent_id,
      can_add_note: true,
    };

    return jsonResponse({
      trip_id,
      trip_code: trip.trip_code ?? null,
      driver_id: trip.driver_id ?? null,
      passenger_id: trip.passenger_id ?? null,
      ssot_source: 'trip_financial_audit',
      payment_intent_id: trip.stripe_payment_intent_id,
      charge_id,
      payment_method: charge_payment_method ?? trip.payment_method,
      payment_method_brand,
      last4,
      payment_status: trip.payment_status,
      stripe_status,
      stripe_currency,
      amount_authorized_pence: authorized_pence,
      authorized_pence,
      amount_capturable_pence: amount_capturable,
      amount_captured_pence: captured_pence,
      captured_pence,
      refunded_amount_pence: refunded_pence,
      refunded_pence,
      refundable_amount_pence: refundableAmount,
      refundable_pence: refundableAmount,
      refund_status: refundStatus,
      net_captured_pence: Math.max(0, captured_pence - refunded_pence),
      final_customer_fare_pence: final_fare_pence,
      final_fare_pence,
      settlement_total_pence,
      gross_fare_pence: auditRow.gross_fare_pence,
      discount_pence: auditRow.discount_pence,
      buffer_pence,
      commission_pence,
      stripe_fee_pence,
      onecab_net_pence,
      driver_net_pence,
      recovery_debt_pence: auditRow.debt_recovered_pence,
      debt_recovered_pence: auditRow.debt_recovered_pence,
      stripe_transfer_amount_pence: stripe_transfer_amount_pence,
      available_payout_created_pence: auditRow.available_payout_created_pence,
      outstanding_pence: auditRow.outstanding_pence,
      capture_mismatch: auditRow.capture_mismatch,
      actions_allowed,
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
