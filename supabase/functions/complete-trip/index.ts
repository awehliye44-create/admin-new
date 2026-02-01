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

// Rate limit: 30 requests per minute per IP
const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60 * 1000 };

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers.get('user-agent') || 'unknown';

  // Check rate limit
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.log(`[complete-trip] Rate limit exceeded for IP: ${clientIP}`);
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }

  try {
    // Parse and validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON in request body', 400);
    }

    const validation = validateSchema<CompleteTripRequest>(body, completeTripSchema);
    if (!validation.success) {
      console.log(`[complete-trip] Validation failed:`, validation.errors);
      return errorResponse('Validation failed', 400, { validation_errors: validation.errors });
    }

    const { trip_id, driver_id, final_fare_pence, payment_method, stripe_payment_intent_id } = validation.data!;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[complete-trip] Completing trip ${trip_id} with payment method ${payment_method}`);

    // Validate trip exists and belongs to this driver
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, status, driver_id, service_area_id, currency')
      .eq('id', trip_id)
      .single();

    if (tripError || !trip) {
      console.error('[complete-trip] Trip not found:', tripError);
      return errorResponse('Trip not found', 404);
    }

    if (trip.driver_id !== driver_id) {
      await logAuditEvent(supabase, 'trip_complete_unauthorized', {
        driverId: driver_id,
        tripId: trip_id,
        details: { actual_driver: trip.driver_id },
        ipAddress: clientIP,
        userAgent,
      });
      return errorResponse('Trip does not belong to this driver', 403);
    }

    // Get commission rate for this service area
    let commissionPercentage = 20; // Default 20%
    if (trip.service_area_id) {
      const { data: pricing } = await supabase
        .from('service_area_vehicle_pricing')
        .select('commission_percentage')
        .eq('service_area_id', trip.service_area_id)
        .limit(1)
        .single();
      
      if (pricing?.commission_percentage) {
        commissionPercentage = pricing.commission_percentage;
      }
    }

    const commission_pence = Math.round(final_fare_pence * commissionPercentage / 100);
    const driver_net_pence = final_fare_pence - commission_pence;
    const currency_code = trip.currency || 'GBP';
    const isCashPayment = payment_method === 'CASH';

    console.log(`[complete-trip] Fare: ${final_fare_pence}p, Commission: ${commission_pence}p (${commissionPercentage}%), Net: ${driver_net_pence}p, Cash: ${isCashPayment}`);

    // Update trip to completed status with fare breakdown
    const tripUpdate: Record<string, unknown> = {
      status: 'completed',
      completed_at: new Date().toISOString(),
      fare: final_fare_pence / 100,
      gross_fare_pence: final_fare_pence,
      commission_pence: commission_pence,
      driver_net_pence: driver_net_pence,
      payment_method: payment_method,
      updated_at: new Date().toISOString()
    };

    if (isCashPayment) {
      tripUpdate.payment_status = 'collected_cash';

      const { error: ledgerError } = await supabase
        .from('driver_ledger')
        .insert({
          driver_id: driver_id,
          trip_id: trip_id,
          entry_type: 'CASH_COMMISSION_DEBT',
          amount_pence: -commission_pence,
          currency_code: currency_code,
          description: `Commission owed from cash trip`
        });

      if (ledgerError) {
        console.error('[complete-trip] Error creating ledger entry:', ledgerError);
      } else {
        console.log(`[complete-trip] Created CASH_COMMISSION_DEBT: -${commission_pence}p`);
      }
    } else {
      tripUpdate.payment_status = stripe_payment_intent_id ? 'processing' : 'pending';
      tripUpdate.stripe_payment_intent_id = stripe_payment_intent_id || null;

      if (stripe_payment_intent_id) {
        const { error: ledgerError } = await supabase
          .from('driver_ledger')
          .insert({
            driver_id: driver_id,
            trip_id: trip_id,
            entry_type: 'TRIP_EARNING_NET',
            amount_pence: driver_net_pence,
            currency_code: currency_code,
            description: `Net earnings from ${payment_method} payment`,
            reference_id: stripe_payment_intent_id
          });

        if (ledgerError) {
          console.error('[complete-trip] Error creating ledger entry:', ledgerError);
        } else {
          console.log(`[complete-trip] Created TRIP_EARNING_NET: +${driver_net_pence}p`);
          tripUpdate.payment_status = 'captured';
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
    await supabase
      .from('drivers')
      .update({ current_trip_id: null })
      .eq('id', driver_id);

    // Increment driver's total trips
    try {
      await supabase
        .from('drivers')
        .update({ total_trips: (await supabase.from('trips').select('id', { count: 'exact' }).eq('driver_id', driver_id).eq('status', 'completed')).count || 0 })
        .eq('id', driver_id);
    } catch (e) {
      console.log('[complete-trip] Error updating total trips:', e);
    }

    // Log payment event
    await logAuditEvent(supabase, 'payment_processed', {
      driverId: driver_id,
      tripId: trip_id,
      details: {
        payment_method,
        gross_fare_pence: final_fare_pence,
        commission_pence,
        driver_net_pence,
        payment_status: tripUpdate.payment_status,
        stripe_payment_intent_id: stripe_payment_intent_id || null
      },
      ipAddress: clientIP,
      userAgent,
    });

    console.log(`[complete-trip] Trip ${trip_id} completed successfully`);

    return successResponse({
      trip_id: trip_id,
      payment_method: payment_method,
      gross_fare_pence: final_fare_pence,
      commission_pence: commission_pence,
      driver_net_pence: driver_net_pence,
      payment_status: tripUpdate.payment_status,
      is_cash: isCashPayment,
      ledger_entry: isCashPayment ? 'CASH_COMMISSION_DEBT' : 'TRIP_EARNING_NET'
    });

  } catch (error) {
    console.error('[complete-trip] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error',
      500
    );
  }
});
