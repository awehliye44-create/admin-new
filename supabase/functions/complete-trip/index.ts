import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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

    const { trip_id, driver_id, final_fare_pence, payment_method, stripe_payment_intent_id } = validation.data!;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[complete-trip] Completing trip ${trip_id}, method: ${payment_method}`);

    // === Validate trip ===
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, status, driver_id, service_area_id, currency')
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

    // === Get commission rate ===
    let commissionPercentage = 20;
    const { data: driver } = await supabase
      .from('drivers')
      .select('commission_override_pct, category_id')
      .eq('id', driver_id)
      .single();

    if (driver?.commission_override_pct != null) {
      commissionPercentage = driver.commission_override_pct;
      console.log(`[complete-trip] Driver override commission: ${commissionPercentage}%`);
    } else if (driver?.category_id) {
      const { data: category } = await supabase
        .from('driver_categories')
        .select('commission_pct')
        .eq('id', driver.category_id)
        .single();
      if (category?.commission_pct != null) {
        commissionPercentage = category.commission_pct;
        console.log(`[complete-trip] Category commission: ${commissionPercentage}%`);
      }
    }

    const commission_pence = Math.round(final_fare_pence * commissionPercentage / 100);
    const driver_net_pence = final_fare_pence - commission_pence;
    const currency_code = trip.currency || 'GBP';
    const isCashPayment = payment_method === 'CASH';

    console.log(`[complete-trip] Fare: ${final_fare_pence}p, Commission: ${commission_pence}p (${commissionPercentage}%), Net: ${driver_net_pence}p, Cash: ${isCashPayment}`);

    // === Update trip to completed ===
    const tripUpdate: Record<string, unknown> = {
      status: 'completed',
      completed_at: new Date().toISOString(),
      fare: final_fare_pence / 100,
      gross_fare_pence: final_fare_pence,
      commission_pence,
      driver_net_pence,
      payment_method,
      updated_at: new Date().toISOString(),
    };

    if (isCashPayment) {
      // === CASH TRIP: Driver keeps cash, platform debits commission from wallet ===
      tripUpdate.payment_status = 'collected_cash';
      tripUpdate.stripe_processing_fee_pence = 0; // No Stripe fee on cash

      // Calculate wallet balance before
      const { data: walletEntries } = await supabase
        .from('driver_ledger')
        .select('amount_pence')
        .eq('driver_id', driver_id);
      const walletBefore = walletEntries?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;

      // Create CASH_COMMISSION_DEBT ledger entry
      const { error: ledgerError } = await supabase
        .from('driver_ledger')
        .insert({
          driver_id,
          trip_id,
          entry_type: 'CASH_COMMISSION_DEBT',
          amount_pence: -commission_pence, // Negative = debt owed to platform
          currency_code,
          description: `Commission owed from cash trip`,
        });

      if (ledgerError) {
        console.error('[complete-trip] Ledger error:', ledgerError);
      } else {
        console.log(`[complete-trip] CASH_COMMISSION_DEBT: -${commission_pence}p`);
      }

      tripUpdate.wallet_balance_before = walletBefore;
      tripUpdate.wallet_balance_after = walletBefore - commission_pence;
      tripUpdate.debt_recovery_pence = 0;
      tripUpdate.final_payout_pence = 0; // No Stripe payout for cash

    } else {
      // === DIGITAL TRIP: Delegate capture + transfer to capture-trip-payment ===
      tripUpdate.payment_status = stripe_payment_intent_id ? 'pending_capture' : 'pending';
      tripUpdate.stripe_payment_intent_id = stripe_payment_intent_id || null;

      // If we have a PaymentIntent, invoke capture-trip-payment
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
              final_fare_pence,
              commission_pence,
              driver_net_pence,
              currency_code,
            }),
          });

          const captureResult = await captureResponse.json();
          
          if (captureResult.success) {
            console.log(`[complete-trip] Capture succeeded: transfer=${captureResult.stripe_transfer_id}, payout=${captureResult.final_payout_pence}p`);
            // capture-trip-payment already updated the trip record with settlement fields
            // Override payment_status from our tripUpdate since capture already set it
            tripUpdate.payment_status = 'captured';
            tripUpdate.stripe_processing_fee_pence = captureResult.stripe_fee_pence || 0;
            tripUpdate.stripe_transfer_id = captureResult.stripe_transfer_id;
            tripUpdate.debt_recovery_pence = captureResult.debt_recovery_pence || 0;
            tripUpdate.final_payout_pence = captureResult.final_payout_pence;
            tripUpdate.wallet_balance_before = captureResult.wallet_balance_before;
            tripUpdate.wallet_balance_after = captureResult.wallet_balance_after;
          } else {
            console.error(`[complete-trip] Capture failed:`, captureResult.error);
            tripUpdate.payment_status = 'capture_failed';
          }
        } catch (captureErr) {
          console.error(`[complete-trip] Capture invocation error:`, captureErr);
          tripUpdate.payment_status = 'capture_failed';
        }
      }
    }

    // Update the trip
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
        gross_fare_pence: final_fare_pence,
        commission_pence,
        driver_net_pence,
        payment_status: tripUpdate.payment_status,
        debt_recovery_pence: tripUpdate.debt_recovery_pence || 0,
        final_payout_pence: tripUpdate.final_payout_pence,
        stripe_payment_intent_id: stripe_payment_intent_id || null,
        stripe_transfer_id: tripUpdate.stripe_transfer_id || null,
      },
      ipAddress: clientIP, userAgent,
    });

    console.log(`[complete-trip] Trip ${trip_id} completed successfully`);

    return successResponse({
      trip_id,
      payment_method,
      gross_fare_pence: final_fare_pence,
      commission_pence,
      driver_net_pence,
      payment_status: tripUpdate.payment_status,
      is_cash: isCashPayment,
      debt_recovery_pence: tripUpdate.debt_recovery_pence || 0,
      final_payout_pence: tripUpdate.final_payout_pence,
    });

  } catch (error) {
    console.error('[complete-trip] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error', 500
    );
  }
});
