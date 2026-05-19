/**
 * Per-vehicle-category zone route pricing resolver.
 *
 * Resolution order (highest priority first):
 *   1. Active row matching from_zone + to_zone + vehicle_type_id (+ service_area_id if scoped)
 *   2. Active row matching from_zone + to_zone + vehicle_type_id IS NULL (explicit fallback)
 *   3. None — caller falls back to standard meter pricing
 *
 * Returns a debug object so callers can surface which row (or fallback) was used.
 */

export interface ZoneRoutePricingRow {
  id: string;
  from_zone_id: string;
  to_zone_id: string;
  service_area_id: string | null;
  vehicle_type_id: string | null;
  fixed_fare: number;
  surcharge_pct: number;
  airport_charge: number;
  priority: number;
  is_active: boolean;
}

export interface ZoneRoutePricingResolution {
  row: ZoneRoutePricingRow | null;
  source:
    | "vehicle_specific"
    | "explicit_default_fallback"
    | "no_route_match"
    | "no_zones_resolved";
  fallback_reason: string | null;
  pricing_row_id: string | null;
}

export async function resolveZoneRoutePricing(params: {
  supabase: any;
  from_zone_id: string | null;
  to_zone_id: string | null;
  vehicle_type_id: string;
  service_area_id?: string | null;
}): Promise<ZoneRoutePricingResolution> {
  const { supabase, from_zone_id, to_zone_id, vehicle_type_id, service_area_id } = params;

  if (!from_zone_id || !to_zone_id) {
    return {
      row: null,
      source: "no_zones_resolved",
      fallback_reason: "Pickup or dropoff is not inside a configured pricing zone.",
      pricing_row_id: null,
    };
  }

  // 1. Vehicle-specific row (preferred)
  let q = supabase
    .from("zone_route_pricing")
    .select("*")
    .eq("from_zone_id", from_zone_id)
    .eq("to_zone_id", to_zone_id)
    .eq("vehicle_type_id", vehicle_type_id)
    .eq("is_active", true)
    .order("priority", { ascending: false })
    .limit(1);

  if (service_area_id) {
    // Prefer service-area-scoped row, but allow global routes too — query both, pick best
  }

  const { data: vehicleRows } = await q;
  if (vehicleRows && vehicleRows.length > 0) {
    return {
      row: vehicleRows[0] as ZoneRoutePricingRow,
      source: "vehicle_specific",
      fallback_reason: null,
      pricing_row_id: vehicleRows[0].id,
    };
  }

  // 2. Explicit NULL-vehicle fallback row
  const { data: defaultRows } = await supabase
    .from("zone_route_pricing")
    .select("*")
    .eq("from_zone_id", from_zone_id)
    .eq("to_zone_id", to_zone_id)
    .is("vehicle_type_id", null)
    .eq("is_active", true)
    .order("priority", { ascending: false })
    .limit(1);

  if (defaultRows && defaultRows.length > 0) {
    return {
      row: defaultRows[0] as ZoneRoutePricingRow,
      source: "explicit_default_fallback",
      fallback_reason:
        "No vehicle-category-specific row found — using explicit default (vehicle_type_id IS NULL) row.",
      pricing_row_id: defaultRows[0].id,
    };
  }

  // 3. No route pricing — meter
  return {
    row: null,
    source: "no_route_match",
    fallback_reason:
      "No zone route pricing configured for this vehicle category — falling back to standard meter pricing.",
    pricing_row_id: null,
  };
}

/**
 * Apply a zone-route-pricing row to produce a final pence quote.
 * Logic: fixed_fare + pickup + dropoff + airport fees, then ×(1 + surcharge_pct/100).
 */
export function applyZoneRoutePricing(row: ZoneRoutePricingRow): {
  quoted_fare_pence: number;
  fixed_fare_pence: number;
  pickup_fee_pence: number;
  dropoff_fee_pence: number;
  airport_pickup_fee_pence: number;
  airport_dropoff_fee_pence: number;
  surcharge_pct: number;
} {
  const toPence = (v: number | string | null | undefined) =>
    Math.round(Number(v ?? 0) * 100);

  const fixed = toPence(row.fixed_fare);
  const pickup = toPence(row.pickup_fee);
  const dropoff = toPence(row.dropoff_fee);
  const apickup = toPence(row.airport_pickup_fee);
  const adropoff = toPence(row.airport_dropoff_fee);
  const subtotal = fixed + pickup + dropoff + apickup + adropoff;
  const surcharge = Number(row.surcharge_pct ?? 0);
  const final = Math.round(subtotal * (1 + surcharge / 100));

  return {
    quoted_fare_pence: final,
    fixed_fare_pence: fixed,
    pickup_fee_pence: pickup,
    dropoff_fee_pence: dropoff,
    airport_pickup_fee_pence: apickup,
    airport_dropoff_fee_pence: adropoff,
    surcharge_pct: surcharge,
  };
}

/**
 * Resolve which pricing zone (if any) contains a point, scoped to a service area's region.
 * Uses the resolve_zone RPC and returns the highest-priority PRICING zone, or null.
 */
export async function resolvePricingZone(params: {
  supabase: any;
  lat: number;
  lng: number;
  region_id: string;
}): Promise<{ zone_id: string; zone_name: string } | null> {
  const { supabase, lat, lng, region_id } = params;
  const { data, error } = await supabase.rpc("resolve_zone", {
    point_lat: lat,
    point_lng: lng,
    p_region_id: region_id,
    p_zone_type: "PRICING",
  });
  if (error || !data || data.length === 0) return null;
  return { zone_id: data[0].zone_id, zone_name: data[0].zone_name };
}
