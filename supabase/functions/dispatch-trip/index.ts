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
  max_drivers?: number;
  offer_timeout_seconds?: number;
}

interface EligibleDriver {
  id: string;
  first_name: string;
  last_name: string;
  driver_code: string | null;
  current_lat: number;
  current_lng: number;
  rating: number | null;
  total_trips: number | null;
  distance_km: number;
  priority_score: number;
}

// Ray casting algorithm for point-in-polygon
function isPointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (!polygon || polygon.length < 3) return false;
  
  let inside = false;
  const x = point.lng, y = point.lat;
  
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  
  return inside;
}

// Haversine formula for distance calculation
function calculateDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Calculate priority score based on distance, rating, and activity
function calculatePriorityScore(driver: { 
  distance_km: number; 
  rating: number | null; 
  total_trips: number | null;
}): number {
  // Distance score (closer = higher, max 40 points)
  const distanceScore = Math.max(0, 40 - (driver.distance_km * 4));
  
  // Rating score (max 30 points)
  const ratingScore = (driver.rating || 4.0) * 6;
  
  // Activity score based on total trips (max 20 points)
  const activityScore = Math.min(20, (driver.total_trips || 0) / 10);
  
  // Availability bonus (10 points for being available)
  const availabilityBonus = 10;
  
  return distanceScore + ratingScore + activityScore + availabilityBonus;
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

    const body: DispatchRequest = await req.json();
    const { 
      trip_id, 
      pickup_lat, 
      pickup_lng, 
      vehicle_type_id,
      max_distance_km = 10,
      max_drivers = 5,
      offer_timeout_seconds = 30
    } = body;

    console.log(`[dispatch-trip] Starting broadcast dispatch for trip ${trip_id}`);
    console.log(`[dispatch-trip] Pickup: ${pickup_lat}, ${pickup_lng}`);
    console.log(`[dispatch-trip] Max drivers: ${max_drivers}, Max distance: ${max_distance_km}km, Timeout: ${offer_timeout_seconds}s`);

    // Validate required parameters
    if (!trip_id || !pickup_lat || !pickup_lng) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Trip ID and pickup coordinates are required'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }

    // Validate trip exists and is in valid state
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, status, pickup_latitude, pickup_longitude, service_area_id')
      .eq('id', trip_id)
      .single();

    if (tripError || !trip) {
      console.error(`[dispatch-trip] Trip not found: ${trip_id}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Trip not found'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 });
    }

    // Check if trip is already assigned or in terminal state
    const terminalStatuses = ['accepted', 'driver_arriving', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_drivers'];
    if (terminalStatuses.includes(trip.status)) {
      console.log(`[dispatch-trip] Trip ${trip_id} already in status: ${trip.status}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Trip already processed',
        status: trip.status
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }

    // Get active regions
    const { data: regions, error: regionsError } = await supabase
      .from('regions')
      .select('id, name, geo_boundary, currency_code')
      .eq('status', 'active');

    if (regionsError) {
      console.error('[dispatch-trip] Error fetching regions:', regionsError);
      throw regionsError;
    }

    // Find the region containing the pickup point
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
      
      await supabase
        .from('trips')
        .update({ status: 'no_service_area' })
        .eq('id', trip_id);

      return new Response(JSON.stringify({
        success: false,
        message: 'Service not available in this area',
        subtext: 'Your pickup location is outside our service regions.'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.log(`[dispatch-trip] Matched region: ${matchedRegion.name}`);

    // Get active service areas in this region
    const { data: serviceAreas, error: saError } = await supabase
      .from('service_areas')
      .select('id, name, geo_boundary')
      .eq('region_id', matchedRegion.id)
      .eq('is_active', true);

    if (saError) {
      console.error('[dispatch-trip] Error fetching service areas:', saError);
      throw saError;
    }

    // Find service areas containing the pickup point
    const matchedServiceAreaIds: string[] = [];
    for (const sa of serviceAreas || []) {
      if (sa.geo_boundary) {
        const boundary = Array.isArray(sa.geo_boundary) 
          ? sa.geo_boundary 
          : (sa.geo_boundary as any).coordinates || [];
        
        if (boundary.length === 0 || isPointInPolygon(pickupPoint, boundary)) {
          matchedServiceAreaIds.push(sa.id);
        }
      } else {
        // No boundary means entire region
        matchedServiceAreaIds.push(sa.id);
      }
    }

    console.log(`[dispatch-trip] Matched service areas: ${matchedServiceAreaIds.length}`);

    if (matchedServiceAreaIds.length === 0) {
      await supabase
        .from('trips')
        .update({ status: 'no_service_area' })
        .eq('id', trip_id);

      return new Response(JSON.stringify({
        success: false,
        message: 'Service not available in this area',
        subtext: 'Your pickup location is outside our service areas.'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get drivers assigned to these service areas
    const { data: driverServiceAreas, error: dsaError } = await supabase
      .from('driver_service_areas')
      .select('driver_id')
      .in('service_area_id', matchedServiceAreaIds);

    if (dsaError) {
      console.error('[dispatch-trip] Error fetching driver service areas:', dsaError);
      throw dsaError;
    }

    const driverIds = [...new Set(driverServiceAreas?.map(dsa => dsa.driver_id) || [])];
    console.log(`[dispatch-trip] Drivers in service areas: ${driverIds.length}`);

    if (driverIds.length === 0) {
      await supabase
        .from('trips')
        .update({ status: 'no_drivers' })
        .eq('id', trip_id);

      return new Response(JSON.stringify({
        success: false,
        message: 'No drivers available',
        subtext: 'No drivers are registered in this service area.'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get eligible drivers (online, approved, documents approved, has location, not busy)
    const { data: drivers, error: driversError } = await supabase
      .from('drivers')
      .select('id, first_name, last_name, driver_code, current_lat, current_lng, rating, total_trips, current_trip_id')
      .in('id', driverIds)
      .eq('is_online', true)
      .eq('approval_status', 'approved')
      .eq('documents_approved', true)
      .not('current_lat', 'is', null)
      .not('current_lng', 'is', null);

    if (driversError) {
      console.error('[dispatch-trip] Error fetching drivers:', driversError);
      throw driversError;
    }

    // Filter out busy drivers
    let availableDrivers = (drivers || []).filter(d => !d.current_trip_id);
    console.log(`[dispatch-trip] Available drivers (not busy): ${availableDrivers.length}`);

    // If vehicle type specified, filter by vehicle category
    if (vehicle_type_id) {
      const { data: vehicleCategories, error: vcError } = await supabase
        .from('driver_vehicle_categories')
        .select('driver_id')
        .eq('vehicle_type_id', vehicle_type_id)
        .eq('is_enabled', true)
        .in('driver_id', availableDrivers.map(d => d.id));

      if (vcError) {
        console.error('[dispatch-trip] Error fetching vehicle categories:', vcError);
        throw vcError;
      }

      const eligibleDriverIds = new Set(vehicleCategories?.map(vc => vc.driver_id) || []);
      availableDrivers = availableDrivers.filter(d => eligibleDriverIds.has(d.id));
      console.log(`[dispatch-trip] Drivers with matching vehicle type: ${availableDrivers.length}`);
    }

    // Check for existing pending offers for these drivers
    const { data: existingOffers, error: existingOffersError } = await supabase
      .from('trip_offers')
      .select('driver_id')
      .eq('status', 'offered')
      .in('driver_id', availableDrivers.map(d => d.id))
      .gt('expires_at', new Date().toISOString());

    if (!existingOffersError && existingOffers) {
      const busyDriverIds = new Set(existingOffers.map(o => o.driver_id));
      availableDrivers = availableDrivers.filter(d => !busyDriverIds.has(d.id));
      console.log(`[dispatch-trip] Drivers without pending offers: ${availableDrivers.length}`);
    }

    if (availableDrivers.length === 0) {
      await supabase
        .from('trips')
        .update({ status: 'no_drivers' })
        .eq('id', trip_id);

      return new Response(JSON.stringify({
        success: false,
        message: 'No drivers available right now',
        subtext: 'All drivers are currently busy. Please try again in a moment.'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Calculate distance and priority score for each driver
    const eligibleDrivers: EligibleDriver[] = availableDrivers.map(driver => {
      const distance_km = calculateDistanceKm(
        pickup_lat, pickup_lng,
        driver.current_lat!, driver.current_lng!
      );
      
      return {
        ...driver,
        distance_km,
        priority_score: calculatePriorityScore({
          distance_km,
          rating: driver.rating,
          total_trips: driver.total_trips
        })
      };
    });

    // Filter by max distance and sort by priority
    const nearbyDrivers = eligibleDrivers
      .filter(d => d.distance_km <= max_distance_km)
      .sort((a, b) => b.priority_score - a.priority_score)
      .slice(0, max_drivers);

    console.log(`[dispatch-trip] Nearby drivers within ${max_distance_km}km: ${nearbyDrivers.length}`);

    if (nearbyDrivers.length === 0) {
      await supabase
        .from('trips')
        .update({ status: 'no_drivers' })
        .eq('id', trip_id);

      return new Response(JSON.stringify({
        success: false,
        message: 'No drivers nearby',
        subtext: `No available drivers within ${max_distance_km}km of your pickup location.`
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Calculate offer expiry time
    const expiresAt = new Date(Date.now() + offer_timeout_seconds * 1000).toISOString();

    // Generate trip number atomically using service area
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

    // Create offers for selected drivers (BROADCAST)
    const offers = nearbyDrivers.map(driver => ({
      trip_id,
      driver_id: driver.id,
      status: 'offered',
      distance_km: driver.distance_km,
      priority_score: driver.priority_score,
      offered_at: new Date().toISOString(),
      expires_at: expiresAt
    }));

    const { data: createdOffers, error: offersError } = await supabase
      .from('trip_offers')
      .insert(offers)
      .select();

    if (offersError) {
      console.error('[dispatch-trip] Error creating offers:', offersError);
      throw offersError;
    }

    console.log(`[dispatch-trip] Created ${createdOffers?.length} offers for broadcast`);

    // Update trip status to 'offered' and set deadline with trip number
    const tripUpdate: Record<string, any> = {
      status: 'offered',
      confirm_deadline_at: expiresAt,
      currency: matchedRegion.currency_code,
      service_area_id: matchedServiceAreaIds[0]
    };

    if (tripNumber) {
      tripUpdate.trip_code = tripNumber;
      tripUpdate.service_area_code = serviceAreaCode;
      tripUpdate.sequence_no = sequenceNo;
    }

    const { error: tripUpdateError } = await supabase
      .from('trips')
      .update(tripUpdate)
      .eq('id', trip_id);

    if (tripUpdateError) {
      console.error('[dispatch-trip] Error updating trip:', tripUpdateError);
      throw tripUpdateError;
    }

    // Return success with broadcast info
    const response = {
      success: true,
      dispatched: true,
      broadcast: true,
      trip_number: tripNumber,
      offers_sent: nearbyDrivers.length,
      expires_at: expiresAt,
      timeout_seconds: offer_timeout_seconds,
      drivers: nearbyDrivers.map(d => ({
        id: d.id,
        name: `${d.first_name} ${d.last_name}`,
        driver_code: d.driver_code,
        distance_km: Math.round(d.distance_km * 10) / 10,
        priority_score: Math.round(d.priority_score * 10) / 10
      }))
    };

    console.log(`[dispatch-trip] Broadcast dispatch complete:`, response);

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[dispatch-trip] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
