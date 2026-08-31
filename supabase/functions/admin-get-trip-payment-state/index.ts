import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import {
  buildTripFinancialAuditContext,
  mapTripToFinancialAuditRow,
  type TripAuditSourceRow,
} from "../_shared/financeSettlementSummary.ts";
import {
  formatSettlementWarning,
  getSettlementWarningSeverity,
  isInformationalSettlementWarning,
} from "../_shared/settlementWarnings.ts";
import {
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
} from "../_shared/revolutOrders.ts";
import {
  resolveTripPaymentProvider,
  tripProviderOrderId,
} from "../_shared/tripPaymentProviderSSOT.ts";
import { readSavedCardAttemptFromSessionMetadata } from "../_shared/tripHistoryShortfallRecaptureSSOT.ts";

const InputSchema = z.object({ trip_id: z.string().uuid() });

const PAYMENT_SESSION_MONEY_SELECT =
  "id, trip_id, purpose, status, payment_method, captured_amount_pence, authorised_amount_pence, total_authorised_amount_pence, released_amount_pence, refunded_amount_pence, provider_processing_fee_pence, fee_status, provider_state, provider_state_verified_at, release_evidence_status, release_evidence_source, release_verified_at, metadata";

function nonNegPence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

const TRIP_AUDIT_SELECT = `
  id,
  trip_code,
  currency_code,
  commission_pence,
  provider_fee_pence:provider_fee_pence,
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
  provider_charge_id:provider_charge_id,
  provider_transfer_id:provider_transfer_id,
  provider_order_id,
  provider_payment_id,
  payment_provider,
  provider_status,
  driver_id,
  passenger_id,
  passenger_name,
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
    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) return jsonResponse({ error: 'Invalid input', details: parsed.error.flatten() }, 400);
    const { trip_id } = parsed.data;

    const { data: tripRow, error: tripErr } = await gate.supabase
      .from('trips')
      .select(TRIP_AUDIT_SELECT)
      .eq('id', trip_id)
      .maybeSingle();

    if (tripErr) {
      console.error('[admin-get-trip-payment-state] trip query failed:', tripErr.message);
      return jsonResponse({ error: 'Trip lookup failed', details: tripErr.message }, 500);
    }
    if (!tripRow) {
      return jsonResponse({ error: 'Trip not found', code: 'TRIP_NOT_FOUND', trip_id }, 404);
    }

    const trip = {
      ...(tripRow as Record<string, unknown>),
      provider_payment_id: (tripRow as { provider_payment_id?: string | null }).provider_payment_id ?? null,
      provider_settlement_verified: false,
      provider_settlement_warning: null,
    } as unknown as TripAuditSourceRow & Record<string, any>;

    const paymentProvider = resolveTripPaymentProvider(trip);
    const providerOrderId = tripProviderOrderId(trip);


    const [paymentsRes, payoutItemsRes, ledgerRes, paymentSessionsRes] = await Promise.all([
      gate.supabase
        .from('payments')
        .select('trip_id, captured_amount_pence, amount_pence, status, provider_status, provider_payment_id:provider_payment_id, provider_available_on')
        .eq('trip_id', trip_id),
      gate.supabase
        .from('payout_items')
        .select('trip_id, status, driver_amount_pence, amount_pence, batch_id')
        .eq('trip_id', trip_id),
      gate.supabase
        .from('driver_wallet_ledger')
        .select('related_trip_id, type, amount_pence, provider_payout_id:provider_payout_id, provider_transfer_id:provider_transfer_id')
        .eq('related_trip_id', trip_id),
      gate.supabase
        .from('payment_sessions')
        .select(PAYMENT_SESSION_MONEY_SELECT)
        .eq('trip_id', trip_id),
    ]);

    const auditContext = buildTripFinancialAuditContext({
      payments: (paymentsRes.data ?? []).map((p) => ({
        trip_id: p.trip_id ?? null,
        status: p.status,
        provider_status: p.provider_status,
        captured_amount_pence: null,
        provider_payment_id: p.provider_payment_id ?? null,
        provider_available_on: p.provider_available_on ?? null,
      })),
      payoutItems: payoutItemsRes.data ?? [],
      ledgerRows: (ledgerRes.data ?? []).map((row) => ({
        related_trip_id: row.related_trip_id ?? null,
        type: row.type,
        amount_pence: row.amount_pence,
        provider_payout_id: row.provider_payout_id ?? null,
        provider_transfer_id: row.provider_transfer_id ?? null,
      })),
      paymentSessions: paymentSessionsRes.data ?? [],
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

    let authorized_pence = nonNegPence(trip.authorised_amount_pence);
    let captured_pence = nonNegPence(auditRow.captured_pence ?? trip.capture_amount_pence);
    let refunded_pence = nonNegPence(auditRow.refunded_pence ?? trip.refund_amount_pence);
    let provider_state: string | null = null;
    let amount_capturable: number | null = null;
    let provider_currency_code: string | null = (trip.currency_code ?? 'GBP').toUpperCase();
    let charge_id: string | null = trip.provider_charge_id ?? null;
    let payment_created: string | null = trip.created_at ?? null;
    let captured_at: string | null = null;
    let charge_payment_method: string | null = null;
    let payment_method_brand: string | null = null;
    let last4: string | null = null;
    let provider_fee_pence: number = auditRow.processing_fee_pence;
    const provider_transfer_id: string | null = trip.provider_transfer_id ?? null;
    let provider_settlement_verified: boolean = trip.provider_settlement_verified ?? false;
    let provider_settlement_warning: string | null = trip.provider_settlement_warning ?? null;
    let provider_status: string | null = trip.provider_status ?? null;
    let provider_currency: string | null = null;

    if (paymentProvider === 'revolut' && providerOrderId) {
      try {
        const { secretKey, environment } = getRevolutMerchantConfig();
        const order = await retrieveRevolutOrder(environment, secretKey, providerOrderId);
        provider_status = order.state ?? provider_status;
        provider_currency = (order.currency ?? trip.currency_code ?? 'GBP').toUpperCase();
        authorized_pence = nonNegPence(order.amount ?? authorized_pence);
        const state = String(order.state ?? '').toUpperCase();
        if (state === 'COMPLETED' || state === 'REFUNDED') {
          captured_pence = Math.max(
            captured_pence,
            nonNegPence(trip.capture_amount_pence ?? order.amount ?? 0),
          );
        }
        provider_state = state.toLowerCase() || null;
        provider_currency_code = provider_currency;
        amount_capturable = state === 'AUTHORISED'
          ? Math.max(0, authorized_pence - captured_pence)
          : 0;
      } catch (e) {
        console.error('[admin-get-trip-payment-state] Revolut fetch failed:', (e as Error).message);
        provider_currency_code = (trip.currency_code ?? 'GBP').toUpperCase();
      }
    }

    const final_fare_pence = nonNegPence(auditRow.final_fare_pence);
    const settlement_total_pence = nonNegPence(auditRow.settlement_total_pence);
    const commission_pence = nonNegPence(auditRow.onecab_gross_commission_pence);
    const onecab_net_pence = auditRow.onecab_net_pence;
    const driver_net_pence = auditRow.driver_net_pence;
    const buffer_pence = Math.max(0, authorized_pence - final_fare_pence);

    if (provider_transfer_id) {
      provider_settlement_verified = true;
      provider_settlement_warning = null;
    } else if (
      trip.provider_settlement_verified
      && provider_settlement_verified
      && isInformationalSettlementWarning(provider_settlement_warning)
    ) {
      provider_settlement_verified = true;
    }

    const provider_settlement_warning_severity = getSettlementWarningSeverity(
      provider_settlement_verified,
      provider_settlement_warning,
    );

    const paymentMethod = String(charge_payment_method ?? trip.payment_method ?? '').toLowerCase();
    const isDigital = paymentMethod !== '';
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
      paymentProvider !== 'unknown'
      && isDigital
      && paymentProvider === 'revolut' && !!providerOrderId
      && String(provider_state ?? '').toUpperCase() === 'AUTHORISED'
      && (amount_capturable ?? 0) > 0
      && !tripCancelled
      && refundStatus !== 'full';

    const can_refund =
      paymentProvider !== 'unknown'
      && isDigital
      && captured_pence > 0
      && refundableAmount > 0
      && refundStatus !== 'full'
      && !tripCancelled;

    const can_cancel_authorisation =
      paymentProvider !== 'unknown'
      && isDigital
      && paymentProvider === 'revolut' && !!providerOrderId
      && ['pending', 'processing', 'authorised'].includes(String(provider_state ?? '').toLowerCase())
      && (amount_capturable ?? 0) > 0
      && !tripCancelled;

    const actions_allowed = {
      can_capture,
      can_refund,
      can_partial_refund: can_refund && refundableAmount > 0,
      can_cancel_authorisation,
      can_add_note: true,
    };

    const { data: openRecovery } = await gate.supabase
      .from("payment_sessions")
      .select(
        "id, status, provider_checkout_url, provider_order_id, estimated_total_pence, captured_amount_pence, purpose, metadata",
      )
      .eq("trip_id", trip_id)
      .eq("purpose", "PAYMENT_RECOVERY")
      .in("status", ["RECOVERY_CHECKOUT_CREATED", "CUSTOMER_ACTION_REQUIRED"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return jsonResponse({
      trip_id,
      trip_code: trip.trip_code ?? null,
      driver_id: trip.driver_id ?? null,
      passenger_id: trip.passenger_id ?? null,
      payment_provider: paymentProvider,
      provider_order_id: providerOrderId,
      open_recovery_session: (() => {
        if (!openRecovery) return null;
        const savedCard = readSavedCardAttemptFromSessionMetadata(openRecovery.metadata);
        return {
          id: openRecovery.id,
          status: openRecovery.status,
          provider_checkout_url: openRecovery.provider_checkout_url ?? null,
          provider_order_id: openRecovery.provider_order_id ?? null,
          estimated_total_pence: openRecovery.estimated_total_pence ?? null,
          captured_amount_pence: openRecovery.captured_amount_pence ?? null,
          saved_card_charged: savedCard.succeeded,
          saved_card_state: savedCard.state,
        };
      })(),
      ssot_source: 'trip_financial_audit',
      payment_intent_id: providerOrderId,
      charge_id,
      payment_method: charge_payment_method ?? trip.payment_method,
      payment_method_brand,
      last4,
      payment_status: trip.payment_status,
      provider_status,
      provider_state,
      provider_currency_code,
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
      provider_fee_pence,
      onecab_net_pence,
      driver_net_pence,
      recovery_debt_pence: auditRow.debt_recovered_pence,
      debt_recovered_pence: auditRow.debt_recovered_pence,
      available_payout_created_pence: auditRow.available_payout_created_pence,
      outstanding_pence: auditRow.outstanding_pence,
      capture_mismatch: auditRow.capture_mismatch,
      actions_allowed,
      provider_transfer_id,
      provider_settlement_verified,
      provider_settlement_warning,
      provider_settlement_warning_severity,
      provider_settlement_warning_label: formatSettlementWarning(provider_settlement_warning),
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
