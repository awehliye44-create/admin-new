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

    const { trip_id, driver_id, selected_offer_key } = validation.data! as AcceptTripRequest & { selected_offer_key?: string };

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

    // ====== STACKED RIDES ENFORCEMENT ======
    // Check if driver already has an active trip — if so, enforce Admin max_stacked_rides
    const { data: driverData } = await supabase
      .from('drivers')
      .select('current_trip_id')
      .eq('id', driver_id)
      .single();

    if (driverData?.current_trip_id) {
      // Driver is on an active trip — check stacked rides config
      const { data: stackedConfig } = await supabase
        .from('dispatch_settings')
        .select('stacked_rides_enabled, max_stacked_rides')
        .eq('service_area_id', tripForSA?.service_area_id)
        .maybeSingle();

      if (!stackedConfig || !stackedConfig.stacked_rides_enabled) {
        console.log(`[accept-trip] Stacked rides disabled — driver ${driver_id} already on trip`);
        return errorResponse('Stacked rides are not enabled for this service area', 403, {
          code: 'STACKED_RIDES_DISABLED'
        });
      }

      // Count driver's current active trips
      const { count: activeCount } = await supabase
        .from('trips')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', driver_id)
        .in('status', ['accepted', 'driver_arriving', 'arrived', 'in_progress']);

      const maxAllowed = stackedConfig.max_stacked_rides + 1; // current + stacked
      if ((activeCount || 0) >= maxAllowed) {
        console.log(`[accept-trip] Driver ${driver_id} at stacked limit: ${activeCount}/${maxAllowed}`);
        return errorResponse('Maximum stacked rides reached', 403, {
          code: 'MAX_STACKED_RIDES',
          current: activeCount,
          max: maxAllowed,
        });
      }
    }

    console.log(`[accept-trip] Driver ${driver_id} attempting to accept trip ${trip_id}`);

    // Verify the offer exists and is still valid
    const { data: offer, error: offerError } = await supabase
      .from('trip_offers')
      .select('id, status, expires_at')
      .eq('trip_id', trip_id)
      .eq('driver_id', driver_id)
      .single();

    if (offerError || !offer) {
      console.log(`[accept-trip] No offer found for driver ${driver_id} on trip ${trip_id}`);
      
      // Log failed attempt
      await logAuditEvent(supabase, 'trip_accept_failed', {
        driverId: driver_id,
        tripId: trip_id,
        details: { reason: 'offer_not_found' },
        ipAddress: clientIP,
        userAgent,
      });

      return errorResponse('Offer not found', 404, { message: 'This ride offer is no longer available' });
    }

    // Check if offer has expired
    if (new Date(offer.expires_at) < new Date()) {
      console.log(`[accept-trip] Offer expired for driver ${driver_id}`);
      
      await supabase
        .from('trip_offers')
        .update({ status: 'expired', responded_at: new Date().toISOString() })
        .eq('id', offer.id);

      await logAuditEvent(supabase, 'trip_accept_failed', {
        driverId: driver_id,
        tripId: trip_id,
        details: { reason: 'offer_expired' },
        ipAddress: clientIP,
        userAgent,
      });

      return errorResponse('Offer expired', 400, { message: 'This offer has expired' });
    }

    // Check if offer was already responded to
    if (offer.status !== 'offered') {
      console.log(`[accept-trip] Offer already processed: ${offer.status}`);
      return errorResponse('Already processed', 400, { 
        message: offer.status === 'accepted' ? 'You already accepted this ride' : 'This offer is no longer available' 
      });
    }

    // === Fetch cancellation grace period from fare_pricing_settings ===
    const { data: tripSAData } = await supabase
      .from('trips')
      .select('service_area_id, vehicle_type_id')
      .eq('id', trip_id)
      .single();

    let gracePeriodMinutes = 3; // sensible default
    if (tripSAData?.service_area_id) {
      const fpsQuery = supabase
        .from('fare_pricing_settings')
        .select('cancellation_grace_period_minutes')
        .eq('service_area_id', tripSAData.service_area_id);

      if (tripSAData.vehicle_type_id) {
        fpsQuery.eq('vehicle_type_id', tripSAData.vehicle_type_id);
      }

      const { data: fps } = await fpsQuery.maybeSingle();
      if (fps?.cancellation_grace_period_minutes != null) {
        gracePeriodMinutes = fps.cancellation_grace_period_minutes;
      }
    }

    const now = new Date();
    const graceExpiresAt = new Date(now.getTime() + gracePeriodMinutes * 60 * 1000);

    // ATOMIC OPERATION: Try to claim the trip
    const { data: updatedTrip, error: tripUpdateError } = await supabase
      .from('trips')
      .update({
        status: 'accepted',
        driver_id: driver_id,
        confirmed_driver_id: driver_id,
        assigned_at: now.toISOString(),
        cancellation_grace_expires_at: graceExpiresAt.toISOString(),
        updated_at: now.toISOString()
      })
      .eq('id', trip_id)
      .is('confirmed_driver_id', null)
      .eq('status', 'offered')
      .select()
      .single();

    if (tripUpdateError || !updatedTrip) {
      console.log(`[accept-trip] Trip already claimed by another driver`);
      
      await supabase
        .from('trip_offers')
        .update({ status: 'withdrawn', responded_at: new Date().toISOString() })
        .eq('id', offer.id);

      await logAuditEvent(supabase, 'trip_accept_failed', {
        driverId: driver_id,
        tripId: trip_id,
        details: { reason: 'already_taken' },
        ipAddress: clientIP,
        userAgent,
      });

      return errorResponse('Already accepted', 409, { message: 'Another driver accepted this ride first' });
    }

    console.log(`[accept-trip] Trip ${trip_id} successfully assigned to driver ${driver_id}`);

    // Mark this driver's offer as accepted
    await supabase
      .from('trip_offers')
      .update({ status: 'accepted', responded_at: new Date().toISOString() })
      .eq('id', offer.id);

    // Withdraw all other offers for this trip
    const { data: withdrawnOffers, error: withdrawError } = await supabase
      .from('trip_offers')
      .update({ status: 'withdrawn', responded_at: new Date().toISOString() })
      .eq('trip_id', trip_id)
      .eq('status', 'offered')
      .neq('driver_id', driver_id)
      .select('driver_id');

    if (withdrawError) {
      console.error('[accept-trip] Error withdrawing other offers:', withdrawError);
    } else {
      console.log(`[accept-trip] Withdrew ${withdrawnOffers?.length || 0} other offers`);
    }

    // Update driver's current trip
    await supabase
      .from('drivers')
      .update({ current_trip_id: trip_id })
      .eq('id', driver_id);

    // Log successful acceptance
    await logAuditEvent(supabase, 'trip_accepted', {
      driverId: driver_id,
      tripId: trip_id,
      details: { 
        withdrawn_offers: withdrawnOffers?.length || 0,
        offer_id: offer.id
      },
      ipAddress: clientIP,
      userAgent,
    });

    // Get trip details for response
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
      trip: tripDetails || updatedTrip,
      withdrawn_offers: withdrawnOffers?.length || 0
    });

  } catch (error) {
    console.error('[accept-trip] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error',
      500
    );
  }
});
