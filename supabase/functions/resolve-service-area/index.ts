import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkOfferSchedule } from "../_shared/offerSchedule.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface LatLng {
  lat: number;
  lng: number;
}

interface ResolveRequest {
  pickup_lat: number;
  pickup_lng: number;
}

interface RegionSettings {
  region_id: string;
  region_name: string;
  currency_code: string;
  distance_unit: string;
  timezone: string;
  service_area_id: string | null;
  service_area_name: string | null;
}

// Point-in-polygon algorithm (Ray casting)
function isPointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (!polygon || polygon.length < 3) return false;
  
  let inside = false;
  const x = point.lng;
  const y = point.lat;
  
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
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

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: ResolveRequest = await req.json();
    const { pickup_lat, pickup_lng } = body;

    console.log('Resolving service area for:', { pickup_lat, pickup_lng });

    if (!pickup_lat || !pickup_lng) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Pickup coordinates are required',
          settings: null
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const pickupPoint: LatLng = { lat: pickup_lat, lng: pickup_lng };

    // Get all active regions with their settings
    const { data: regions, error: regError } = await supabase
      .from('regions')
      .select('id, name, geo_boundary, currency_code, distance_unit, timezone, updated_at')
      .eq('status', 'active');

    if (regError) {
      console.error('Error fetching regions:', regError);
      throw regError;
    }

    // Find which region the pickup point is in
    let matchingRegion: {
      id: string;
      name: string;
      currency_code: string;
      distance_unit: string;
      timezone: string;
      updated_at: string;
    } | null = null;

    for (const region of regions || []) {
      if (region.geo_boundary && isPointInPolygon(pickupPoint, region.geo_boundary as LatLng[])) {
        matchingRegion = {
          id: region.id,
          name: region.name,
          currency_code: region.currency_code,
          distance_unit: region.distance_unit,
          timezone: region.timezone,
          updated_at: region.updated_at,
        };
        console.log('Pickup is in region:', region.name, 'Currency:', region.currency_code, 'Unit:', region.distance_unit);
        break;
      }
    }

    if (!matchingRegion) {
      console.log('Pickup location is not within any active region');
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Pickup location is outside service coverage area',
          settings: null,
          message: 'This location is not currently covered by our service.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get service areas for this region WITH polygon boundaries
    const { data: serviceAreas, error: saError } = await supabase
      .from('service_areas')
      .select('id, name, geo_boundary, updated_at')
      .eq('region_id', matchingRegion.id)
      .eq('is_active', true);

    if (saError) {
      console.error('Error fetching service areas:', saError);
      throw saError;
    }

    // Find the service area whose polygon contains the pickup point
    let primaryServiceArea: { id: string; name: string; updated_at: string } | null = null;
    for (const sa of serviceAreas || []) {
      if (sa.geo_boundary) {
        const boundary = Array.isArray(sa.geo_boundary) ? sa.geo_boundary : [];
        if (boundary.length >= 3 && isPointInPolygon(pickupPoint, boundary as LatLng[])) {
          primaryServiceArea = { id: sa.id, name: sa.name, updated_at: sa.updated_at };
          console.log('Pickup is in service area:', sa.name);
          break;
        }
      }
    }

    if (!primaryServiceArea) {
      console.log('Pickup location is not inside any service area polygon');
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Pickup location is not inside any active service area',
          settings: null,
          message: 'No valid service area polygon contains this pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check offer schedule for primary service area
    let offersAllowedNow = false;
    if (primaryServiceArea) {
      const { data: offerConfig } = await supabase
        .from('preset_offer_configs')
        .select('is_enabled, schedule_enabled, schedule_days, schedule_start_time, schedule_end_time')
        .eq('service_area_id', primaryServiceArea.id)
        .maybeSingle();

      const scheduleCheck = checkOfferSchedule(offerConfig as any, matchingRegion.timezone);
      offersAllowedNow = scheduleCheck.offersAllowedNow;
    }

    const settings: RegionSettings = {
      region_id: matchingRegion.id,
      region_name: matchingRegion.name,
      currency_code: matchingRegion.currency_code,
      distance_unit: matchingRegion.distance_unit,
      timezone: matchingRegion.timezone,
      service_area_id: primaryServiceArea?.id || null,
      service_area_name: primaryServiceArea?.name || null,
    };

    console.log('Resolved settings:', settings);

    return new Response(
      JSON.stringify({
        success: true,
        settings,
        offers_allowed_now: offersAllowedNow,
        service_area_ids: primaryServiceArea ? [primaryServiceArea.id] : [],
        cache_key: `${matchingRegion.id}_${matchingRegion.updated_at}`,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in resolve-service-area:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
        settings: null
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
