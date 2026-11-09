/**
 * Ride Now vehicle availability SSOT (Customer Choose Ride, Corporate Book,
 * WhatsApp / guest web booking).
 *
 * Eligibility matches `find-drivers`:
 * - pickup inside an active region polygon
 * - driver assigned to a service area in that region
 * - online, approved, active, documents approved, lat/lng present
 * - matching vehicle category (default type excludes explicit disables;
 *   non-default requires enabled Admin assignment; driver_controllable types
 *   e.g. Pet-Friendly also require drivers.is_pet_friendly = true — same as
 *   auto-dispatch; Admin assignment is never cleared by the driver toggle)
 * - within max_distance_km of pickup (Distance Matrix with Haversine fallback)
 *
 * Scheduled bookings must NOT call this gate for “nearby right now” —
 * they use catalogue support flags instead (Customer/Corporate policy).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { getDistanceMatrix } from "./googleMaps.ts";

export type RideNowAvailabilityState = "available" | "unavailable" | "error";

export type EligibleDriverRow = {
  id: string;
  rating: number | null;
  current_lat: number | null;
  current_lng: number | null;
  distance_km: number;
  eta_min: number | null;
};

export type RideNowAvailabilityResult = {
  availability_state: RideNowAvailabilityState;
  drivers: EligibleDriverRow[];
  message: string;
  subtext?: string;
  service_area_ids?: string[];
  region?: {
    id: string;
    name: string;
    currency_code: string;
    distance_unit: string;
    timezone: string;
  } | null;
};

export const RIDE_NOW_NO_DRIVERS_MESSAGE = "No drivers available right now.";
export const RIDE_NOW_NO_DRIVERS_SUBTEXT =
  "Please try again in a few minutes or adjust your pickup location.";
export const VEHICLE_NO_LONGER_AVAILABLE_CODE = "VEHICLE_UNAVAILABLE";
export const VEHICLE_NO_LONGER_AVAILABLE_ERROR =
  "This vehicle is no longer available. Please choose another option.";

type LatLng = { lat: number; lng: number };

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

function unavailable(partial?: Partial<RideNowAvailabilityResult>): RideNowAvailabilityResult {
  return {
    availability_state: "unavailable",
    drivers: [],
    message: RIDE_NOW_NO_DRIVERS_MESSAGE,
    subtext: RIDE_NOW_NO_DRIVERS_SUBTEXT,
    ...partial,
  };
}

/**
 * True when a booking is Ride Now / immediate and must pass the nearby-driver gate.
 * Scheduled bookings pass a journey timestamp and skip live nearby eligibility.
 */
export function isImmediateRideNowBooking(scheduledAt: string | null | undefined): boolean {
  if (scheduledAt == null) return true;
  const trimmed = String(scheduledAt).trim();
  return trimmed.length === 0;
}

type OnlineDriver = {
  id: string;
  rating: number | null;
  current_lat: number;
  current_lng: number;
};

type RegionMatch = {
  id: string;
  name: string;
  currency_code: string;
  distance_unit: string;
  timezone: string;
};

async function resolvePickupRegionContext(
  supabase: SupabaseClient,
  pickup: LatLng,
): Promise<
  | { ok: true; region: RegionMatch; serviceAreaIds: string[] }
  | { ok: false; result: RideNowAvailabilityResult }
