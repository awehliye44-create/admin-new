// ─────────────────────────────────────────────────────────────────────────────
// Central Pricing Engine — single source of truth for ALL fare calculations.
//
// Used by: calculate-fare (estimate per vehicle), estimate-fare (single fare),
//          finalize-trip-and-capture (final charge).
//
// Calculation order:
//   STEP 1  Detect pickup/dropoff zones (highest priority wins)
//   STEP 2  Apply zone-route overrides (fixed fare + airport surcharge)
//   STEP 3  Apply base distance + time pricing (skipped if fixed fare)
//   STEP 4  Waiting / cancellation hooks (consumed by lifecycle endpoints)
//   STEP 5  Apply offers (only on the ride fare, not on fees)
// ─────────────────────────────────────────────────────────────────────────────

export type LatLng = { lat: number; lng: number };

export type ZoneRow = {
  id: string;
  name: string;
  shape_type: string | null;
  zone_type?: string | null;
  metadata?: unknown;
  priority: number | null;
  center_lat: number | null;
  center_lng: number | null;
  radius_meters: number | null;
  geo_boundary: unknown;
};

export type FareDetailLine = {
  label: string;
  amount: number;
};

/** Columns that exist on production `zone_route_pricing` (no pickup_fee/dropoff_fee). */
export const ZONE_ROUTE_PRICING_SELECT =
  "id, from_zone_id, to_zone_id, vehicle_type_id, fixed_fare, airport_pickup_fee, airport_dropoff_fee, airport_charge, priority, is_active, service_area_id";

export type ZoneRoutePricingRow = {
  id: string;
  from_zone_id: string;
  to_zone_id: string;
  vehicle_type_id: string | null;
  fixed_fare: number | null;             // money units (e.g. £)
  airport_pickup_fee?: number | null;    // surcharge when pickup is route from_zone
  airport_dropoff_fee?: number | null;   // surcharge when dropoff is route to_zone
  airport_charge?: number | null;        // legacy single surcharge column
  priority: number | null;
  is_active: boolean;
  service_area_id?: string | null;
};

export type DistanceBand = {
  /** From distance in the region's distance unit (km or mile). */
  from: number;
  /** Exclusive upper bound; null = and above. */
  to: number | null;
  /** Rate per unit in minor currency (pence/cents). */
  rate_pence: number;
};

export type FarePricingRow = Record<string, unknown> & {
  pricing_mode?: string | null;
  base_fare_pence?: number | null;
  per_km_rate_pence?: number | null;
  per_min_rate_pence?: number | null;
  booking_fee_pence?: number | null;
  minimum_fare_pence?: number | null;
  /** Tiered distance pricing from admin `fare_pricing_settings.distance_pricing_bands`. */
  distance_pricing_bands?: DistanceBand[] | null;
  enable_surge?: boolean | null;
  surge_multiplier_default?: number | null;
  peak_hour_multiplier?: number | null;
  zone_multiplier?: number | null;
  traffic_multiplier?: number | null;
  demand_supply_multiplier?: number | null;
};

export type DistanceBandUsage = {
  from_distance: number;
  to_distance: number | null;
  distance_used: number;
  rate_per_unit_pence: number;
  charge_pence: number;
  unit: "mi" | "km";
};

export type DistancePricingMode = "flat" | "bands";

/** Exclusive selector that the UI must branch on. Mixing breakdowns is a bug. */
export type FareSource = "route_fixed" | "standard_fixed" | "standard_dynamic";

/** How the trip fare was calculated — distinct from fare_pricing_settings pricing_mode (fixed/dynamic). */
export type TripPricingMode = "ROUTE_PRICING" | "NORMAL_DISTANCE_TIME";

