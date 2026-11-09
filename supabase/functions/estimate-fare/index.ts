import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getDirections } from "../_shared/googleMaps.ts";
import { resolvePricingZone } from "../_shared/zoneRoutePricing.ts";

/**
 * Website / legacy single-fare quote envelope.
 *
 * Fare math is delegated to `calculate-fare` (pricing-engine SSOT) — same path as
 * Customer app, WhatsApp, corporate, and Manual Trip. This function only:
 *   1) resolves route distance/duration
 *   2) proxies calculate-fare
 *   3) attaches commission / tip-chip envelope fields website clients still expect
 *
 * Do not reintroduce FareEngine / zoneRoutePricing local arithmetic here.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ZoneInfo {
  zone_id: string;
  zone_name: string;
  is_airport: boolean;
}

async function resolveZoneWithType(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  lat: number,
  lng: number,
  region_id: string,
): Promise<ZoneInfo | null> {
  const z = await resolvePricingZone({ supabase, lat, lng, region_id });
  if (!z) return null;
  const { data } = await supabase
    .from("custom_zones")
    .select("zone_type")
    .eq("id", z.zone_id)
    .maybeSingle();
  const zoneType = (data as { zone_type?: string } | null)?.zone_type ?? "";
  const is_airport = zoneType.toLowerCase().trim() === "airport";
  return { ...z, is_airport };
}

interface ChipPreset {
  id: string;
  label: string;
  value: number;
}

interface OfferSettings {
  enabled?: boolean;
  presetType?: "FLAT" | "PERCENT";
  presets?: ChipPreset[];
}

function computeChipsPence(
  totalFarePence: number,
  offerSettings: OfferSettings | null,
): { id: string; label: string; amountPence: number }[] {
  if (!offerSettings?.enabled || !offerSettings.presets?.length) return [];
  const type = offerSettings.presetType ?? "PERCENT";
  return offerSettings.presets.map((p) => {
    let amountPence: number;
    if (type === "FLAT") {
      amountPence = totalFarePence + Math.round((p.value ?? 0) * 100);
    } else {
      const pct = Number(p.value ?? 0) / 100;
      amountPence = Math.round(totalFarePence * (1 + pct));
    }
    return { id: p.id, label: p.label, amountPence };
  });
}

function computeDriverKeep(
  baseFarePence: number,
  airportChargePence: number,
  commissionPct: number,
): { driverKeepPence: number; commissionPence: number } {
  const commissionPence = Math.round(
    (baseFarePence * Math.max(0, commissionPct)) / 100,
  );
  const driverKeepPence = (baseFarePence - commissionPence) + airportChargePence;
  return { driverKeepPence, commissionPence };
}

function moneyLinesToPence(
  lines: Array<{ label?: string; amount?: number }> | null | undefined,
  airportChargePence: number,
): { label: string; amountPence: number }[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    return airportChargePence > 0
      ? [
        { label: "Fare", amountPence: 0 },
        { label: "Airport charge", amountPence: airportChargePence },
      ]
      : [{ label: "Fare", amountPence: 0 }];
  }
  return lines.map((line) => ({
    label: String(line.label ?? "Fare"),
    amountPence: Math.round(Number(line.amount ?? 0) * 100),
  }));
}

type CalculateFareVehicleRow = {
  vehicleTypeId?: string;
  name?: string;
  slug?: string;
  description?: string;
  icon?: string;
  capacity?: number | null;
  displayOrder?: number;
  hasFareConfig?: boolean;
  fare?: Record<string, unknown> | null;
  breakdown?: Record<string, unknown> | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const {
      service_area_id,
      vehicle_type_id,
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
      waypoints,
      estimated_distance_km: client_distance_km,
      estimated_duration_min: client_duration_min,
    } = body;

    let estimated_distance_km = client_distance_km;
    let estimated_duration_min = client_duration_min;
    let directions_polyline: string | null = null;

    if (
      pickup_lat != null && pickup_lng != null &&
      dropoff_lat != null && dropoff_lng != null
    ) {
      try {
        const directions = await getDirections(
          pickup_lat, pickup_lng,
          dropoff_lat, dropoff_lng,
          waypoints,
        );
        estimated_distance_km = directions.distance_km;
        estimated_duration_min = directions.duration_min;
        directions_polyline = directions.polyline;
      } catch (dirErr) {
        console.warn("[estimate-fare] Directions API failed:", dirErr);
        if (estimated_distance_km == null || estimated_duration_min == null) {
          return new Response(
            JSON.stringify({ error: "Could not calculate route." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
    }

    if (!service_area_id || estimated_distance_km == null || estimated_duration_min == null) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: saData } = await supabase
      .from("service_areas")
      .select("region_id, region:regions(currency_code, distance_unit)")
      .eq("id", service_area_id)
      .single();

    const regionCurrency = (saData?.region as { currency_code?: string } | null)?.currency_code;
    const regionId = saData?.region_id ?? null;

    if (!regionCurrency) {
      return new Response(
        JSON.stringify({
          error: "REGION_CURRENCY_UNRESOLVABLE",
          error_code: "REGION_CURRENCY_UNRESOLVABLE",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let pickupZone: ZoneInfo | null = null;
    let dropoffZone: ZoneInfo | null = null;
    if (
      regionId &&
      pickup_lat != null && pickup_lng != null &&
      dropoff_lat != null && dropoff_lng != null
    ) {
      [pickupZone, dropoffZone] = await Promise.all([
        resolveZoneWithType(supabase, pickup_lat, pickup_lng, regionId),
        resolveZoneWithType(supabase, dropoff_lat, dropoff_lng, regionId),
      ]);
    }
    const isAirportTrip =
      (pickupZone?.is_airport === true) || (dropoffZone?.is_airport === true);

    // Proxy the live booking SSOT (pricing-engine + zone_pricing_rules + fixed routes).
    const calculateFareUrl = `${supabaseUrl}/functions/v1/calculate-fare`;
    const fareRes = await fetch(calculateFareUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        service_area_id,
        vehicle_type_id: vehicle_type_id || undefined,
        estimated_distance_km,
        estimated_duration_min,
        pickup: pickup_lat != null && pickup_lng != null
          ? { lat: pickup_lat, lng: pickup_lng }
          : undefined,
        dropoff: dropoff_lat != null && dropoff_lng != null
          ? { lat: dropoff_lat, lng: dropoff_lng }
          : undefined,
        stops: Array.isArray(waypoints) ? waypoints : [],
        source: "estimate-fare",
      }),
    });
    const farePayload = await fareRes.json().catch(() => ({}));
    if (!fareRes.ok || farePayload?.success === false) {
      console.error("[estimate-fare] calculate-fare failed:", farePayload);
      return new Response(
        JSON.stringify({
          error: farePayload?.error || "Fare calculation failed",
          code: "CALCULATE_FARE_FAILED",
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const currencyCode =
      (typeof farePayload.currencyCode === "string" && farePayload.currencyCode) ||
      regionCurrency;
    const vehicleFares = (Array.isArray(farePayload.vehicleFares)
      ? farePayload.vehicleFares
      : []) as CalculateFareVehicleRow[];

    const vtIds = vehicleFares
      .map((row) => row.vehicleTypeId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const { data: savRows } = vtIds.length > 0
      ? await supabase
        .from("service_area_vehicle_pricing")
        .select("vehicle_type_id, commission_percentage, offer_settings, airport_charge_pence")
        .eq("service_area_id", service_area_id)
        .eq("is_enabled", true)
        .in("vehicle_type_id", vtIds)
      : { data: [] as Array<Record<string, unknown>> };

    const savByVt = new Map(
      (savRows || []).map((r: Record<string, unknown>) => [r.vehicle_type_id as string, r]),
    );

    const mapVehicle = (row: CalculateFareVehicleRow) => {
      const vtId = row.vehicleTypeId as string;
      const fare = (row.fare ?? {}) as Record<string, unknown>;
      const breakdown = (row.breakdown ?? {}) as Record<string, unknown>;
      const totalFarePence = Math.round(Number(fare.totalFarePence ?? 0));
      const airportChargePence = Math.round(Number(fare.airportCharge ?? 0) * 100);
      const tripFarePence = Math.round(Number(fare.tripFare ?? 0) * 100);
      const baseFarePence = Math.max(0, totalFarePence - airportChargePence);
      const surgeQuote = fare.surge_quote ?? null;
      const appliedSurgeMultiplier = Number(fare.appliedSurgeMultiplier ?? 1) || 1;
      const surgeAmountPence = Math.round(
        Number((surgeQuote as { surge_amount_pence?: number } | null)?.surge_amount_pence ?? 0),
      );
      const baseFareBeforeSurgePence = Math.max(0, baseFarePence - surgeAmountPence);
      const pricingMode =
        String(fare.tripPricingMode ?? breakdown.pricing_mode ?? "NORMAL_DISTANCE_TIME") ===
            "ROUTE_PRICING"
          ? "ROUTE_PRICING"
          : "NORMAL_DISTANCE_TIME";
      const sav = savByVt.get(vtId) as {
        commission_percentage?: number;
        offer_settings?: OfferSettings | null;
      } | undefined;
      const commissionPct = Number(sav?.commission_percentage ?? 0);
      const { driverKeepPence, commissionPence } = computeDriverKeep(
        baseFarePence,
        airportChargePence,
        commissionPct,
      );
      const chips = computeChipsPence(
        totalFarePence,
        (sav?.offer_settings as OfferSettings | null) ?? null,
      );
      const fareDetails = moneyLinesToPence(
        fare.fareDetails as Array<{ label?: string; amount?: number }> | undefined,
        airportChargePence,
      );

      return {
        vehicleTypeId: vtId,
        vehicleTypeName: row.name || "Vehicle",
        vehicleSlug: row.slug,
        vehicleIcon: row.icon,
        vehicleCapacity: row.capacity ?? null,
        vehicleDescription: row.description || null,
        vehicleFeatures: null,
        displayOrder: row.displayOrder ?? 0,
        pricingMode,
        currencyCode,
        baseFarePence,
        airportChargePence,
        totalFarePence,
        driverKeepPence,
        commissionPence,
        driverTierCommissionPercent: commissionPct,
        chips,
        fareDetails,
        quotedFarePence: totalFarePence,
        finalTotalPence: totalFarePence,
        fareEngineConfigId: null,
        fareLocked: pricingMode === "ROUTE_PRICING",
        zoneDebug: {
          pickup_zone: pickupZone,
          dropoff_zone: dropoffZone,
          is_airport_trip: isAirportTrip,
          route_pricing_row_id: breakdown.matched_route_id ?? fare.matchedRouteId ?? null,
          route_pricing_source: pricingMode === "ROUTE_PRICING" ? "zone_route_pricing" : "meter",
          demand_zone_id: (surgeQuote as { zone_id?: string } | null)?.zone_id ?? null,
          demand_surge_reason: null,
          zone_flat_addition: fare.surcharge ?? breakdown.surcharge ?? 0,
          source: "calculate-fare",
        },
        surgeQuote,
        appliedSurgeMultiplier,
        surgeAmountPence,
        demandLevel: (surgeQuote as { confirmed_demand_level?: string } | null)
          ?.confirmed_demand_level ?? null,
        fareSnapshotJson: {
          config_id: null,
          pricing_mode: pricingMode,
          base_fare_pence: baseFarePence,
          base_fare_before_surge_pence: baseFareBeforeSurgePence,
          surge_amount_pence: surgeAmountPence,
          surge_multiplier: appliedSurgeMultiplier,
          surge_quote: surgeQuote,
          airport_charge_pence: airportChargePence,
          total_fare_pence: totalFarePence,
          trip_fare_pence: tripFarePence,
          zone_surcharge: fare.surcharge ?? breakdown.surcharge ?? 0,
          commission_pct: commissionPct,
          currency_code: currencyCode,
          source: "calculate-fare",
          snapshot_at: new Date().toISOString(),
        },
        freeWaitingMinutes: null,
        waitingPerMinutePence: null,
        extraStopFlatFeePence: null,
      };
    };

    const vehicles = vehicleFares
      .filter((row) => row.vehicleTypeId && row.hasFareConfig !== false && row.fare)
      .map(mapVehicle)
      .sort((a, b) => a.displayOrder - b.displayOrder);

    // BATCH MODE (website Choose Ride style)
    if (!vehicle_type_id) {
      return new Response(
        JSON.stringify({
          estimatedDistanceKm: estimated_distance_km,
          estimatedDurationMin: estimated_duration_min,
          currencyCode,
          vehicles,
          zoneContext: {
            pickup_zone: pickupZone,
            dropoff_zone: dropoffZone,
            is_airport_trip: isAirportTrip,
          },
          source: "calculate-fare",
          ...(directions_polyline ? { routePolyline: directions_polyline } : {}),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // SINGLE VEHICLE MODE
    const single =
      vehicles.find((v) => v.vehicleTypeId === vehicle_type_id) ?? vehicles[0];
    if (!single) {
      return new Response(
        JSON.stringify({
          error: "Vehicle type is not available in this service area",
          code: "VEHICLE_TYPE_NOT_AVAILABLE",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        ...single,
        estimatedDistanceKm: estimated_distance_km,
        estimatedDurationMin: estimated_duration_min,
        source: "calculate-fare",
        ...(directions_polyline ? { routePolyline: directions_polyline } : {}),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("estimate-fare error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
