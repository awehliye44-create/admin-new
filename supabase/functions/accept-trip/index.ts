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

    const { trip_id, driver_id } = validation.data!;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

    // ATOMIC OPERATION: Try to claim the trip
    const { data: updatedTrip, error: tripUpdateError } = await supabase
      .from('trips')
      .update({
        status: 'accepted',
        driver_id: driver_id,
        confirmed_driver_id: driver_id,
        updated_at: new Date().toISOString()
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
