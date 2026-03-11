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
  dispatchTripSchema, 
  DispatchTripRequest 
} from "../_shared/validation.ts";

// Rate limit: 20 requests per minute per IP for dispatch
const RATE_LIMIT_CONFIG = { limit: 20, windowMs: 60 * 1000 };

interface LatLng {
  lat: number;
  lng: number;
}

// Ray casting algorithm for point-in-polygon
// Handles both {lat, lng} objects and [lng, lat] arrays
function parseCoord(item: any): LatLng | null {
  if (Array.isArray(item) && item.length >= 2) {
    return { lng: item[0], lat: item[1] };
  }
  if (item && typeof item.lat === 'number' && typeof item.lng === 'number') {
    return { lat: item.lat, lng: item.lng };
  }
  return null;
}

function isPointInPolygon(point: LatLng, polygon: any[]): boolean {
  if (!polygon || polygon.length < 3) return false;
  
  let inside = false;
  const x = point.lng, y = point.lat;
  
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ci = parseCoord(polygon[i]);
    const cj = parseCoord(polygon[j]);
    if (!ci || !cj) continue;
    
    if (((ci.lat > y) !== (cj.lat > y)) && (x < (cj.lng - ci.lng) * (y - ci.lat) / (cj.lat - ci.lat) + ci.lng)) {
      inside = !inside;
    }
  }
  
  return inside;
}

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
    console.log(`[dispatch-trip] Rate limit exceeded for IP: ${clientIP}`);
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

    const validation = validateSchema<DispatchTripRequest>(body, dispatchTripSchema);
    if (!validation.success) {
      console.log(`[dispatch-trip] Validation failed:`, validation.errors);
      return errorResponse('Validation failed', 400, { validation_errors: validation.errors });
    }

    const { 
      trip_id, 
      pickup_lat, 
      pickup_lng, 
      vehicle_type_id,
    } = validation.data!;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[dispatch-trip] Starting dispatch for trip ${trip_id}`);
    console.log(`[dispatch-trip] Pickup: ${pickup_lat}, ${pickup_lng}`);

    // Validate trip exists and is in valid state
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, status, pickup_latitude, pickup_longitude, service_area_id')
      .eq('id', trip_id)
      .single();

    if (tripError || !trip) {
      console.error(`[dispatch-trip] Trip not found: ${trip_id}`);
      return errorResponse('Trip not found', 404);
    }

    const terminalStatuses = ['accepted', 'driver_arriving', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_drivers'];
    if (terminalStatuses.includes(trip.status)) {
      console.log(`[dispatch-trip] Trip ${trip_id} already in status: ${trip.status}`);
      return errorResponse('Trip already processed', 400, { status: trip.status });
    }

    // ====== RESOLVE SERVICE AREA ======
    // Get active regions
    const { data: regions } = await supabase
      .from('regions')
      .select('id, name, geo_boundary, currency_code')
      .eq('status', 'active');

    const pickupPoint: LatLng = { lat: pickup_lat, lng: pickup_lng };
    let matchedRegion = null;

    for (const region of regions || []) {
      if (region.geo_boundary) {
        const boundary = Array.isArray(region.geo_boundary) 
          ? region.geo_boundary 
          : (region.geo_boundary as any).coordinates || [];
        
        if (isPointInPolygon(pickupPoint, boundary)) {
          matchedRegion = region;
          break;
        }
      }
    }

    if (!matchedRegion) {
      console.log('[dispatch-trip] Pickup location not in any active region');
      await supabase.from('trips').update({ status: 'no_service_area' }).eq('id', trip_id);
      return successResponse({
        dispatched: false,
        message: 'Service not available in this area',
        subtext: 'Your pickup location is outside our service regions.'
      });
    }

    console.log(`[dispatch-trip] Matched region: ${matchedRegion.name}`);

    // Get active service areas in this region
    const { data: serviceAreas } = await supabase
      .from('service_areas')
      .select('id, name, geo_boundary')
      .eq('region_id', matchedRegion.id)
      .eq('is_active', true);

    const matchedServiceAreaIds: string[] = [];
    for (const sa of serviceAreas || []) {
      if (sa.geo_boundary) {
        const boundary = Array.isArray(sa.geo_boundary) 
          ? sa.geo_boundary 
          : (sa.geo_boundary as any).coordinates || [];
        
        if (boundary.length >= 3 && isPointInPolygon(pickupPoint, boundary)) {
          matchedServiceAreaIds.push(sa.id);
        }
      }
    }

    console.log(`[dispatch-trip] Matched service areas: ${matchedServiceAreaIds.length}`);

    if (matchedServiceAreaIds.length === 0) {
      await supabase.from('trips').update({ status: 'no_service_area' }).eq('id', trip_id);
      return successResponse({
        dispatched: false,
        message: 'Service not available in this area',
        subtext: 'Your pickup location is outside our service areas.'
      });
    }

    // ====== GENERATE TRIP NUMBER ======
    let tripNumber = null;
    let sequenceNo = null;
    let serviceAreaCode = null;

    if (matchedServiceAreaIds[0]) {
      const { data: seqData, error: seqError } = await supabase
        .rpc('generate_trip_number', { p_service_area_id: matchedServiceAreaIds[0] });
      
      if (!seqError && seqData && seqData.length > 0) {
        tripNumber = seqData[0].trip_number;
        sequenceNo = seqData[0].sequence_no;
        serviceAreaCode = seqData[0].service_area_code;
        console.log(`[dispatch-trip] Generated trip number: ${tripNumber}`);
      } else {
        console.warn('[dispatch-trip] Could not generate trip number:', seqError);
      }
    }

    // Update trip with service area and currency
    const tripUpdate: Record<string, any> = {
      currency: matchedRegion.currency_code,
      service_area_id: matchedServiceAreaIds[0]
    };
    if (tripNumber) {
      tripUpdate.trip_code = tripNumber;
      tripUpdate.service_area_code = serviceAreaCode;
      tripUpdate.sequence_no = sequenceNo;
    }
    await supabase.from('trips').update(tripUpdate).eq('id', trip_id);

    // ====== FETCH PRESET OFFER CONFIG ======
    let presetOfferConfig: Record<string, any> | null = null;
    let presetOffers: Record<string, any>[] = [];

    const { data: offerConfigData } = await supabase
      .from('preset_offer_configs')
      .select('*')
      .eq('service_area_id', matchedServiceAreaIds[0])
      .maybeSingle();

    if (offerConfigData && offerConfigData.is_enabled) {
      presetOfferConfig = {
        is_enabled: offerConfigData.is_enabled,
        price_mode: offerConfigData.price_mode,
        default_selected_offer_id: offerConfigData.default_selected_offer_id,
        countdown_enabled: offerConfigData.countdown_enabled,
        countdown_seconds: offerConfigData.countdown_seconds,
        countdown_auto_select: offerConfigData.countdown_auto_select,
        countdown_auto_select_offer_id: offerConfigData.countdown_auto_select_offer_id,
      };

      const { data: offersData } = await supabase
        .from('preset_offers')
        .select('offer_key, label, description, multiplier, fixed_amount_pence, icon, color, display_order, is_active')
        .eq('config_id', offerConfigData.id)
        .eq('is_active', true)
        .order('display_order');

      presetOffers = offersData || [];
    }

    // ====== DELEGATE TO dispatch-drivers (PostGIS Dispatch Scoring) ======
    // dispatch-drivers is the single source of truth for driver ranking,
    // radius expansion, wave dispatch, scoring, and first-accept-wins assignment.
    console.log(`[dispatch-trip] Delegating to dispatch-drivers (PostGIS scoring)`);

    const dispatchPayload = {
      trip_id,
      pickup_lat,
      pickup_lng,
      vehicle_type_id: vehicle_type_id || undefined,
      service_area_id: matchedServiceAreaIds[0],
    };

    const dispatchResponse = await fetch(
      `${supabaseUrl}/functions/v1/dispatch-drivers`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify(dispatchPayload),
      }
    );

    const dispatchResult = await dispatchResponse.json();

    console.log(`[dispatch-trip] dispatch-drivers result: dispatched=${dispatchResult?.data?.dispatched}`);

    // Log dispatch event
    await logAuditEvent(supabase, 'trip_dispatched', {
      tripId: trip_id,
      details: {
        trip_number: tripNumber,
        region: matchedRegion.name,
        service_area_id: matchedServiceAreaIds[0],
        dispatch_result: dispatchResult?.data?.dispatched ? 'dispatched' : 'no_drivers',
        offers_sent: dispatchResult?.data?.offers_sent || 0,
        candidates_scored: dispatchResult?.data?.candidates_scored || 0,
      },
      ipAddress: clientIP,
      userAgent,
    });

    // Return combined result with preset offers
    return successResponse({
      dispatched: dispatchResult?.data?.dispatched || false,
      trip_number: tripNumber,
      service_area_id: matchedServiceAreaIds[0],
      offers_sent: dispatchResult?.data?.offers_sent || 0,
      candidates_scored: dispatchResult?.data?.candidates_scored || 0,
      preset_offer_config: presetOfferConfig,
      preset_offers: presetOffers,
      message: dispatchResult?.data?.message || (dispatchResult?.data?.dispatched ? 'Dispatched' : 'No drivers available'),
      subtext: dispatchResult?.data?.subtext,
      top_candidates: dispatchResult?.data?.top_candidates,
    });

  } catch (error) {
    console.error('[dispatch-trip] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error',
      500
    );
  }
});
