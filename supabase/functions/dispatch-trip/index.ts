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

interface DispatchRequest {
  trip_id: string;
  pickup_lat: number;
  pickup_lng: number;
  vehicle_type_id?: string;
  max_distance_km?: number;
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
  const R = 6371;
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: DispatchRequest = await req.json();
    const { trip_id, pickup_lat, pickup_lng, vehicle_type_id, max_distance_km = 10 } = body;

    console.log('Dispatching trip:', { trip_id, pickup_lat, pickup_lng });

    if (!trip_id || !pickup_lat || !pickup_lng) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Trip ID and pickup coordinates are required',
          dispatched: false
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const pickupPoint: LatLng = { lat: pickup_lat, lng: pickup_lng };

    // Get active regions with geo_boundary
    const { data: regions, error: regError } = await supabase
      .from('regions')
      .select('id, name, geo_boundary')
      .eq('status', 'active');

    if (regError) throw regError;

    // Find matching region for pickup
    let matchingRegion: { id: string; name: string } | null = null;
    for (const region of regions || []) {
      if (region.geo_boundary && isPointInPolygon(pickupPoint, region.geo_boundary as LatLng[])) {
        matchingRegion = { id: region.id, name: region.name };
        break;
      }
    }

    if (!matchingRegion) {
      // Update trip status to no_drivers
      await supabase
        .from('trips')
        .update({ status: 'no_drivers' })
        .eq('id', trip_id);

      console.log('Pickup outside service area, trip marked as no_drivers');
      return new Response(
        JSON.stringify({
          success: false,
          dispatched: false,
          error: 'Pickup location outside service area',
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get service areas for this region
    const { data: serviceAreas } = await supabase
      .from('service_areas')
      .select('id')
      .eq('region_id', matchingRegion.id)
      .eq('is_active', true);

    const serviceAreaIds = (serviceAreas || []).map(sa => sa.id);

    if (serviceAreaIds.length === 0) {
      await supabase
        .from('trips')
        .update({ status: 'no_drivers' })
        .eq('id', trip_id);

      return new Response(
        JSON.stringify({
          success: false,
          dispatched: false,
          error: 'No service areas in region',
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get drivers assigned to these service areas
    const { data: driverServiceAreas } = await supabase
      .from('driver_service_areas')
      .select('driver_id')
      .in('service_area_id', serviceAreaIds);

    const eligibleDriverIds = [...new Set((driverServiceAreas || []).map(dsa => dsa.driver_id))];

    if (eligibleDriverIds.length === 0) {
      await supabase
        .from('trips')
        .update({ status: 'no_drivers' })
        .eq('id', trip_id);

      console.log('No drivers assigned to service areas');
      return new Response(
        JSON.stringify({
          success: false,
          dispatched: false,
          error: 'No drivers assigned to this area',
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get online, approved drivers with location
    let driverQuery = supabase
      .from('drivers')
      .select('id, first_name, last_name, current_lat, current_lng, rating')
      .eq('is_online', true)
      .eq('approval_status', 'approved')
      .in('id', eligibleDriverIds)
      .not('current_lat', 'is', null)
      .not('current_lng', 'is', null);

    const { data: drivers } = await driverQuery;

    if (!drivers || drivers.length === 0) {
      await supabase
        .from('trips')
        .update({ status: 'no_drivers' })
        .eq('id', trip_id);

      console.log('No online drivers available');
      return new Response(
        JSON.stringify({
          success: false,
          dispatched: false,
          error: 'No online drivers available',
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Filter by vehicle type if specified
    let filteredDriverIds = drivers.map(d => d.id);
    
    if (vehicle_type_id) {
      const { data: vehicleCategories } = await supabase
        .from('driver_vehicle_categories')
        .select('driver_id')
        .eq('vehicle_type_id', vehicle_type_id)
        .eq('is_enabled', true)
        .in('driver_id', filteredDriverIds);

      if (vehicleCategories && vehicleCategories.length > 0) {
        filteredDriverIds = vehicleCategories.map(vc => vc.driver_id);
      }
    }

    // Calculate distances and find nearest driver
    const eligibleDrivers = drivers
      .filter(d => filteredDriverIds.includes(d.id))
      .map(driver => ({
        ...driver,
        distance_km: calculateDistanceKm(
          pickup_lat, pickup_lng,
          driver.current_lat!, driver.current_lng!
        )
      }))
      .filter(d => d.distance_km <= max_distance_km)
      .sort((a, b) => a.distance_km - b.distance_km);

    if (eligibleDrivers.length === 0) {
      await supabase
        .from('trips')
        .update({ status: 'no_drivers' })
        .eq('id', trip_id);

      console.log('No drivers within range');
      return new Response(
        JSON.stringify({
          success: false,
          dispatched: false,
          error: 'No drivers within range',
          message: 'No drivers available right now.',
          subtext: 'Please try again in a few minutes or adjust your pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Assign trip to nearest driver
    const selectedDriver = eligibleDrivers[0];
    
    const { error: updateError } = await supabase
      .from('trips')
      .update({ 
        driver_id: selectedDriver.id,
        status: 'offered',
        driver_location_lat: selectedDriver.current_lat,
        driver_location_lng: selectedDriver.current_lng
      })
      .eq('id', trip_id);

    if (updateError) {
      console.error('Error updating trip:', updateError);
      throw updateError;
    }

    console.log('Trip dispatched to driver:', selectedDriver.id);

    return new Response(
      JSON.stringify({
        success: true,
        dispatched: true,
        driver: {
          id: selectedDriver.id,
          name: `${selectedDriver.first_name} ${selectedDriver.last_name}`,
          distance_km: selectedDriver.distance_km,
          rating: selectedDriver.rating
        },
        eligible_drivers_count: eligibleDrivers.length
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in dispatch-trip:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({
        success: false,
        dispatched: false,
        error: errorMessage,
        message: 'No drivers available right now.',
        subtext: 'Please try again in a few minutes or adjust your pickup location.'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