> {
  const { data: serviceAreas, error: saError } = await supabase
    .from("service_areas")
    .select("id, name, region_id")
    .eq("is_active", true);
  if (saError) throw saError;

  const { data: regions, error: regError } = await supabase
    .from("regions")
    .select("id, name, geo_boundary, currency_code, distance_unit, timezone")
    .eq("status", "active");
  if (regError) throw regError;

  let matchingRegion: RegionMatch | null = null;
  for (const region of regions || []) {
    if (region.geo_boundary && isPointInPolygon(pickup, region.geo_boundary as LatLng[])) {
      matchingRegion = {
        id: region.id,
        name: region.name,
        currency_code: region.currency_code,
        distance_unit: region.distance_unit,
        timezone: region.timezone,
      };
      break;
    }
  }

  if (!matchingRegion) {
    return { ok: false, result: unavailable() };
  }

  const regionServiceAreas = (serviceAreas || []).filter((sa) => sa.region_id === matchingRegion!.id);
  const serviceAreaIds = regionServiceAreas.map((sa) => sa.id);
  if (serviceAreaIds.length === 0) {
    return { ok: false, result: unavailable({ region: matchingRegion }) };
  }

  return { ok: true, region: matchingRegion, serviceAreaIds };
}

async function loadOnlineDriversInServiceAreas(
  supabase: SupabaseClient,
  serviceAreaIds: string[],
): Promise<OnlineDriver[]> {
  const { data: driverServiceAreas, error: dsaError } = await supabase
    .from("driver_service_areas")
    .select("driver_id, service_area_id")
    .in("service_area_id", serviceAreaIds);
  if (dsaError) throw dsaError;

  const eligibleDriverIds = [...new Set((driverServiceAreas || []).map((dsa) => dsa.driver_id))];
  if (eligibleDriverIds.length === 0) return [];

  const { data: drivers, error: driverError } = await supabase
    .from("drivers")
    .select(
      "id, first_name, last_name, driver_code, is_online, current_lat, current_lng, rating, region_id, documents_approved",
    )
    .eq("is_online", true)
    .eq("approval_status", "approved")
    .eq("driver_status", "active")
    .eq("documents_approved", true)
    .in("id", eligibleDriverIds)
    .not("current_lat", "is", null)
    .not("current_lng", "is", null);
  if (driverError) throw driverError;

  return (drivers || [])
    .filter((d) => typeof d.current_lat === "number" && typeof d.current_lng === "number")
    .map((d) => ({
      id: d.id as string,
      rating: (d.rating as number | null) ?? null,
      current_lat: d.current_lat as number,
      current_lng: d.current_lng as number,
    }));
}

async function filterDriversByVehicleCategory(
  supabase: SupabaseClient,
  driverIds: string[],
  vehicleTypeId: string | null | undefined,
): Promise<string[]> {
  if (!vehicleTypeId || driverIds.length === 0) return driverIds;

  const { data: vType, error: vTypeError } = await supabase
    .from("vehicle_types")
    .select("is_default, driver_controllable")
    .eq("id", vehicleTypeId)
    .maybeSingle();
  if (vTypeError) {
    console.error("[findDriversAvailabilitySSOT] vehicle type lookup failed:", vTypeError);
  }

  if (vType?.is_default) {
    const { data: disabledCategories, error: disabledError } = await supabase
      .from("driver_vehicle_categories")
      .select("driver_id")
      .eq("vehicle_type_id", vehicleTypeId)
      .eq("is_enabled", false)
      .in("driver_id", driverIds);
    if (disabledError) {
      console.error("[findDriversAvailabilitySSOT] disabled categories failed:", disabledError);
      return driverIds;
    }
    const disabled = new Set((disabledCategories || []).map((row) => row.driver_id));
    return driverIds.filter((id) => !disabled.has(id));
  }

  const { data: vehicleCategories, error: vcError } = await supabase
    .from("driver_vehicle_categories")
    .select("driver_id")
    .eq("vehicle_type_id", vehicleTypeId)
    .eq("is_enabled", true)
    .in("driver_id", driverIds);
  if (vcError) {
    console.error("[findDriversAvailabilitySSOT] enabled categories failed:", vcError);
    return [];
  }
  const assignedIds = (vehicleCategories || []).map((vc) => vc.driver_id as string);
  if (assignedIds.length === 0) return [];

  // Pet-Friendly (and any future driver_controllable type): Admin assignment is
  // capability; drivers.is_pet_friendly is the driver's on/off toggle. Both required.
  // Fail closed if the toggle cannot be read (parity with auto-dispatch).
  if (vType?.driver_controllable === true) {
    const { data: toggledOn, error: toggleErr } = await supabase
      .from("drivers")
      .select("id")
      .in("id", assignedIds)
      .eq("is_pet_friendly", true);
    if (toggleErr) {
      console.error(
        "[findDriversAvailabilitySSOT] pet_friendly toggle read failed:",
        toggleErr.message,
      );
      return [];
    }
    return (toggledOn || []).map((row) => row.id as string);
  }

  return assignedIds;
}