export interface FareBreakdown {
  base_fare: number;            // money units
  zone_applied: string | null;  // "<from> → <to>" when a zone route hit
  pickup_zone: string | null;
  dropoff_zone: string | null;
  pickup_zone_id: string | null;
  dropoff_zone_id: string | null;
  /** Ride / route fare only (excludes airport surcharges). */
  trip_fare: number;
  /** Airport surcharge from admin pricing (0 when not configured). */
  airport_charge: number;
  airport_charge_source: AirportChargeSource;
  airport_pickup_fee: number;
  airport_dropoff_fee: number;
  /** Canonical lines for apps — built once from the same numbers as final_fare. */
  fare_details: FareDetailLine[];
  surcharge: number;            // reserved (currently 0; populated by future zone surcharge rules)
  distance_cost: number;
  time_cost: number;
  /**
   * Per-distance rate after multiplier, in money units **per region distance unit**
   * (km or mile, depending on the region). The UI must label this with the same
   * unit returned by the edge function (`distanceUnit`) and must NOT convert it.
   */
  per_km_rate: number;
  /** Per-minute rate after multiplier, in money units. */
  per_min_rate: number;
  booking_fee: number;
  minimum_fare: number;
  multiplier: number;
  fixed_fare_applied: boolean;
  /** Authoritative source the UI must render. */
  fare_source: FareSource;
  /** ROUTE_PRICING when a zone_route_pricing row with fixed_fare applies; else distance+time. */
  pricing_mode: TripPricingMode;
  /** flat = per_km_rate_pence; bands = distance_pricing_bands from admin. */
  distance_pricing_mode: DistancePricingMode;
  /** Human-readable band summary for UI when distance_pricing_mode is bands. */
  distance_band_summary: string | null;
  /** Used Admin bands for this trip — spans and charges from the engine, not the client. */
  distance_bands: DistanceBandUsage[];
  /** Ride subtotal before minimum fare floor (money units). */
  subtotal_before_minimum: number;
  /** True when minimum_fare raised the trip fare above subtotal. */
  minimum_applied: boolean;
  /** True only when an active zone_route_pricing row matches from→to with fixed_fare > 0. */
  route_match: boolean;
  /** id of zone_route_pricing row used, if any. */
  matched_route_id: string | null;
  final_fare: number;           // money units (ALWAYS authoritative)
  final_fare_pence: number;
}

/** Calculated ride fare (pence) used as preset-negotiation base — final visible fare, not route trip component alone. */
export function negotiationBaseFarePenceFromBreakdown(
  breakdown: Pick<FareBreakdown, "trip_fare" | "airport_charge" | "final_fare" | "pricing_mode">,
): number {
  const finalFare = Number(breakdown.final_fare);
  if (Number.isFinite(finalFare) && finalFare > 0) {
    return Math.round(finalFare * 100);
  }
  const tripFare = Number(breakdown.trip_fare);
  const airport = Number(breakdown.airport_charge) || 0;
  if (breakdown.pricing_mode === "ROUTE_PRICING" && Number.isFinite(tripFare) && tripFare > 0) {
    return Math.round((tripFare + airport) * 100);
  }
  if (Number.isFinite(tripFare) && tripFare > 0) {
    return Math.round(tripFare * 100);
  }
  return 0;
}

// ── Geometry ────────────────────────────────────────────────────────────────

