import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { 
  corsHeaders, 
  checkRateLimit, 
  getClientIP, 
  rateLimitResponse,
  successResponse,
  errorResponse
} from "../_shared/security.ts";
import { 
  validateSchema, 
  findDriversSchema, 
  FindDriversRequest 
} from "../_shared/validation.ts";
import {
  evaluateRideNowVehicleAvailability,
  RIDE_NOW_NO_DRIVERS_MESSAGE,
  RIDE_NOW_NO_DRIVERS_SUBTEXT,
} from "../_shared/findDriversAvailabilitySSOT.ts";

/**
 * Ride Now vehicle availability SSOT for Customer Choose Ride and Corporate Book a Ride.
 * Do not add a parallel corporate-only nearby-driver calculator.
 * Empty eligible set → availability_state: unavailable (cards stay visible, not selectable).
 *
 * Eligibility logic lives in `_shared/findDriversAvailabilitySSOT.ts` so WhatsApp / guest
 * web / book-time gates reuse the identical rules.
 */

// Rate limit: 60 requests per minute per IP
const RATE_LIMIT_CONFIG = { limit: 60, windowMs: 60 * 1000 };

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);

  // Check rate limit
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.log(`[find-drivers] Rate limit exceeded for IP: ${clientIP}`);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    // ── Authenticate caller ──
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return errorResponse('Missing authorization header', 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const token = authHeader.replace('Bearer ', '');
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) {
      return errorResponse('Invalid or expired token', 401);
    }

    // Parse and validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON in request body', 400);
    }

    const validation = validateSchema<FindDriversRequest>(body, findDriversSchema);
    if (!validation.success) {
      console.log(`[find-drivers] Validation failed:`, validation.errors);
      return errorResponse('Validation failed', 400, { validation_errors: validation.errors });
    }

    // Default Ride Now radius: 27 km ≈ 16.77 miles (client may override).
    const { pickup_lat, pickup_lng, vehicle_type_id, max_distance_km = 27 } = validation.data!;

    console.log('Finding drivers for pickup:', { pickup_lat, pickup_lng, vehicle_type_id });

    const result = await evaluateRideNowVehicleAvailability(supabase, {
      pickup_lat,
      pickup_lng,
      vehicle_type_id,
      max_distance_km,
    });

    if (result.availability_state === "error") {
      return errorResponse(
        result.message || "Internal server error",
        500,
        {
          drivers: [],
          message: RIDE_NOW_NO_DRIVERS_MESSAGE,
          subtext: RIDE_NOW_NO_DRIVERS_SUBTEXT,
        },
      );
    }

    if (result.availability_state !== "available" || result.drivers.length === 0) {
      return successResponse({
        drivers: [],
        availability_state: "unavailable",
        message: result.message || RIDE_NOW_NO_DRIVERS_MESSAGE,
        subtext: result.subtext || RIDE_NOW_NO_DRIVERS_SUBTEXT,
      });
    }

    return successResponse({
      drivers: result.drivers,
      availability_state: "available",
      service_area_ids: result.service_area_ids ?? [],
      region: result.region,
      settings: result.region
        ? {
            currency_code: result.region.currency_code,
            distance_unit: result.region.distance_unit,
            timezone: result.region.timezone,
          }
        : undefined,
    });

  } catch (error) {
    console.error('Error in find-drivers:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Internal server error',
      500,
      {
        drivers: [],
        message: RIDE_NOW_NO_DRIVERS_MESSAGE,
        subtext: RIDE_NOW_NO_DRIVERS_SUBTEXT,
      }
    );
  }
});
