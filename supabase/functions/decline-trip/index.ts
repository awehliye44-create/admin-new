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
  declineTripSchema, 
  DeclineTripRequest 
} from "../_shared/validation.ts";
import { authenticateDriver } from "../_shared/driverAuth.ts";

// Rate limit: 50 requests per minute per IP
const RATE_LIMIT_CONFIG = { limit: 50, windowMs: 60 * 1000 };

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
    console.log(`[decline-trip] Rate limit exceeded for IP: ${clientIP}`);
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
      return errorResponse('Invalid JSON in request body', 400, undefined, 'VALIDATION_INVALID_FORMAT');
    }

    const validation = validateSchema<DeclineTripRequest>(body, declineTripSchema);
    if (!validation.success) {
      console.log(`[decline-trip] Validation failed:`, validation.errors);
      return errorResponse('Validation failed', 400, { validation_errors: validation.errors }, 'VALIDATION_FAILED');
    }

    const { trip_id, reason } = validation.data!;
    // Use authenticated driver_id instead of body-supplied value
    const driver_id = authResult.driverId;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[decline-trip] Driver ${driver_id} declining trip ${trip_id}`);

    // Find and update the offer
    const { data: offer, error: offerError } = await supabase
      .from('trip_offers')
      .update({ 
        status: 'declined', 
        responded_at: new Date().toISOString() 
      })
      .eq('trip_id', trip_id)
      .eq('driver_id', driver_id)
      .eq('status', 'offered')
      .select()
      .single();

    if (offerError || !offer) {
      console.log(`[decline-trip] No active offer found`);
      
      await logAuditEvent(supabase, 'trip_decline_failed', {
        driverId: driver_id,
        tripId: trip_id,
        details: { reason: 'offer_not_found' },
        ipAddress: clientIP,
        userAgent,
      });

      return errorResponse('Offer not found or already processed', 404, undefined, 'OFFER_NOT_FOUND');
    }

    console.log(`[decline-trip] Offer declined successfully`);

    // Log the decline
    await logAuditEvent(supabase, 'trip_declined', {
      driverId: driver_id,
      tripId: trip_id,
      details: { 
        decline_reason: reason || 'not_provided',
        offer_id: offer.id
      },
      ipAddress: clientIP,
      userAgent,
    });

    // Check if all offers are now declined/expired
    const { data: remainingOffers, error: remainingError } = await supabase
      .from('trip_offers')
      .select('id')
      .eq('trip_id', trip_id)
      .eq('status', 'offered');

    if (!remainingError && (!remainingOffers || remainingOffers.length === 0)) {
      console.log(`[decline-trip] No remaining offers for trip ${trip_id}`);
      
      // Check if trip is still in 'offered' status (not yet accepted or cancelled)
      const { data: trip } = await supabase
        .from('trips')
        .select('status, pickup_latitude, pickup_longitude, vehicle_type_id, service_area_id, dispatch_status')
        .eq('id', trip_id)
        .single();

      if (trip?.status === 'offered') {
        // Determine current wave from dispatch_status
        const currentWave = parseInt(trip.dispatch_status?.replace('wave_', '') || '0');
        
        // If we haven't exhausted all 3 waves, the polling loop in dispatch-drivers
        // will handle the next wave. Only mark as no_drivers if dispatch-drivers has
        // already finished (dispatch_status is 'no_drivers_found' or wave_3 completed).
        // Since dispatch-drivers is a long-running poller, it will detect the decline
        // via the expired offers check. But if dispatch-drivers has already exited
        // (e.g., late decline after wave timeout), we mark as no_drivers.
        
        // Check if dispatch-drivers is likely still running by checking recent offer creation
        const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
        const { count: recentOfferCount } = await supabase
          .from('trip_offers')
          .select('id', { count: 'exact', head: true })
          .eq('trip_id', trip_id)
          .gte('created_at', oneMinuteAgo);
        
        const dispatcherLikelyActive = (recentOfferCount || 0) > 0 && currentWave < 3;
        
        if (!dispatcherLikelyActive) {
          await supabase
            .from('trips')
            .update({ status: 'no_drivers', dispatch_status: 'all_declined' })
            .eq('id', trip_id);
          
          console.log(`[decline-trip] Trip ${trip_id} marked as no_drivers (all waves exhausted)`);

          await logAuditEvent(supabase, 'trip_no_drivers', {
            tripId: trip_id,
            details: { last_declined_by: driver_id, wave: currentWave },
            ipAddress: clientIP,
            userAgent,
          });
        } else {
          console.log(`[decline-trip] Trip ${trip_id}: dispatcher still active (wave ${currentWave}), not marking as no_drivers`);
        }
      }
    }

    return successResponse({
      declined: true,
      message: 'Offer declined'
    });

  } catch (error) {
    console.error('[decline-trip] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error',
      500
    );
  }
});
