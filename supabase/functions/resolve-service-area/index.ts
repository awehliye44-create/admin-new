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
        JSON.stringify({ success: false, error: 'Pickup coordinates are required', settings: null }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const pickupPoint: LatLng = { lat: pickup_lat, lng: pickup_lng };

    // Get all active regions
    const { data: regions, error: regError } = await supabase
      .from('regions')
      .select('id, name, geo_boundary, currency_code, distance_unit, timezone, updated_at')
      .eq('status', 'active');

    if (regError) throw regError;

    // Find matching region
    let matchingRegion: {
      id: string; name: string; currency_code: string;
      distance_unit: string; timezone: string; updated_at: string;
    } | null = null;

    for (const region of regions || []) {
      if (region.geo_boundary && isPointInPolygon(pickupPoint, region.geo_boundary as LatLng[])) {
        matchingRegion = {
          id: region.id, name: region.name,
          currency_code: region.currency_code, distance_unit: region.distance_unit,
          timezone: region.timezone, updated_at: region.updated_at,
        };
        break;
      }
    }

    if (!matchingRegion) {
      return new Response(
        JSON.stringify({
          success: false, error: 'Pickup location is outside service coverage area',
          settings: null, message: 'This location is not currently covered by our service.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get service areas for this region
    const { data: serviceAreas, error: saError } = await supabase
      .from('service_areas')
      .select('id, name, geo_boundary, updated_at')
      .eq('region_id', matchingRegion.id)
      .eq('is_active', true);

    if (saError) throw saError;

    // Find matching service area
    let primaryServiceArea: { id: string; name: string; updated_at: string } | null = null;
    for (const sa of serviceAreas || []) {
      if (sa.geo_boundary) {
        const boundary = Array.isArray(sa.geo_boundary) ? sa.geo_boundary : [];
        if (boundary.length >= 3 && isPointInPolygon(pickupPoint, boundary as LatLng[])) {
          primaryServiceArea = { id: sa.id, name: sa.name, updated_at: sa.updated_at };
          break;
        }
      }
    }

    if (!primaryServiceArea) {
      return new Response(
        JSON.stringify({
          success: false, error: 'Pickup location is not inside any active service area',
          settings: null, message: 'No valid service area polygon contains this pickup location.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch vehicle types, fare settings (all configs), offer config, and payment methods in parallel
    const [vehicleTypesRes, fareSettingsRes, offerConfigRes, paymentRes] = await Promise.all([
      supabase
        .from('service_area_vehicle_types')
        .select('vehicle_type_id, display_order, is_active')
        .eq('service_area_id', primaryServiceArea.id)
        .eq('is_active', true)
        .order('display_order'),

      // Fetch ALL fare configs for this service area (default + per-vehicle-type)
      supabase
        .from('fare_pricing_settings')
        .select('id, vehicle_type_id, pricing_mode, base_fare_pence, per_km_rate_pence, per_min_rate_pence, booking_fee_pence, minimum_fare_pence, free_waiting_minutes, waiting_per_minute_pence, extra_stop_flat_fee_pence, currency_code')
        .eq('service_area_id', primaryServiceArea.id),

      supabase
        .from('preset_offer_configs')
        .select('is_enabled, schedule_enabled, schedule_days, schedule_start_time, schedule_end_time')
        .eq('service_area_id', primaryServiceArea.id)
        .maybeSingle(),

      supabase
        .from('service_area_payment_methods')
        .select('cash_enabled, card_enabled, wallet_enabled, apple_pay_enabled, google_pay_enabled')
        .eq('service_area_id', primaryServiceArea.id)
        .maybeSingle(),
    ]);

    // Get vehicle type metadata for assigned types
    const assignedVtIds = (vehicleTypesRes.data || []).map((r: any) => r.vehicle_type_id);
    let vehicleTypes: any[] = [];

    // Build fare pricing map: vehicle_type_id -> config (null key = default)
    const fareConfigMap = new Map<string | null, any>();
    for (const fc of fareSettingsRes.data || []) {
      fareConfigMap.set(fc.vehicle_type_id, {
        fareEngineConfigId: fc.id,
        pricingMode: fc.pricing_mode,
        baseFarePence: fc.base_fare_pence,
        perKmRatePence: fc.per_km_rate_pence,
        perMinuteRatePence: fc.per_min_rate_pence,
        bookingFeePence: fc.booking_fee_pence,
        minimumFarePence: fc.minimum_fare_pence,
        freeWaitingMinutes: fc.free_waiting_minutes,
        waitingPerMinutePence: fc.waiting_per_minute_pence,
        extraStopFlatFeePence: fc.extra_stop_flat_fee_pence,
        currencyCode: fc.currency_code,
        fareLocked: fc.pricing_mode === 'fixed',
      });
    }

    const defaultFarePricing = fareConfigMap.get(null) || null;

    if (assignedVtIds.length > 0) {
      const { data: vtData, error: vtError } = await supabase
        .from('vehicle_types')
        .select('id, name, slug, description, icon, capacity, features, is_active')
        .in('id', assignedVtIds)
        .eq('is_active', true);
      if (vtError) console.log('vtData query error:', vtError);

      const orderMap = new Map((vehicleTypesRes.data || []).map((r: any) => [r.vehicle_type_id, r.display_order]));
      vehicleTypes = (vtData || [])
        .map((vt: any) => ({
          id: vt.id,
          name: vt.name,
          slug: vt.slug,
          description: vt.description,
          icon: vt.icon,
          capacity: vt.capacity,
          features: vt.features,
          displayOrder: orderMap.get(vt.id) ?? 0,
          // Attach vehicle-type-specific pricing or fall back to default
          farePricing: fareConfigMap.get(vt.id) || defaultFarePricing,
        }))
        .sort((a: any, b: any) => a.displayOrder - b.displayOrder);
    }

    // Build payment methods
    const pm = paymentRes.data;
    const paymentMethods = pm ? {
      cash: pm.cash_enabled ?? true,
      card: pm.card_enabled ?? true,
      wallet: pm.wallet_enabled ?? false,
      applePay: pm.apple_pay_enabled ?? false,
      googlePay: pm.google_pay_enabled ?? false,
    } : { cash: true, card: true, wallet: false, applePay: false, googlePay: false };

    // Check offer schedule
    const scheduleCheck = checkOfferSchedule(offerConfigRes.data as any, matchingRegion.timezone);

    const settings: RegionSettings = {
      region_id: matchingRegion.id,
      region_name: matchingRegion.name,
      currency_code: matchingRegion.currency_code,
      distance_unit: matchingRegion.distance_unit,
      timezone: matchingRegion.timezone,
      service_area_id: primaryServiceArea.id,
      service_area_name: primaryServiceArea.name,
    };

    console.log('Resolved settings with', vehicleTypes.length, 'vehicle types,', fareConfigMap.size, 'fare configs');

    return new Response(
      JSON.stringify({
        success: true,
        settings,
        vehicleTypes,
        farePricing: defaultFarePricing,
        paymentMethods,
        offersAllowedNow: scheduleCheck.offersAllowedNow,
        serviceAreaIds: primaryServiceArea ? [primaryServiceArea.id] : [],
        cacheKey: `${matchingRegion.id}_${primaryServiceArea.updated_at}`,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in resolve-service-area:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage, settings: null }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
