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
  acceptTripSchema, 
  AcceptTripRequest 
} from "../_shared/validation.ts";
import { checkOfferSchedule } from "../_shared/offerSchedule.ts";
import { authenticateDriver } from "../_shared/driverAuth.ts";
import { assertPaymentGate, PaymentGateError } from "../_shared/paymentGate.ts";

// Rate limit: 30 requests per minute per IP for trip acceptance
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
    console.log(`[accept-trip] Rate limit exceeded for IP: ${clientIP}`);
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }

  try {
    // Authenticate the driver via JWT
    const authResult = await authenticateDriver(req);
    if (authResult instanceof Response) return authResult;

    // Parse and validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON in request body', 400);
    }

    const validation = validateSchema<AcceptTripRequest>(body, acceptTripSchema);
    if (!validation.success) {
      console.log(`[accept-trip] Validation failed:`, validation.errors);
      return errorResponse('Validation failed', 400, { validation_errors: validation.errors });
    }

    const { trip_id, selected_offer_key } = validation.data! as AcceptTripRequest & { selected_offer_key?: string };
    // Use authenticated driver_id instead of body-supplied value
    const driver_id = authResult.driverId;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // --- P0 PAYMENT GATE: block driver-assign on digital trips whose payment is not authoritative ---
    try {
      await assertPaymentGate(supabase, trip_id);
    } catch (e) {
      if (e instanceof PaymentGateError) {
        console.log(`[accept-trip] PAYMENT_GATE_NOT_SATISFIED trip=${trip_id}: ${e.message}`);
        return errorResponse('Payment authorisation required before this trip can be accepted', 409,
          { detail: e.message }, 'PAYMENT_GATE_NOT_SATISFIED');
      }
      throw e;
    }

    // --- OFFER TOGGLE + SCHEDULE ENFORCEMENT ---
    // Get the trip's service_area_id first
    const { data: tripForSA } = await supabase
      .from('trips')
      .select('service_area_id')
      .eq('id', trip_id)
      .single();

    let offersAllowedNow = false;

    if (tripForSA?.service_area_id) {
      // Get offer config with schedule fields
      const { data: offerConfig } = await supabase
        .from('preset_offer_configs')
        .select('is_enabled, schedule_enabled, schedule_days, schedule_start_time, schedule_end_time')
        .eq('service_area_id', tripForSA.service_area_id)
        .maybeSingle();

      // Get service area timezone
      const { data: saData } = await supabase
        .from('service_areas')
        .select('timezone, region_id')
        .eq('id', tripForSA.service_area_id)
        .single();

      // Fallback to region timezone if service area doesn't have one
      let timezone = saData?.timezone;
      if (!timezone && saData?.region_id) {
        const { data: regionData } = await supabase
          .from('regions')
          .select('timezone')
          .eq('id', saData.region_id)
          .single();
        timezone = regionData?.timezone;
      }
      timezone = timezone || 'UTC';

      const scheduleCheck = checkOfferSchedule(offerConfig as any, timezone);
      offersAllowedNow = scheduleCheck.offersAllowedNow;

      // If offers are DISABLED globally but driver sent a preset offer key → reject
      if (!scheduleCheck.offersEnabled && selected_offer_key) {
        console.log(`[accept-trip] Offer toggle OFF but driver sent offer key: ${selected_offer_key}`);
        return errorResponse('Preset offers are disabled for this service area', 403, {
          code: 'OFFERS_DISABLED',
          message: 'Preset offers are not enabled. Accept the standard fare instead.'
        });
      }

      // If offers are enabled but outside schedule window and driver sent offer key → reject
      if (scheduleCheck.offersEnabled && !scheduleCheck.offersAllowedNow && selected_offer_key) {
        console.log(`[accept-trip] Offer outside schedule window. Reason: ${scheduleCheck.reason}`);
        return errorResponse('Offers are outside the scheduled window', 403, {
          code: 'OFFERS_OUTSIDE_SCHEDULE',
          message: 'Preset offers are not available at this time. Accept the standard fare instead.'
        });
      }

      // If offers are allowed now but driver did NOT send a preset offer key → reject
      if (scheduleCheck.offersAllowedNow && !selected_offer_key) {
        console.log(`[accept-trip] Offers required but driver sent no offer key`);
        return errorResponse('A preset offer selection is required', 400, {
          code: 'OFFER_SELECTION_REQUIRED',
          message: 'You must select a preset offer before accepting.'
        });
      }
    }

    console.log(`[accept-trip] Driver ${driver_id} attempting to accept trip ${trip_id}`);

    // Locate the live ride_offer for this driver/trip (production SOT)
    const { data: offer, error: offerError } = await supabase
      .from('ride_offers')
      .select('id, status')
      .eq('trip_id', trip_id)
      .eq('driver_id', driver_id)
      .in('status', ['pending', 'countered', 'accepted'])
      .order('offered_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (offerError || !offer) {
      console.log(`[accept-trip] No ride_offer found for driver ${driver_id} on trip ${trip_id}`);
      await logAuditEvent(supabase, 'trip_accept_failed', {
        driverId: driver_id,
        tripId: trip_id,
        details: { reason: 'offer_not_found' },
        ipAddress: clientIP,
        userAgent,
      });
      return errorResponse('Offer not found', 404, { message: 'This ride offer is no longer available' });
    }

    // Delegate to the production RPC — handles stacked-rides, atomic claim,
    // withdraw-other-offers, fare snapshot, and trip lifecycle.
    const { data: rpcResult, error: rpcErr } = await supabase.rpc('accept_ride_offer', {
      p_offer_id: offer.id,
      p_driver_id: driver_id,
    });

    if (rpcErr) {
      console.error('[accept-trip] accept_ride_offer RPC failed:', rpcErr);
      return errorResponse(rpcErr.message, 500, undefined, 'ACCEPT_FAILED');
    }

    const r: any = rpcResult ?? {};
    if (!r.success) {
      const code = r.error || 'ACCEPT_REJECTED';
      const status =
        code === 'OFFER_NOT_FOUND' ? 404 :
        code === 'OFFER_EXPIRED' ? 400 :
        code === 'TRIP_NOT_AVAILABLE' ? 409 :
        code === 'MAX_STACK_REACHED' || code === 'STACKED_RIDES_DISABLED' ? 403 :
        400;

      await logAuditEvent(supabase, 'trip_accept_failed', {
        driverId: driver_id,
        tripId: trip_id,
        details: { reason: code, rpc_response: r },
        ipAddress: clientIP,
        userAgent,
      });

      return errorResponse(r.message || 'Could not accept offer', status, { code, ...r });
    }

    console.log(`[accept-trip] Trip ${trip_id} successfully assigned to driver ${driver_id}`);

    await logAuditEvent(supabase, 'trip_accepted', {
      driverId: driver_id,
      tripId: trip_id,
      details: { offer_id: offer.id, idempotent: !!r.idempotent },
      ipAddress: clientIP,
      userAgent,
    });

    // Fetch trip details for response payload
    const { data: tripDetails } = await supabase
      .from('trips')
      .select(`
        id,
        trip_code,
        pickup_address,
        pickup_latitude,
        pickup_longitude,
        dropoff_address,
        dropoff_latitude,
        dropoff_longitude,
        passenger_name,
        passenger_phone,
        estimated_fare,
        estimated_distance_km,
        estimated_duration_minutes,
        payment_method,
        special_instructions,
        currency
      `)
      .eq('id', trip_id)
      .single();

    return successResponse({
      accepted: true,
      message: 'Ride accepted successfully!',
      trip: tripDetails,
      final_fare_pence: r.final_fare_pence,
      fare_source: r.fare_source,
    });

  } catch (error) {
    console.error('[accept-trip] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error',
      500
    );
  }
});