function pointInRing(lat: number, lng: number, ring: number[][]): boolean {
  // ray-casting; ring entries are [lng, lat]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: LatLng, geo: unknown): boolean {
  if (!geo || typeof geo !== "object") return false;
  const g = geo as Record<string, unknown>;
  const type = String(g.type || "").toLowerCase();
  const coords = g.coordinates as unknown;
  if (!Array.isArray(coords)) return false;

  if (type === "polygon") {
    const rings = coords as number[][][];
    if (rings.length === 0 || !Array.isArray(rings[0])) return false;
    if (!pointInRing(point.lat, point.lng, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(point.lat, point.lng, rings[i])) return false; // hole
    }
    return true;
  }
  if (type === "multipolygon") {
    for (const poly of coords as number[][][][]) {
      if (poly.length === 0) continue;
      if (pointInPolygon(point, { type: "Polygon", coordinates: poly })) return true;
    }
  }
  return false;
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function zoneContainsPoint(point: LatLng, z: ZoneRow): boolean {
  const shape = (z.shape_type || "polygon").toLowerCase();
  if (shape === "circle") {
    if (z.center_lat == null || z.center_lng == null || !z.radius_meters) return false;
    const d = haversineMeters(point, { lat: z.center_lat, lng: z.center_lng });
    return d <= z.radius_meters;
  }
  return pointInPolygon(point, z.geo_boundary);
}

/** All active zones containing `point`, highest priority first. */
export function zonesContainingPoint(point: LatLng | null, zones: ZoneRow[]): ZoneRow[] {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return [];
  const matches = zones.filter((z) => zoneContainsPoint(point, z));
  matches.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return matches;
}

/** Returns the highest-priority active zone containing `point`, or null. */
export function detectZone(point: LatLng | null, zones: ZoneRow[]): ZoneRow | null {
  const matches = zonesContainingPoint(point, zones);
  return matches.length > 0 ? matches[0] : null;
}

const AIRPORT_ZONE_NAME =
  /\b(airport|heathrow|gatwick|stansted|luton|city\s*airport|lhr|lgw|stn|ltn)\b/i;

/** True when admin marked the zone as an airport (zone_type, metadata, or name). */
export function isAirportZone(zone: ZoneRow | null): boolean {
  if (!zone) return false;
  const zoneType = String(zone.zone_type ?? "").toLowerCase();
  if (zoneType === "airport") return true;
  const name = String(zone.name ?? "").trim();
  if (name && AIRPORT_ZONE_NAME.test(name)) return true;
  if (zone.metadata && typeof zone.metadata === "object") {
    const meta = zone.metadata as Record<string, unknown>;
    if (meta.is_airport === true || meta.isAirport === true) return true;
  }
  return false;
}

/** Optional per-zone airport fee from admin metadata (money units). */
export function getZoneAirportFee(zone: ZoneRow | null): number {
  if (!zone?.metadata || typeof zone.metadata !== "object") return 0;
  const meta = zone.metadata as Record<string, unknown>;
  const raw = meta.airport_fee ?? meta.airportFee ?? meta.airport_charge ?? meta.airportCharge;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function positiveMoney(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function routeEndpointAirportPickupFee(
  route: ZoneRoutePricingRow | null,
  pickupZone: ZoneRow | null,
): number {
  if (!route || !pickupZone || pickupZone.id !== route.from_zone_id) return 0;
  return positiveMoney(route.airport_pickup_fee);
}

function routeEndpointAirportDropoffFee(
  route: ZoneRoutePricingRow | null,
  dropoffZone: ZoneRow | null,
): number {
  if (!route || !dropoffZone || dropoffZone.id !== route.to_zone_id) return 0;
  return positiveMoney(route.airport_dropoff_fee);
}

export type AirportChargeSource =
  | "none"
  | "zone_route_pricing.airport_pickup_fee"
  | "zone_route_pricing.airport_dropoff_fee"
  | "zone_route_pricing.airport_charge"
  | "service_area_pricing_settings.airport_charge"
  | "custom_zones.metadata.airport_charge";

export type ResolvedAirportCharge = {
  airportPickupFee: number;
  airportDropoffFee: number;
  airportCharge: number;
  airportChargeSource: AirportChargeSource;
};

export type GetAirportChargeInput = {
  pickupZone: ZoneRow | null;
  dropoffZone: ZoneRow | null;
  serviceAreaPricingSettings?: Record<string, unknown> | null;
  routePricing: ZoneRoutePricingRow | null;
};

/**
 * Airport surcharge from admin DB only (no hardcoded defaults).
 * Priority: route pickup/dropoff fee → route.airport_charge → service area → zone metadata → 0.
 */
export function resolveAirportChargeFromAdmin(
  input: GetAirportChargeInput,
): ResolvedAirportCharge {
  try {
    const route = input.routePricing;
    const airportPickupFee = round2(
      routeEndpointAirportPickupFee(route, input.pickupZone),
    );
    if (airportPickupFee > 0) {
      return {
        airportPickupFee,
        airportDropoffFee: 0,
        airportCharge: airportPickupFee,
        airportChargeSource: "zone_route_pricing.airport_pickup_fee",
      };
    }

    const airportDropoffFee = round2(
      routeEndpointAirportDropoffFee(route, input.dropoffZone),
    );
    if (airportDropoffFee > 0) {
      return {
        airportPickupFee: 0,
        airportDropoffFee,
        airportCharge: airportDropoffFee,
        airportChargeSource: "zone_route_pricing.airport_dropoff_fee",
      };
    }

    const routeCharge = round2(positiveMoney(route?.airport_charge));
    if (routeCharge > 0) {
      return {
        airportPickupFee: 0,
        airportDropoffFee: 0,
        airportCharge: routeCharge,
        airportChargeSource: "zone_route_pricing.airport_charge",
      };
    }

    const settings = input.serviceAreaPricingSettings;
    const serviceAreaCharge = round2(
      positiveMoney(settings?.airport_charge ?? settings?.airportCharge),
    );
    if (serviceAreaCharge > 0) {
      return {
        airportPickupFee: 0,
        airportDropoffFee: 0,
        airportCharge: serviceAreaCharge,
        airportChargeSource: "service_area_pricing_settings.airport_charge",
      };
    }

    const airportZone = isAirportZone(input.pickupZone)
      ? input.pickupZone
      : isAirportZone(input.dropoffZone)
        ? input.dropoffZone
        : null;
    const zoneCharge = round2(getZoneAirportFee(airportZone));
    if (zoneCharge > 0) {
      return {
        airportPickupFee: 0,
        airportDropoffFee: 0,
        airportCharge: zoneCharge,
        airportChargeSource: "custom_zones.metadata.airport_charge",
      };
    }

    return {
      airportPickupFee: 0,
      airportDropoffFee: 0,
      airportCharge: 0,
      airportChargeSource: "none",
    };
  } catch {
    return {
      airportPickupFee: 0,
      airportDropoffFee: 0,
      airportCharge: 0,
      airportChargeSource: "none",
    };
  }
}

/** Single airport surcharge (pickup OR dropoff endpoint fee, else cascade). Always returns ≥ 0. */
export function getAirportCharge(input: GetAirportChargeInput): number {
  return resolveAirportChargeFromAdmin(input).airportCharge;
}

/** @deprecated Prefer resolveAirportChargeFromAdmin — kept for existing tests/callers. */
export function resolveAirportCharge(
  pickupZone: ZoneRow | null,
  dropoffZone: ZoneRow | null,
  _zoneRoutes: ZoneRoutePricingRow[],
  _vehicleTypeId: string | null,
  matchedRoute: ZoneRoutePricingRow | null,
  serviceAreaPricingSettings?: Record<string, unknown> | null,
): number {
  return getAirportCharge({
    pickupZone,
    dropoffZone,
    routePricing: matchedRoute,
    serviceAreaPricingSettings,
  });
}

/** Canonical route-pricing fields for API responses (calculate-fare, estimate-fare, trip snapshots). */
export type RoutePricingApiFields = {
  pricingMode: TripPricingMode;
  routeName: string | null;
  vehicleCategory: string | null;
  routeFixedFare: number | null;
  airportCharge: number;
  totalFare: number;
};

export function buildRoutePricingApiFields(
  breakdown: Pick<
    FareBreakdown,
    "pricing_mode" | "zone_applied" | "trip_fare" | "airport_charge" | "final_fare"
  >,
  vehicleCategory?: string | null,
): RoutePricingApiFields {
  return {
    pricingMode: breakdown.pricing_mode,
    routeName: breakdown.zone_applied,
    vehicleCategory: vehicleCategory ?? null,
    routeFixedFare: breakdown.pricing_mode === "ROUTE_PRICING"
      ? round2(breakdown.trip_fare)
      : null,
    airportCharge: round2(breakdown.airport_charge),
    totalFare: round2(breakdown.final_fare),
  };
}

function parseDistanceBands(raw: unknown): DistanceBand[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      if (!b || typeof b !== "object") return null;
      const row = b as Record<string, unknown>;
      const from = Number(row.from);
      const rate = Number(row.rate_pence);
      if (!Number.isFinite(from) || !Number.isFinite(rate)) return null;
      const toRaw = row.to;
      const to = toRaw == null ? null : Number(toRaw);
      return {
        from,
        to: to != null && Number.isFinite(to) ? to : null,
        rate_pence: rate,
      } satisfies DistanceBand;
    })
    .filter((b): b is DistanceBand => b != null);
}

function formatBandRateMajor(ratePence: number, unitShort: string): string {
  const major = round2(ratePence / 100);
  return `${major.toFixed(2)}/${unitShort}`;
}

/** Summarise configured bands for customer breakdown UI. */
export function summariseDistanceBands(
  bands: DistanceBand[],
  distanceUnit: string | null | undefined,
): string {
  const unitShort = String(distanceUnit || "km").toLowerCase().startsWith("mi") ? "mi" : "km";
  const sorted = [...bands].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  return sorted
    .map((b) => {
      const upper = b.to == null ? "+" : `–${b.to}`;
      return `${b.from}${upper} ${unitShort} @ ${formatBandRateMajor(b.rate_pence, unitShort)}`;
    })
    .join(", ");
}

/**
 * Distance charge in money units.
 * Uses admin `distance_pricing_bands` when non-empty; else flat per_km_rate_pence.
 */
export function calculateDistanceChargeMoney(input: {
  distanceKm: number;
  distanceUnit?: string | null;
  perKmRatePence?: number | null;
  distancePricingBands?: unknown;
  multiplier?: number;
}): {
  charge: number;
  usedBands: boolean;
  bandSummary: string | null;
  bands: DistanceBandUsage[];
} {
  const multiplier = input.multiplier ?? 1;
  const isMiles = String(input.distanceUnit || "km").toLowerCase().startsWith("mi");
  const tripDist = isMiles ? input.distanceKm / KM_PER_MILE : input.distanceKm;
  const bands = parseDistanceBands(input.distancePricingBands);
  const unit: DistanceBandUsage["unit"] = isMiles ? "mi" : "km";

  if (bands.length === 0) {
    const perUnit = penceToUnit(input.perKmRatePence) * multiplier;
    return {
      charge: round2(tripDist * perUnit),
      usedBands: false,
      bandSummary: null,
      bands: [],
    };
  }

  const sorted = [...bands].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  let chargePence = 0;
  const used: DistanceBandUsage[] = [];
  for (const b of sorted) {
    const upper = b.to == null ? Infinity : b.to;
    const span = Math.max(0, Math.min(tripDist, upper) - (b.from ?? 0));
    if (span <= 0) continue;
    const raw = span * (b.rate_pence ?? 0);
    chargePence += raw;
    used.push({
      from_distance: b.from ?? 0,
      to_distance: b.to,
      distance_used: round2(span),
      rate_per_unit_pence: Math.round((b.rate_pence ?? 0) * multiplier),
      charge_pence: Math.round(raw * multiplier),
      unit,
    });
  }
  return {
    charge: round2((chargePence / 100) * multiplier),
    usedBands: true,
    bandSummary: summariseDistanceBands(bands, input.distanceUnit),
    bands: used,
  };
}

/** Build display lines — same amounts that feed final_fare. */
export function buildFareDetails(input: {
  pricingMode: TripPricingMode;
  tripFare: number;
  airportCharge: number;
  baseFare?: number;
  distanceCost?: number;
  timeCost?: number;
  bookingFee?: number;
  minimumApplied?: boolean;
  minimumFare?: number;
  subtotalBeforeMinimum?: number;
  distancePricingMode?: DistancePricingMode;
  distanceBandSummary?: string | null;
}): FareDetailLine[] {
  const airport = round2(input.airportCharge);
  const tripFare = round2(input.tripFare);

  if (input.pricingMode === "ROUTE_PRICING") {
    const lines: FareDetailLine[] = [{ label: "Trip fare", amount: tripFare }];
    if (airport > 0) {
      lines.push({ label: "Airport charge", amount: airport });
    }
    return lines;
  }

  const lines: FareDetailLine[] = [];
  const base = round2(input.baseFare ?? 0);
  const distance = round2(input.distanceCost ?? 0);
  const time = round2(input.timeCost ?? 0);
  const booking = round2(input.bookingFee ?? 0);

  if (base > 0) lines.push({ label: "Base fare", amount: base });
  if (distance > 0) {
    lines.push({ label: "Distance charge", amount: distance });
  }
  if (time > 0) lines.push({ label: "Time charge", amount: time });
  if (booking > 0) lines.push({ label: "Booking fee", amount: booking });

  if (input.minimumApplied && input.minimumFare != null) {
    const subtotal = round2(input.subtotalBeforeMinimum ?? 0);
    const adjustment = round2(input.minimumFare - subtotal);
    if (adjustment > 0) {
      lines.push({ label: "Minimum fare adjustment", amount: adjustment });
    }
  }

  if (lines.length === 0) {
    lines.push({ label: "Fare", amount: tripFare });
  }

  if (airport > 0) {
    lines.push({ label: "Airport charge", amount: airport });
  }
  return lines;
}

/**
 * Best matching zone_route_pricing row for from→to.
 * Prefers vehicle-specific, then service-area-specific, then priority.
 */
export function findZoneRoutePricing(
  routes: ZoneRoutePricingRow[],
  fromZoneId: string,
  toZoneId: string,
  serviceAreaId: string | null,
  vehicleTypeId: string | null,
): ZoneRoutePricingRow | null {
  const candidates = routes.filter(
    (r) =>
      r.is_active &&
      r.from_zone_id === fromZoneId &&
      r.to_zone_id === toZoneId &&
      (r.vehicle_type_id == null || r.vehicle_type_id === vehicleTypeId) &&
      (r.service_area_id == null || !serviceAreaId || r.service_area_id === serviceAreaId),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const av = a.vehicle_type_id && a.vehicle_type_id === vehicleTypeId ? 2 : a.vehicle_type_id ? 0 : 1;
    const bv = b.vehicle_type_id && b.vehicle_type_id === vehicleTypeId ? 2 : b.vehicle_type_id ? 0 : 1;
    if (av !== bv) return bv - av;
    const as = a.service_area_id && a.service_area_id === serviceAreaId ? 2 : a.service_area_id ? 0 : 1;
    const bs = b.service_area_id && b.service_area_id === serviceAreaId ? 2 : b.service_area_id ? 0 : 1;
    if (as !== bs) return bs - as;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });
  return candidates[0];
}

