import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ResolveZonesRequest {
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
}

interface ZoneResult {
  zone_id: string;
  zone_name: string;
  zone_type: string;
  priority: number;
  metadata: Record<string, any>;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: ResolveZonesRequest = await req.json();
    const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng } = body;

    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
      return new Response(
        JSON.stringify({ error: "Missing required coordinates" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 1: Determine region for pickup point
    const { data: regions, error: regionsError } = await supabase
      .from("regions")
      .select("id, name, currency_code, distance_unit, timezone, geo_boundary")
      .eq("status", "active");

    if (regionsError) throw regionsError;

    let selectedRegion: any = null;

    // Check which region contains the pickup point
    for (const region of regions || []) {
      const { data: containsPoint } = await supabase.rpc("point_in_polygon", {
        point_lat: pickup_lat,
        point_lng: pickup_lng,
        polygon_geojson: region.geo_boundary,
      });

      if (containsPoint) {
        selectedRegion = region;
        break;
      }
    }

    if (!selectedRegion) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Service not available in this area",
          region: null,
          pickup_zone: null,
          dropoff_zone: null,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 2: Resolve pickup zone (PRICING type, highest priority)
    const { data: pickupZones, error: pickupError } = await supabase.rpc("resolve_zone", {
      point_lat: pickup_lat,
      point_lng: pickup_lng,
      p_region_id: selectedRegion.id,
      p_zone_type: "PRICING",
    });

    if (pickupError) throw pickupError;

    const pickupZone: ZoneResult | null = pickupZones?.[0] || null;

    // Step 3: Resolve dropoff zone (PRICING type, highest priority)
    const { data: dropoffZones, error: dropoffError } = await supabase.rpc("resolve_zone", {
      point_lat: dropoff_lat,
      point_lng: dropoff_lng,
      p_region_id: selectedRegion.id,
      p_zone_type: "PRICING",
    });

    if (dropoffError) throw dropoffError;

    const dropoffZone: ZoneResult | null = dropoffZones?.[0] || null;

    // Step 4: Calculate pricing modifiers
    let pickupFee = 0;
    let dropoffFee = 0;
    let surgeMultiplier = 1;
    let minFareOverride = null;

    if (pickupZone?.metadata) {
      pickupFee = pickupZone.metadata.pickup_fee || 0;
      if (pickupZone.metadata.surge_multiplier) {
        surgeMultiplier = Math.max(surgeMultiplier, pickupZone.metadata.surge_multiplier);
      }
      if (pickupZone.metadata.min_fare_override) {
        minFareOverride = pickupZone.metadata.min_fare_override;
      }
    }

    if (dropoffZone?.metadata) {
      dropoffFee = dropoffZone.metadata.dropoff_fee || 0;
      if (dropoffZone.metadata.surge_multiplier && !pickupZone?.metadata?.surge_multiplier) {
        surgeMultiplier = Math.max(surgeMultiplier, dropoffZone.metadata.surge_multiplier);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        region: {
          id: selectedRegion.id,
          name: selectedRegion.name,
          currency_code: selectedRegion.currency_code,
          distance_unit: selectedRegion.distance_unit,
          timezone: selectedRegion.timezone,
        },
        pickup_zone: pickupZone
          ? {
              id: pickupZone.zone_id,
              name: pickupZone.zone_name,
              priority: pickupZone.priority,
              metadata: pickupZone.metadata,
            }
          : null,
        dropoff_zone: dropoffZone
          ? {
              id: dropoffZone.zone_id,
              name: dropoffZone.zone_name,
              priority: dropoffZone.priority,
              metadata: dropoffZone.metadata,
            }
          : null,
        pricing_modifiers: {
          pickup_fee: pickupFee,
          dropoff_fee: dropoffFee,
          surge_multiplier: surgeMultiplier,
          min_fare_override: minFareOverride,
          total_zone_fees: pickupFee + dropoffFee,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error resolving zones:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