async function rankDriversByPickupDistance(
  pickup: LatLng,
  candidates: OnlineDriver[],
  maxDistanceKm: number,
): Promise<EligibleDriverRow[]> {
  if (candidates.length === 0) return [];

  try {
    const origins = candidates.map((d) => ({ lat: d.current_lat, lng: d.current_lng }));
    const matrixResults = await getDistanceMatrix(origins, [pickup]);
    const etaMap = new Map<number, { distance_km: number; duration_min: number }>();
    for (const entry of matrixResults) {
      etaMap.set(entry.origin_index, {
        distance_km: entry.distance_km,
        duration_min: entry.duration_min,
      });
    }

    return candidates
      .map((driver, idx) => {
        const gmResult = etaMap.get(idx);
        const distance = gmResult
          ? gmResult.distance_km
          : calculateDistanceKm(pickup.lat, pickup.lng, driver.current_lat, driver.current_lng);
        return {
          id: driver.id,
          rating: driver.rating,
          current_lat: driver.current_lat,
          current_lng: driver.current_lng,
          distance_km: Math.round(distance * 10) / 10,
          eta_min: gmResult ? gmResult.duration_min : null,
        };
      })
      .filter((driver) => driver.distance_km <= maxDistanceKm)
      .sort((a, b) => a.distance_km - b.distance_km);
  } catch (gmErr) {
    console.warn("[findDriversAvailabilitySSOT] Distance Matrix failed, Haversine fallback:", gmErr);
    return candidates
      .map((driver) => {
        const distance = calculateDistanceKm(
          pickup.lat,
          pickup.lng,
          driver.current_lat,
          driver.current_lng,
        );
        return {
          id: driver.id,
          rating: driver.rating,
          current_lat: driver.current_lat,
          current_lng: driver.current_lng,
          distance_km: Math.round(distance * 10) / 10,
          eta_min: null,
        };
      })
      .filter((driver) => driver.distance_km <= maxDistanceKm)
      .sort((a, b) => a.distance_km - b.distance_km);
  }
}

/**
 * Authoritative Ride Now availability for one vehicle category at a pickup.
 */
export async function evaluateRideNowVehicleAvailability(
  supabase: SupabaseClient,
  input: {
    pickup_lat: number;
    pickup_lng: number;
    vehicle_type_id?: string | null;
    max_distance_km?: number;
  },
): Promise<RideNowAvailabilityResult> {
  const pickup = { lat: input.pickup_lat, lng: input.pickup_lng };
  // Default Ride Now radius: 27 km ≈ 16.77 miles.
  const maxDistanceKm = input.max_distance_km ?? 27;

  try {
    const regionCtx = await resolvePickupRegionContext(supabase, pickup);
    if (!regionCtx.ok) return regionCtx.result;

    const onlineDrivers = await loadOnlineDriversInServiceAreas(
      supabase,
      regionCtx.serviceAreaIds,
    );
    if (onlineDrivers.length === 0) {
      return unavailable({
        region: regionCtx.region,
        service_area_ids: regionCtx.serviceAreaIds,
      });
    }

    const filteredIds = await filterDriversByVehicleCategory(
      supabase,
      onlineDrivers.map((d) => d.id),
      input.vehicle_type_id,
    );
    const candidates = onlineDrivers.filter((d) => filteredIds.includes(d.id));
    const eligibleDrivers = await rankDriversByPickupDistance(pickup, candidates, maxDistanceKm);

    if (eligibleDrivers.length === 0) {
      return unavailable({
        region: regionCtx.region,
        service_area_ids: regionCtx.serviceAreaIds,
      });
    }

    return {
      availability_state: "available",
      drivers: eligibleDrivers,
      message: "",
      service_area_ids: regionCtx.serviceAreaIds,
      region: regionCtx.region,
    };
  } catch (error) {
    console.error("[findDriversAvailabilitySSOT] evaluate failed:", error);
    return {
      availability_state: "error",
      drivers: [],
      message: error instanceof Error ? error.message : "Internal server error",
      subtext: RIDE_NOW_NO_DRIVERS_SUBTEXT,
    };
  }
}

