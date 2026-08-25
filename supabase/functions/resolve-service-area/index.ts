import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkOfferSchedule } from "../_shared/offerSchedule.ts";
import {
  classifyServiceAreaFinancialPairing,
  type ServiceAreaCommissionWalletConfig,
} from "../_shared/commissionWalletSSOT.ts";

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
  /** Authoritative financial model for the resolved service area. */
  financial_model: string | null;
  /** Authoritative customer payment policy (PLATFORM_PREPAID / DRIVER_COLLECTS_UPFRONT). */
  customer_payment_policy: string | null;
  /** Whether the payment configuration is valid and bookable. */
  booking_workflow: "platform_collected" | "driver_collected" | "unavailable";
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

    // Get service areas for this region — include financial model fields for payment routing
    const { data: serviceAreas, error: saError } = await supabase
      .from('service_areas')
      .select('id, name, geo_boundary, updated_at, financial_model, customer_payment_policy, commission_wallet_enabled')
      .eq('region_id', matchingRegion.id)
      .eq('is_active', true);

    if (saError) throw saError;

    // Find matching service area
    let primaryServiceArea: {
      id: string; name: string; updated_at: string;
      financial_model: string | null; customer_payment_policy: string | null;
      commission_wallet_enabled: boolean | null;
    } | null = null;
    for (const sa of serviceAreas || []) {
      if (sa.geo_boundary) {
        const boundary = Array.isArray(sa.geo_boundary) ? sa.geo_boundary : [];
        if (boundary.length >= 3 && isPointInPolygon(pickupPoint, boundary as LatLng[])) {
          primaryServiceArea = {
            id: sa.id, name: sa.name, updated_at: sa.updated_at,
            financial_model: sa.financial_model ?? null,
            customer_payment_policy: sa.customer_payment_policy ?? null,
            commission_wallet_enabled: sa.commission_wallet_enabled ?? null,
          };
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
        .from('service_area_vehicle_pricing')
        .select('vehicle_type_id, is_enabled')
        .eq('service_area_id', primaryServiceArea.id)
        .eq('is_enabled', true),

      // Fetch ALL fare configs for this service area (default + per-vehicle-type)
      supabase
        .from('fare_pricing_settings')
        .select('id, vehicle_type_id, pricing_mode, base_fare_pence, per_km_rate_pence, per_min_rate_pence, booking_fee_pence, minimum_fare_pence, free_waiting_minutes, waiting_per_minute_pence, extra_stop_flat_fee_pence, currency_code, distance_pricing_bands')
        .eq('service_area_id', primaryServiceArea.id),

      supabase
        .from('preset_offer_configs')
        .select('is_enabled, schedule_enabled, schedule_days, schedule_start_time, schedule_end_time')
        .eq('service_area_id', primaryServiceArea.id)
        .maybeSingle(),

      supabase
        .from('service_area_payment_methods')
        .select('card_enabled, wallet_enabled, apple_pay_enabled, google_pay_enabled')
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
        distancePricingBands: fc.distance_pricing_bands ?? [],
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

      vehicleTypes = (vtData || [])
      vehicleTypes = (vtData || [])
        .map((vt: any) => ({
          id: vt.id,
          name: vt.name,
          slug: vt.slug,
          description: vt.description,
          icon: vt.icon,
          capacity: vt.capacity,
          features: vt.features,
          displayOrder: vt.display_order ?? 0,
          // Attach vehicle-type-specific pricing or fall back to default
          farePricing: fareConfigMap.get(vt.id) || defaultFarePricing,
        }))
        .sort((a: any, b: any) => a.displayOrder - b.displayOrder);
    }

    // Build payment methods
    const pm = paymentRes.data;
    const paymentMethods = pm ? {
      card: pm.card_enabled ?? true,
      wallet: pm.wallet_enabled ?? false,
      applePay: pm.apple_pay_enabled ?? false,
      googlePay: pm.google_pay_enabled ?? false,
    } : { card: true, wallet: false, applePay: false, googlePay: false };

    // Check offer schedule
    const scheduleCheck = checkOfferSchedule(offerConfigRes.data as any, matchingRegion.timezone);

    // Classify financial model — fail closed on invalid/missing config
    const saConfig: ServiceAreaCommissionWalletConfig = {
      financial_model: primaryServiceArea.financial_model,
      commission_wallet_enabled: primaryServiceArea.commission_wallet_enabled,
      customer_payment_policy: primaryServiceArea.customer_payment_policy,
    };
    const saPairing = classifyServiceAreaFinancialPairing(saConfig);
    let booking_workflow: RegionSettings["booking_workflow"];
    if (!saPairing.ok) {
      booking_workflow = "unavailable";
    } else if (saPairing.financial_model === "PLATFORM_COLLECTED") {
      booking_workflow = "platform_collected";
    } else {
      booking_workflow = "driver_collected";
    }

    const settings: RegionSettings = {
      region_id: matchingRegion.id,
      region_name: matchingRegion.name,
      currency_code: matchingRegion.currency_code,
      distance_unit: matchingRegion.distance_unit,
      timezone: matchingRegion.timezone,
      service_area_id: primaryServiceArea.id,
      service_area_name: primaryServiceArea.name,
      financial_model: saPairing.ok ? saPairing.financial_model : null,
      customer_payment_policy: saPairing.ok ? saPairing.customer_payment_policy : null,
      booking_workflow,
    };

    console.log(
      'Resolved settings with', vehicleTypes.length, 'vehicle types,',
      fareConfigMap.size, 'fare configs, financial_model=', settings.financial_model,
      'booking_workflow=', booking_workflow,
    );

    return new Response(
      JSON.stringify({
        success: true,
        settings,
        vehicleTypes,
        // farePricing: DEPRECATED — use the `calculate-fare` Edge Function with the resolved
        // service_area_id for authoritative per-vehicle fares that include zones, surge,
        // airport charges, and dynamic pricing. farePricing is kept only as a lightweight
        // config hint for legacy callers; do NOT use it as the customer-facing price.
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
