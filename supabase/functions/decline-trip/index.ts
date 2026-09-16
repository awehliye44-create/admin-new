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

    // Locate the live offer on ride_offers (production SOT)
    const { data: offer, error: lookupErr } = await supabase
      .from('ride_offers')
      .select('id')
      .eq('trip_id', trip_id)
      .eq('driver_id', driver_id)
      .eq('status', 'pending')
      .maybeSingle();

    if (lookupErr || !offer) {
      console.log(`[decline-trip] No active ride_offer found`);
      await logAuditEvent(supabase, 'trip_decline_failed', {
        driverId: driver_id,
        tripId: trip_id,
        details: { reason: 'offer_not_found' },
        ipAddress: clientIP,
        userAgent,
      });
      return errorResponse('Offer not found or already processed', 404, undefined, 'OFFER_NOT_FOUND');
    }

    // Invoke decline_ride_offer RPC — it updates the offer and triggers
    // maybe_advance_dispatch_after_offer_resolution (wave advance / no_drivers).
    const { error: declineErr } = await supabase.rpc('decline_ride_offer', {
      p_offer_id: offer.id,
      p_driver_id: driver_id,
      p_reason: reason || null,
    });

    if (declineErr) {
      console.error('[decline-trip] decline_ride_offer RPC failed:', declineErr);
      return errorResponse(declineErr.message, 500, undefined, 'DECLINE_FAILED');
    }

    await logAuditEvent(supabase, 'trip_declined', {
      driverId: driver_id,
      tripId: trip_id,
      details: { decline_reason: reason || 'not_provided', offer_id: offer.id },
      ipAddress: clientIP,
      userAgent,
    });

    return successResponse({ declined: true, message: 'Offer declined' });

  } catch (error) {
    console.error('[decline-trip] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error',
      500
    );
  }
});
