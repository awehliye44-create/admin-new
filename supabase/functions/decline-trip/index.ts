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

    const { trip_id, driver_id, reason } = validation.data!;

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

      return errorResponse('Offer not found or already processed', 404);
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
      
      // Check if trip is still in 'offered' status
      const { data: trip } = await supabase
        .from('trips')
        .select('status')
        .eq('id', trip_id)
        .single();

      if (trip?.status === 'offered') {
        await supabase
          .from('trips')
          .update({ status: 'no_drivers' })
          .eq('id', trip_id);
        
        console.log(`[decline-trip] Trip ${trip_id} marked as no_drivers`);

        await logAuditEvent(supabase, 'trip_no_drivers', {
          tripId: trip_id,
          details: { last_declined_by: driver_id },
          ipAddress: clientIP,
          userAgent,
        });
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