/** @deprecated Use findZoneRoutePricing — kept for existing imports/tests. */
export function pickZoneRoute(
  routes: ZoneRoutePricingRow[],
  fromZoneId: string,
  toZoneId: string,
  vehicleTypeId: string | null,
): ZoneRoutePricingRow | null {
  return findZoneRoutePricing(routes, fromZoneId, toZoneId, null, vehicleTypeId);
}

type RoutePricingContext = {
  pickupZone: ZoneRow | null;
  dropoffZone: ZoneRow | null;
  route: ZoneRoutePricingRow | null;
  fixedApplied: boolean;
};

/** Resolve zones + route row; tries all zone pairs at each endpoint when needed. */
function resolveRoutePricingContext(input: {
  pickup: LatLng | null;
  dropoff: LatLng | null;
  zones: ZoneRow[];
  zoneRoutes: ZoneRoutePricingRow[];
  serviceAreaId: string | null;
  vehicleTypeId: string | null;
  pickupZoneId?: string | null;
  dropoffZoneId?: string | null;
}): RoutePricingContext {
  const { zones, zoneRoutes, serviceAreaId, vehicleTypeId } = input;
  const pickup = input.pickup;
  const dropoff = input.dropoff;

  const routeHasFixedFare = (route: ZoneRoutePricingRow | null) =>
    route != null && positiveMoney(route.fixed_fare) > 0;

  if (input.pickupZoneId && input.dropoffZoneId && input.pickupZoneId !== input.dropoffZoneId) {
    const route = findZoneRoutePricing(
      zoneRoutes,
      input.pickupZoneId,
      input.dropoffZoneId,
      serviceAreaId,
      vehicleTypeId,
    );
    if (routeHasFixedFare(route)) {
      return {
        pickupZone: zones.find((z) => z.id === input.pickupZoneId) ?? null,
        dropoffZone: zones.find((z) => z.id === input.dropoffZoneId) ?? null,
        route,
        fixedApplied: true,
      };
    }
  }

  if (pickup && dropoff) {
    const pickupZones = zonesContainingPoint(pickup, zones);
    const dropoffZones = zonesContainingPoint(dropoff, zones);
    for (const pz of pickupZones) {
      for (const dz of dropoffZones) {
        if (pz.id === dz.id) continue;
        const route = findZoneRoutePricing(
          zoneRoutes,
          pz.id,
          dz.id,
          serviceAreaId,
          vehicleTypeId,
        );
        if (routeHasFixedFare(route)) {
          return { pickupZone: pz, dropoffZone: dz, route, fixedApplied: true };
        }
      }
    }
  }

  const pickupZone = pickup ? detectZone(pickup, zones) : null;
  const dropoffZone = dropoff ? detectZone(dropoff, zones) : null;
  const route =
    pickupZone && dropoffZone && pickupZone.id !== dropoffZone.id
      ? findZoneRoutePricing(
        zoneRoutes,
        pickupZone.id,
        dropoffZone.id,
        serviceAreaId,
        vehicleTypeId,
      )
      : null;

  return {
    pickupZone,
    dropoffZone,
    route,
    fixedApplied: routeHasFixedFare(route),
  };
}

