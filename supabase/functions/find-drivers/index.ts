import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface LatLng {
  lat: number;
  lng: number;
}

interface FindDriversRequest {
  pickup_lat: number;
  pickup_lng: number;
  vehicle_type_id?: string;
  max_distance_km?: number;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
  geo_boundary: LatLng[] | null;
}

interface Driver {
  id: string;
  first_name: string;
  last_name: string;
  driver_code: string | null;
  is_online: boolean;
  current_lat: number | null;
  current_lng: number | null;
  rating: number | null;
  region_id: string;
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

// Calculate distance between two points (Haversine formula)
function calculateDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
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

    const body: FindDriversRequest = await req.json();
    const { pickup_lat, pickup_lng, vehicle_type_id, max_distance_km = 10 } = body;

    console.log('Finding drivers for pickup:', { pickup_lat, pickup_lng, vehicle_type_id });

    if (!pickup_lat || !pickup_lng) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Pickup coordinates are required',
          drivers: [] 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const pickupPoint: LatLng = { lat: pickup_lat, lng: pickup_lng };

    // Step 1: Get all active service areas with geo_boundary
    const { data: serviceAreas, error: saError } = await supabase
      .from('service_areas')
      .select('id, name, region_id')
      .eq('is_active', true);

    if (saError) {
      console.error('Error fetching service areas:', saError);
      throw saError;
    }

    // Step 2: Get regions with geo_boundary to check if pickup is within region
    const { data: regions, error: regError } = await supabase
      .from('regions')
      .select('id, name, geo_boundary')
      .eq('status', 'active');

    if (regError) {
      console.error('Error fetching regions:', regError);
      throw regError;
    }

    // Find which region the pickup point is in
    let matchingRegion: { id: string; name: string } | null = null;
    for (const region of regions || []) {
      if (region.geo_boundary && isPointInPolygon(pickupPoint, region.geo_boundary as LatLng[])) {
        matchingRegion = { id: region.id, name: region.name };
        console.log('Pickup is in region:', region.name);
        break;
      }
    }

    if (!matchingRegion) {
      console.log('Pickup location is not within any active region');
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Pickup location is outside service coverage area',
          drivers: [],
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get service areas for this region
    const regionServiceAreas = (serviceAreas || []).filter(sa => sa.region_id === matchingRegion!.id);
    const serviceAreaIds = regionServiceAreas.map(sa => sa.id);

    if (serviceAreaIds.length === 0) {
      console.log('No service areas found for region:', matchingRegion.name);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'No service areas configured for this region',
          drivers: [],
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Service areas in region:', serviceAreaIds);

    // Step 3: Get drivers assigned to these service areas
    const { data: driverServiceAreas, error: dsaError } = await supabase
      .from('driver_service_areas')
      .select('driver_id, service_area_id')
      .in('service_area_id', serviceAreaIds);

    if (dsaError) {
      console.error('Error fetching driver service areas:', dsaError);
      throw dsaError;
    }

    const eligibleDriverIds = [...new Set((driverServiceAreas || []).map(dsa => dsa.driver_id))];

    if (eligibleDriverIds.length === 0) {
      console.log('No drivers assigned to service areas in this region');
      return new Response(
        JSON.stringify({
          success: false,
          error: 'No drivers assigned to this service area',
          drivers: [],
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 4: Get online drivers from the eligible list
    let driverQuery = supabase
      .from('drivers')
      .select('id, first_name, last_name, driver_code, is_online, current_lat, current_lng, rating, region_id')
      .eq('is_online', true)
      .eq('approval_status', 'approved')
      .in('id', eligibleDriverIds)
      .not('current_lat', 'is', null)
      .not('current_lng', 'is', null);

    const { data: drivers, error: driverError } = await driverQuery;

    if (driverError) {
      console.error('Error fetching drivers:', driverError);
      throw driverError;
    }

    console.log('Online drivers found:', drivers?.length || 0);

    if (!drivers || drivers.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'No online drivers available',
          drivers: [],
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 5: Filter by vehicle type if specified
    let filteredDriverIds = drivers.map(d => d.id);
    
    if (vehicle_type_id) {
      const { data: vehicleCategories, error: vcError } = await supabase
        .from('driver_vehicle_categories')
        .select('driver_id')
        .eq('vehicle_type_id', vehicle_type_id)
        .eq('is_enabled', true)
        .in('driver_id', filteredDriverIds);

      if (vcError) {
        console.error('Error fetching vehicle categories:', vcError);
      } else {
        filteredDriverIds = (vehicleCategories || []).map(vc => vc.driver_id);
        console.log('Drivers with matching vehicle type:', filteredDriverIds.length);
      }
    }

    // Step 6: Calculate distance and filter by max distance
    const eligibleDrivers = drivers
      .filter(d => filteredDriverIds.includes(d.id))
      .map(driver => {
        const distance = calculateDistanceKm(
          pickup_lat,
          pickup_lng,
          driver.current_lat!,
          driver.current_lng!
        );
        return {
          ...driver,
          distance_km: Math.round(distance * 10) / 10
        };
      })
      .filter(driver => driver.distance_km <= max_distance_km)
      .sort((a, b) => a.distance_km - b.distance_km);

    console.log('Eligible drivers after distance filter:', eligibleDrivers.length);

    if (eligibleDrivers.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'No drivers within range',
          drivers: [],
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        drivers: eligibleDrivers,
        service_area_ids: serviceAreaIds,
        region: matchingRegion
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in find-drivers:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
        drivers: [],
        message: 'No drivers available right now.',
        subtext: 'Please try again in a few minutes or adjust your pickup location.'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
