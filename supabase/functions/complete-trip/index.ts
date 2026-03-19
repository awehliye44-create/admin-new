import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";
import { 
  securityHeaders, 
  corsHeaders, 
  checkRateLimit, 
  getClientIP, 
  rateLimitResponse,
  successResponse,
  errorResponse,
  logAuditEvent
} from "../_shared/security.ts";
import { 
  validateSchema, 
  completeTripSchema, 
  CompleteTripRequest 
} from "../_shared/validation.ts";

const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60 * 1000 };

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers.get('user-agent') || 'unknown';
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON in request body', 400);
    }

    const validation = validateSchema<CompleteTripRequest>(body, completeTripSchema);
    if (!validation.success) {
      return errorResponse('Validation failed', 400, { validation_errors: validation.errors });
    }

    const {
      trip_id,
      driver_id,
      payment_method,
      base_fare_pence,
      pickup_waiting_charge_pence = 0,
      stop_waiting_charge_pence = 0,
      stop_modification_charge_pence = 0,
      destination_change_charge_pence = 0,
      extras_charge_pence = 0,
      tip_amount_pence = 0,
      stripe_payment_intent_id,
      final_fare_pence: legacy_fare_pence,
    } = validation.data!;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // === Resolve currency from Region (single source of truth) ===
    let currency_code: string;
    try {
      const regionCurrency = await resolveCurrencyFromTrip(supabase, trip_id);
      currency_code = regionCurrency.currency_code;
    } catch (e) {
      console.error('[complete-trip] Currency resolution failed:', e);
      return errorResponse((e as Error).message, 400);
    }

    // === FARE CALCULATION ===
    const effectiveBaseFare = base_fare_pence || legacy_fare_pence || 0;

    const commissionable_subtotal =
      effectiveBaseFare +
      pickup_waiting_charge_pence +
      stop_waiting_charge_pence +
      stop_modification_charge_pence +
      destination_change_charge_pence +
      extras_charge_pence;

    const final_trip_total = commissionable_subtotal + tip_amount_pence;

    console.log(`[complete-trip] Trip ${trip_id}, method: ${payment_method}, currency: ${currency_code}`);
    console.log(`[complete-trip] Subtotal: ${commissionable_subtotal}p, Tip: ${tip_amount_pence}p, Total: ${final_trip_total}p`);

    // === Validate trip ===
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, status, driver_id, service_area_id')
      .eq('id', trip_id)
      .single();

    if (tripError || !trip) {
      return errorResponse('Trip not found', 404);
    }

    if (trip.driver_id !== driver_id) {
      await logAuditEvent(supabase, 'trip_complete_unauthorized', {
        driverId: driver_id, tripId: trip_id,
        details: { actual_driver: trip.driver_id },
        ipAddress: clientIP, userAgent,
      });
      return errorResponse('Trip does not belong to this driver', 403);
    }

    // === Get driver info ===
    const { data: driver } = await supabase
      .from('drivers')
      .select('category_id, stripe_account_id')
      .eq('id', driver_id)
      .single();

    // === Commission from shared utility (single source of truth) ===
    const { commission_pct: commissionPercentage, commission_pence: platform_commission, driver_net_pence: driver_net_before_tip } = await calculateCommission(supabase, driver_id, commissionable_subtotal);
    const driver_total_earnings = driver_net_before_tip + tip_amount_pence;
    const isCashPayment = payment_method === 'CASH';

    console.log(`[complete-trip] Commission: ${platform_commission}p (${commissionPercentage}%), DriverNet: ${driver_net_before_tip}p, DriverTotal: ${driver_total_earnings}p`);

    // === Update trip to completed ===
    const tripUpdate: Record<string, unknown> = {
      status: 'completed',
      financial_outcome: 'COMPLETED',
      completed_at: new Date().toISOString(),
      fare: final_trip_total / 100,
      gross_fare_pence: commissionable_subtotal,
      commission_pence: platform_commission,
      driver_net_pence: driver_total_earnings,
      payment_method,
      updated_at: new Date().toISOString(),
    };

    // === Calculate wallet balance ===
    const { data: walletEntries } = await supabase
      .from('driver_ledger')
      .select('amount_pence')
      .eq('driver_id', driver_id);
    const walletBefore = walletEntries?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;

    // === Build trip_finance record ===
    const financeRecord: Record<string, unknown> = {
      trip_id,
      driver_id,
      service_area_id: trip.service_area_id,
      financial_status: 'recognized',
      revenue_type: 'completed_trip_revenue',
      is_financially_countable: true,
      base_fare_pence: effectiveBaseFare,
      pickup_waiting_charge_pence,
      stop_waiting_charge_pence,
      stop_modification_charge_pence,
      destination_change_charge_pence,
      extras_charge_pence,
      tip_amount_pence,
      commissionable_subtotal_pence: commissionable_subtotal,
      commission_rate_pct: commissionPercentage,
      platform_commission_pence: platform_commission,
      driver_net_before_tip_pence: driver_net_before_tip,
      driver_total_earnings_pence: driver_total_earnings,
      final_trip_total_pence: final_trip_total,
      payment_method,
      currency_code,
      wallet_balance_before_pence: walletBefore,
    };

    if (isCashPayment) {
      // === CASH TRIP ===
      tripUpdate.payment_status = 'collected_cash';
      tripUpdate.stripe_processing_fee_pence = 0;

      // Create CASH_COMMISSION_DEBT ledger entry
      const { data: ledgerEntry, error: ledgerError } = await supabase
        .from('driver_ledger')
        .insert({
          driver_id,
          trip_id,
          entry_type: 'CASH_COMMISSION_DEBT',
          amount_pence: -platform_commission,
          currency_code,
          description: `Commission owed from cash trip`,
        })
        .select('id')
        .single();

      if (ledgerError) {
        console.error('[complete-trip] Ledger error:', ledgerError);
      } else {
        console.log(`[complete-trip] CASH_COMMISSION_DEBT: -${platform_commission}p`);
        financeRecord.cash_commission_ledger_id = ledgerEntry?.id;
      }

      tripUpdate.wallet_balance_before = walletBefore;
      tripUpdate.wallet_balance_after = walletBefore - platform_commission;
      tripUpdate.debt_recovery_pence = 0;
      tripUpdate.final_payout_pence = 0;

      financeRecord.debt_recovery_pence = 0;
      financeRecord.final_driver_payout_pence = 0;
      financeRecord.wallet_balance_after_pence = walletBefore - platform_commission;
      financeRecord.settlement_status = 'settled';
      financeRecord.settled_at = new Date().toISOString();

    } else {
      // === DIGITAL TRIP: Use Stripe Connect Destination Charges ===
      tripUpdate.payment_status = stripe_payment_intent_id ? 'pending_capture' : 'pending';
      tripUpdate.stripe_payment_intent_id = stripe_payment_intent_id || null;

      if (stripe_payment_intent_id) {
        console.log(`[complete-trip] Invoking capture-trip-payment for PI: ${stripe_payment_intent_id}`);

        try {
          const captureResponse = await fetch(`${supabaseUrl}/functions/v1/capture-trip-payment`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              trip_id,
              driver_id,
              payment_intent_id: stripe_payment_intent_id,
              final_trip_total_pence: final_trip_total,
              commissionable_subtotal_pence: commissionable_subtotal,
              platform_commission_pence: platform_commission,
              driver_total_earnings_pence: driver_total_earnings,
              tip_amount_pence,
              currency_code,
              driver_stripe_account_id: driver?.stripe_account_id || null,
            }),
          });

          const captureResult = await captureResponse.json();

          if (captureResult.success) {
            console.log(`[complete-trip] Capture succeeded: payout=${captureResult.final_driver_payout_pence}p`);
            tripUpdate.payment_status = 'captured';
            tripUpdate.stripe_processing_fee_pence = captureResult.stripe_fee_pence || 0;
            tripUpdate.debt_recovery_pence = captureResult.debt_recovery_pence || 0;
            tripUpdate.final_payout_pence = captureResult.final_driver_payout_pence;
            tripUpdate.wallet_balance_before = captureResult.wallet_balance_before;
            tripUpdate.wallet_balance_after = captureResult.wallet_balance_after;

            financeRecord.stripe_processing_fee_pence = captureResult.stripe_fee_pence || 0;
            financeRecord.stripe_application_fee_id = captureResult.stripe_application_fee_id;
            financeRecord.debt_recovery_pence = captureResult.debt_recovery_pence || 0;
            financeRecord.final_driver_payout_pence = captureResult.final_driver_payout_pence;
            financeRecord.wallet_balance_after_pence = captureResult.wallet_balance_after;
            financeRecord.settlement_status = 'settled';
            financeRecord.settled_at = new Date().toISOString();
          } else {
            console.error(`[complete-trip] Capture failed:`, captureResult.error);
            tripUpdate.payment_status = 'capture_failed';
            financeRecord.settlement_status = 'failed';
          }
        } catch (captureErr) {
          console.error(`[complete-trip] Capture invocation error:`, captureErr);
          tripUpdate.payment_status = 'capture_failed';
          financeRecord.settlement_status = 'failed';
        }
      }

      financeRecord.stripe_payment_intent_id = stripe_payment_intent_id;
      financeRecord.stripe_destination_account_id = driver?.stripe_account_id;
    }

    // === Write trip_finance record ===
    const { error: financeError } = await supabase
      .from('trip_finance')
      .insert(financeRecord);

    if (financeError) {
      console.error('[complete-trip] trip_finance insert error:', financeError);
    }

    // === Update the trip ===
    const { error: updateError } = await supabase
      .from('trips')
      .update(tripUpdate)
      .eq('id', trip_id);

    if (updateError) {
      console.error('[complete-trip] Error updating trip:', updateError);
      return errorResponse('Failed to complete trip', 500);
    }

    // Clear driver's current trip
    await supabase.from('drivers')
      .update({ current_trip_id: null })
      .eq('id', driver_id);

    // Update total trips count
    try {
      const { count } = await supabase
        .from('trips')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', driver_id)
        .eq('status', 'completed');

      await supabase.from('drivers')
        .update({ total_trips: count || 0 })
        .eq('id', driver_id);
    } catch (e) {
      console.log('[complete-trip] Error updating total trips:', e);
    }

    // Audit log
    await logAuditEvent(supabase, 'payment_processed', {
      driverId: driver_id, tripId: trip_id,
      details: {
        payment_method,
        commissionable_subtotal,
        platform_commission,
        driver_total_earnings,
        tip_amount_pence,
        final_trip_total,
        payment_status: tripUpdate.payment_status,
        debt_recovery_pence: tripUpdate.debt_recovery_pence || 0,
        final_payout_pence: tripUpdate.final_payout_pence,
        currency_code,
      },
      ipAddress: clientIP, userAgent,
    });

    console.log(`[complete-trip] Trip ${trip_id} completed successfully`);

    return successResponse({
      trip_id,
      payment_method,
      commissionable_subtotal_pence: commissionable_subtotal,
      platform_commission_pence: platform_commission,
      commission_rate_pct: commissionPercentage,
      driver_net_before_tip_pence: driver_net_before_tip,
      tip_amount_pence,
      driver_total_earnings_pence: driver_total_earnings,
      final_trip_total_pence: final_trip_total,
      payment_status: tripUpdate.payment_status,
      is_cash: isCashPayment,
      debt_recovery_pence: tripUpdate.debt_recovery_pence || 0,
      final_driver_payout_pence: tripUpdate.final_payout_pence,
      currency_code,
    });

  } catch (error) {
    console.error('[complete-trip] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error', 500
    );
  }
});