/** JSON persisted on trips / offer snapshots for driver + dispatch surfaces. */
export function fareBreakdownToTripSnapshot(
  breakdown: FareBreakdown,
  extras?: {
    pickupZoneId?: string | null;
    dropoffZoneId?: string | null;
    vehicleCategory?: string | null;
  },
): Record<string, unknown> {
  const routeFields = buildRoutePricingApiFields(breakdown, extras?.vehicleCategory);
  return {
    tripFare: breakdown.trip_fare,
    trip_fare: breakdown.trip_fare,
    trip_fare_pence: Math.round(breakdown.trip_fare * 100),
    routeFixedFare: routeFields.routeFixedFare,
    routeName: routeFields.routeName,
    vehicleCategory: routeFields.vehicleCategory,
    airportCharge: breakdown.airport_charge,
    airport_charge: breakdown.airport_charge,
    airport_charge_pence: Math.round(breakdown.airport_charge * 100),
    airportChargeSource: breakdown.airport_charge_source,
    airportPickupFee: breakdown.airport_pickup_fee,
    airportDropoffFee: breakdown.airport_dropoff_fee,
    fareDetails: breakdown.fare_details,
    pricing_mode: breakdown.pricing_mode,
    pricingMode: breakdown.pricing_mode,
    tripPricingMode: breakdown.pricing_mode,
    fareSource: breakdown.fare_source,
    routeMatch: breakdown.route_match,
    matchedRouteId: breakdown.matched_route_id,
    zoneApplied: breakdown.zone_applied,
    fixedFareApplied: breakdown.fixed_fare_applied,
    distance_pricing_mode: breakdown.distance_pricing_mode,
    distance_band_summary: breakdown.distance_band_summary,
    distance_bands: breakdown.distance_bands,
    subtotal_before_minimum: breakdown.subtotal_before_minimum,
    minimum_applied: breakdown.minimum_applied,
    totalFare: breakdown.final_fare,
    total_fare_pence: breakdown.final_fare_pence,
    pickup_zone_id: extras?.pickupZoneId ?? null,
    dropoff_zone_id: extras?.dropoffZoneId ?? null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const penceToUnit = (v: number | null | undefined) => (Number(v) || 0) / 100;
const round2 = (v: number) => Math.round(v * 100) / 100;
const clampMul = (v: number | null | undefined) => {
  const n = Number(v) || 1;
  return n > 0 ? n : 1;
};

function dynamicMultiplier(fp: FarePricingRow): number {
  if ((String(fp.pricing_mode || "fixed")).toLowerCase() !== "dynamic") return 1;
  return [
    fp.enable_surge ? clampMul(fp.surge_multiplier_default) : 1,
    clampMul(fp.peak_hour_multiplier),
    clampMul(fp.zone_multiplier),
    clampMul(fp.traffic_multiplier),
    clampMul(fp.demand_supply_multiplier),
  ].reduce((a, b) => a * b, 1);
}

// ── Engine ──────────────────────────────────────────────────────────────────

export interface CalculateFareInput {
  pricing: FarePricingRow;
  distanceKm: number;
  durationMin: number;
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  zones?: ZoneRow[];
  zoneRoutes?: ZoneRoutePricingRow[];
  serviceAreaId?: string | null;
  serviceAreaPricingSettings?: Record<string, unknown> | null;
  vehicleTypeId?: string | null;
  /** When set (e.g. from resolve_zone at booking), used before geometry detection. */
  pickupZoneId?: string | null;
  dropoffZoneId?: string | null;
  /**
   * Region's distance unit ("km" or "mile"). The admin UI labels the per-distance
   * rate using this unit (e.g. "Per mile Rate"), so the stored `per_km_rate_pence`
   * value is actually money-per-region-unit. The engine converts trip distance
   * into the same unit before multiplying so admin intent matches engine output.
   */
  distanceUnit?: string | null;
}

const KM_PER_MILE = 1.609344;

/**
 * The single source of truth.  All edge functions doing fare math MUST go
 * through this function so estimate, display, and capture stay in lock-step.
 */
export function calculateFare(input: CalculateFareInput): FareBreakdown {
  const { pricing, distanceKm, durationMin } = input;
  const zones = input.zones ?? [];
  const zoneRoutes = input.zoneRoutes ?? [];

  // STEP 1–2 — Detect zones and zone-route pricing (fixed fare required for ROUTE_PRICING)
  const {
    pickupZone,
    dropoffZone,
    route,
    fixedApplied,
  } = resolveRoutePricingContext({
    pickup: input.pickup ?? null,
    dropoff: input.dropoff ?? null,
    zones,
    zoneRoutes,
    serviceAreaId: input.serviceAreaId ?? null,
    vehicleTypeId: input.vehicleTypeId ?? null,
    pickupZoneId: input.pickupZoneId ?? null,
    dropoffZoneId: input.dropoffZoneId ?? null,
  });

  const fixedFare = fixedApplied && route?.fixed_fare != null
    ? Number(route.fixed_fare)
    : null;

  // Airport: route fees only for ROUTE_PRICING; else service-area / zone metadata (no double-count)
  let airportPickupFee = 0;
  let airportDropoffFee = 0;
  let airportCharge = 0;
  let airportChargeSource: AirportChargeSource = "none";
  try {
    ({
      airportPickupFee,
      airportDropoffFee,
      airportCharge,
      airportChargeSource,
    } = resolveAirportChargeFromAdmin({
      pickupZone,
      dropoffZone,
      routePricing: fixedApplied ? route : null,
      serviceAreaPricingSettings: input.serviceAreaPricingSettings,
    }));
  } catch {
    airportPickupFee = 0;
    airportDropoffFee = 0;
    airportCharge = 0;
    airportChargeSource = "none";
  }

  // STEP 3 — Base pricing (only when no fixed fare)
  const baseFare = penceToUnit(pricing.base_fare_pence);
  const perKm = penceToUnit(pricing.per_km_rate_pence);
  const perMin = penceToUnit(pricing.per_min_rate_pence);
  const bookingFee = penceToUnit(pricing.booking_fee_pence);
  const minimumFare = penceToUnit(pricing.minimum_fare_pence);
  const multiplier = dynamicMultiplier(pricing);

  // The admin enters the per-distance rate in the region's distance unit.
  let distanceCost = 0;
  let timeCost = 0;
  let rideFare = 0;
  let distancePricingMode: DistancePricingMode = "flat";
  let distanceBandSummary: string | null = null;
  let distanceBandsUsed: DistanceBandUsage[] = [];
  let subtotalBeforeMinimum = 0;
  let minimumAppliedFlag = false;

  if (fixedApplied) {
    rideFare = fixedFare!;
  } else {
    const distanceResult = calculateDistanceChargeMoney({
      distanceKm,
      distanceUnit: input.distanceUnit,
      perKmRatePence: pricing.per_km_rate_pence,
      distancePricingBands: pricing.distance_pricing_bands,
      multiplier,
    });
    distanceCost = distanceResult.charge;
    timeCost = durationMin * perMin * multiplier;
    subtotalBeforeMinimum = round2(baseFare + distanceCost + timeCost + bookingFee);
    minimumAppliedFlag = subtotalBeforeMinimum < minimumFare;
    rideFare = Math.max(subtotalBeforeMinimum, minimumFare);
    distancePricingMode = distanceResult.usedBands ? "bands" : "flat";
    distanceBandSummary = distanceResult.bandSummary;
    distanceBandsUsed = distanceResult.bands;
  }

  // STEP 4 — Waiting/cancellation handled by lifecycle endpoints; not in estimate.
  // STEP 5 — Offers applied by callers AFTER engine returns rideFare; engine never
  //          discounts airport/surcharge fees.

  const surcharge = 0; // reserved for future zone-surcharge rules
  const tripFare = round2(rideFare);
  const finalFare = round2(tripFare + airportCharge + surcharge);
  const tripPricingMode: TripPricingMode = fixedApplied
    ? "ROUTE_PRICING"
    : "NORMAL_DISTANCE_TIME";
  const fareDetails = buildFareDetails({
    pricingMode: tripPricingMode,
    tripFare,
    airportCharge,
    baseFare: fixedApplied ? 0 : baseFare,
    distanceCost: fixedApplied ? 0 : distanceCost,
    timeCost: fixedApplied ? 0 : timeCost,
    bookingFee: fixedApplied ? 0 : bookingFee,
    minimumApplied: fixedApplied ? false : minimumAppliedFlag,
    minimumFare: fixedApplied ? 0 : minimumFare,
    subtotalBeforeMinimum: fixedApplied ? 0 : subtotalBeforeMinimum,
    distancePricingMode: fixedApplied ? "flat" : distancePricingMode,
    distanceBandSummary: fixedApplied ? null : distanceBandSummary,
  });

  // Exclusive fare source — UI must branch on this and never mix breakdowns.
  const isDynamic = String(pricing.pricing_mode || "fixed").toLowerCase() === "dynamic";
  const fareSource: FareSource = fixedApplied
    ? "route_fixed"
    : isDynamic
      ? "standard_dynamic"
      : "standard_fixed";

  return {
    base_fare: round2(fixedApplied ? fixedFare! : baseFare),
    zone_applied:
      fixedApplied && pickupZone && dropoffZone
        ? `${pickupZone.name} → ${dropoffZone.name}`
        : null,
    pickup_zone: pickupZone?.name ?? null,
    dropoff_zone: dropoffZone?.name ?? null,
    pickup_zone_id: pickupZone?.id ?? null,
    dropoff_zone_id: dropoffZone?.id ?? null,
    trip_fare: tripFare,
    airport_charge: airportCharge,
    airport_charge_source: airportChargeSource,
    airport_pickup_fee: airportPickupFee,
    airport_dropoff_fee: airportDropoffFee,
    fare_details: fareDetails,
    surcharge,
    // When a route_fixed wins, distance/time/booking are NOT part of the fare and
    // must be returned as 0 so clients can never accidentally render them.
    distance_cost: round2(fixedApplied ? 0 : distanceCost),
    time_cost: round2(fixedApplied ? 0 : timeCost),
    per_km_rate: round2(fixedApplied ? 0 : perKm * multiplier),
    per_min_rate: round2(fixedApplied ? 0 : perMin * multiplier),
    booking_fee: round2(fixedApplied ? 0 : bookingFee),
    minimum_fare: round2(minimumFare),
    multiplier: round2(fixedApplied ? 1 : multiplier),
    fixed_fare_applied: fixedApplied,
    fare_source: fareSource,
    pricing_mode: tripPricingMode,
    distance_pricing_mode: fixedApplied ? "flat" : distancePricingMode,
    distance_band_summary: fixedApplied ? null : distanceBandSummary,
    distance_bands: fixedApplied ? [] : distanceBandsUsed,
    subtotal_before_minimum: fixedApplied ? 0 : subtotalBeforeMinimum,
    minimum_applied: fixedApplied ? false : minimumAppliedFlag,
    route_match: fixedApplied && route != null,
    matched_route_id: fixedApplied ? (route?.id ?? null) : null,
    final_fare: finalFare,
    final_fare_pence: Math.round(finalFare * 100),
  };
}