/**
 * Batch annotate vehicle type ids with the same Ride Now SSOT, sharing the
 * online-driver pool + one Distance Matrix call across categories.
 */
export async function evaluateRideNowAvailabilityForVehicleTypes(
  supabase: SupabaseClient,
  input: {
    pickup_lat: number;
    pickup_lng: number;
    vehicle_type_ids: string[];
    max_distance_km?: number;
  },
): Promise<Record<string, RideNowAvailabilityState>> {
  const out: Record<string, RideNowAvailabilityState> = {};
  const ids = [...new Set(input.vehicle_type_ids.filter(Boolean))];
  for (const id of ids) out[id] = "unavailable";
  if (ids.length === 0) return out;

  const pickup = { lat: input.pickup_lat, lng: input.pickup_lng };
  // Default Ride Now radius: 27 km ≈ 16.77 miles.
  const maxDistanceKm = input.max_distance_km ?? 27;

  try {
    const regionCtx = await resolvePickupRegionContext(supabase, pickup);
    if (!regionCtx.ok) return out;

    const onlineDrivers = await loadOnlineDriversInServiceAreas(
      supabase,
      regionCtx.serviceAreaIds,
    );
    if (onlineDrivers.length === 0) return out;

    // Rank all online drivers once; category filter is applied per type.
    const rankedAll = await rankDriversByPickupDistance(pickup, onlineDrivers, maxDistanceKm);
    const rankedById = new Map(rankedAll.map((d) => [d.id, d]));

    for (const vehicleTypeId of ids) {
      const filteredIds = await filterDriversByVehicleCategory(
        supabase,
        onlineDrivers.map((d) => d.id),
        vehicleTypeId,
      );
      const eligible = filteredIds.some((id) => rankedById.has(id));
      out[vehicleTypeId] = eligible ? "available" : "unavailable";
    }
    return out;
  } catch (error) {
    console.error("[findDriversAvailabilitySSOT] batch evaluate failed:", error);
    for (const id of ids) out[id] = "error";
    return out;
  }
}

/**
 * Fail-closed Ride Now submit gate. Returns null when booking may proceed.
 */
export async function assertRideNowVehicleAvailableOrError(
  supabase: SupabaseClient,
  input: {
    pickup_lat: number;
    pickup_lng: number;
    vehicle_type_id: string;
    scheduled_at?: string | null;
    max_distance_km?: number;
  },
): Promise<{ code: string; error: string } | null> {
  if (!isImmediateRideNowBooking(input.scheduled_at)) return null;

  const result = await evaluateRideNowVehicleAvailability(supabase, {
    pickup_lat: input.pickup_lat,
    pickup_lng: input.pickup_lng,
    vehicle_type_id: input.vehicle_type_id,
    max_distance_km: input.max_distance_km,
  });

  if (result.availability_state === "available" && result.drivers.length > 0) {
    return null;
  }

  return {
    code: VEHICLE_NO_LONGER_AVAILABLE_CODE,
    error: VEHICLE_NO_LONGER_AVAILABLE_ERROR,
  };
}
