import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  successResponse,
  errorResponse,
  handleCORSPreflight,
} from "../_shared/security.ts";
import {
  validateSchema,
  findDriversSchema,
  FindDriversRequest,
} from "../_shared/validation.ts";
import { getDistanceMatrix } from "../_shared/mapbox.ts";

// Rate limit: 60 requests per minute per IP
const RATE_LIMIT_CONFIG = { limit: 60, windowMs: 60 * 1000 };

interface LatLng {
  lat: number;
  lng: number;
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
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  const clientIP = getClientIP(req);

  // Check rate limit
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.log(`[find-drivers] Rate limit exceeded for IP: ${clientIP}`);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    // ── Authenticate caller ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("UNAUTHORIZED", "Missing authorization header", 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) {
      return errorResponse("UNAUTHORIZED", "Invalid or expired token", 401);
    }

    // Parse and validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse("PARSE_ERROR", "Invalid JSON in request body", 400);
    }

    const validation = validateSchema<FindDriversRequest>(body, findDriversSchema);
    if (!validation.success) {
      console.log(`[find-drivers] Validation failed:`, validation.errors);
      return errorResponse("VALIDATION_FAILED", "Validation failed", 400, {
        validation_errors: validation.errors,
      });
    }

    const { pickup_lat, pickup_lng, vehicle_type_id, max_distance_km = 10 } = validation.data!;

    console.log("Finding drivers for pickup:", { pickup_lat, pickup_lng, vehicle_type_id });

    const pickupPoint: LatLng = { lat: pickup_lat, lng: pickup_lng };

    // Step 1: Get all active service areas
    const { data: serviceAreas, error: saError } = await supabase
      .from("service_areas")
      .select("id, name, region_id")
      .eq("is_active", true);

    if (saError) {
      console.error("Error fetching service areas:", saError);
      throw saError;
    }

    // Step 2: Get regions with geo_boundary
    const { data: regions, error: regError } = await supabase
      .from("regions")
      .select("id, name, geo_boundary, currency_code, distance_unit, timezone")
      .eq("status", "active");

    if (regError) {
      console.error("Error fetching regions:", regError);
      throw regError;
    }

    // Find which region the pickup point is in
    let matchingRegion: {
      id: string;
      name: string;
      currency_code: string;
      distance_unit: string;
      timezone: string;
    } | null = null;

    for (const region of regions || []) {
      if (region.geo_boundary && isPointInPolygon(pickupPoint, region.geo_boundary as LatLng[])) {
        matchingRegion = {
          id: region.id,
          name: region.name,
          currency_code: region.currency_code,
          distance_unit: region.distance_unit,
          timezone: region.timezone,
        };
        console.log("Pickup is in region:", region.name);
        break;
      }
    }

    if (!matchingRegion) {
      console.log("Pickup location is not within any active region");
      return successResponse({
        drivers: [],
        message: "No drivers available right now.",
        subtext: "Please try again in a few minutes or adjust your pickup location.",
      });
    }

    // Get service areas for this region
    const regionServiceAreas = (serviceAreas || []).filter((sa) => sa.region_id === matchingRegion!.id);
    const serviceAreaIds = regionServiceAreas.map((sa) => sa.id);

    if (serviceAreaIds.length === 0) {
      console.log("No service areas found for region:", matchingRegion.name);
      return successResponse({
        drivers: [],
        message: "No drivers available right now.",
        subtext: "Please try again in a few minutes or adjust your pickup location.",
      });
    }

    // Step 3: Get drivers assigned to these service areas
    const { data: driverServiceAreas, error: dsaError } = await supabase
      .from("driver_service_areas")
      .select("driver_id, service_area_id")
      .in("service_area_id", serviceAreaIds);

    if (dsaError) {
      console.error("Error fetching driver service areas:", dsaError);
      throw dsaError;
    }

    const eligibleDriverIds = [...new Set((driverServiceAreas || []).map((dsa) => dsa.driver_id))];

    if (eligibleDriverIds.length === 0) {
      console.log("No drivers assigned to service areas in this region");
      return successResponse({
        drivers: [],
        message: "No drivers available right now.",
        subtext: "Please try again in a few minutes or adjust your pickup location.",
      });
    }

    // Step 4: Get online drivers from the eligible list.
    // Location SSOT: prefer driver_presence.lat/lng (written by upsert_driver_presence
    // on Go Online), fall back to drivers.current_lat/lng. Dispatch already uses
    // COALESCE(dp.lat, d.current_lat); find-drivers must match or online drivers
    // with presence coords but null drivers.current_* look like "No cars nearby".
    const { data: drivers, error: driverError } = await supabase
      .from("drivers")
      .select(
        "id, first_name, last_name, driver_code, is_online, current_lat, current_lng, rating, region_id, documents_approved, driver_presence(lat, lng, status)",
      )
      .eq("is_online", true)
      .eq("approval_status", "approved")
      .eq("driver_status", "active")
      .eq("documents_approved", true)
      .in("id", eligibleDriverIds);

    if (driverError) {
      console.error("Error fetching drivers:", driverError);
      throw driverError;
    }

    type DriverRow = {
      id: string;
      rating: number | null;
      current_lat: number | null;
      current_lng: number | null;
      driver_presence?:
        | { lat: number | null; lng: number | null; status: string | null }
        | { lat: number | null; lng: number | null; status: string | null }[]
        | null;
    };

    const locatedDrivers = ((drivers ?? []) as DriverRow[])
      .map((driver) => {
        const presence = Array.isArray(driver.driver_presence)
          ? driver.driver_presence[0]
          : driver.driver_presence;
        const lat =
          (typeof presence?.lat === "number" ? presence.lat : null) ??
          (typeof driver.current_lat === "number" ? driver.current_lat : null);
        const lng =
          (typeof presence?.lng === "number" ? presence.lng : null) ??
          (typeof driver.current_lng === "number" ? driver.current_lng : null);
        if (lat == null || lng == null) return null;
        if (lat === 0 && lng === 0) return null;
        return {
          id: driver.id,
          rating: driver.rating,
          current_lat: lat,
          current_lng: lng,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d != null);

    console.log("Online drivers found:", drivers?.length || 0);
    console.log("Online drivers with usable location:", locatedDrivers.length);

    if (locatedDrivers.length === 0) {
      return successResponse({
        drivers: [],
        message: "No drivers available right now.",
        subtext: "Please try again in a few minutes or adjust your pickup location.",
      });
    }

    // Step 5: Filter by vehicle type if specified.
    // Align with Driver Settings SSOT:
    // - is_default (ONECAB GO) → every located online driver is eligible (no DVC row required)
    // - driver_controllable (Pet-Friendly) → drivers.is_pet_friendly
    // - otherwise → enabled row in driver_vehicle_categories
    let filteredDriverIds = locatedDrivers.map((d) => d.id);

    if (vehicle_type_id) {
      const { data: vehicleType, error: vtError } = await supabase
        .from("vehicle_types")
        .select("id, is_default, driver_controllable")
        .eq("id", vehicle_type_id)
        .maybeSingle();

      if (vtError) {
        console.error("Error fetching vehicle type flags:", vtError);
      }

      if (vehicleType?.is_default === true) {
        console.log(
          "Default vehicle type — all located online drivers eligible:",
          filteredDriverIds.length,
        );
      } else if (vehicleType?.driver_controllable === true) {
        const { data: petDrivers, error: petError } = await supabase
          .from("drivers")
          .select("id")
          .eq("is_pet_friendly", true)
          .in("id", filteredDriverIds);
        if (petError) {
          console.error("Error fetching pet-friendly drivers:", petError);
          filteredDriverIds = [];
        } else {
          filteredDriverIds = (petDrivers || []).map((d) => d.id);
          console.log("Pet-friendly drivers eligible:", filteredDriverIds.length);
        }
      } else {
        const { data: vehicleCategories, error: vcError } = await supabase
          .from("driver_vehicle_categories")
          .select("driver_id")
          .eq("vehicle_type_id", vehicle_type_id)
          .eq("is_enabled", true)
          .in("driver_id", filteredDriverIds);

        if (vcError) {
          console.error("Error fetching vehicle categories:", vcError);
          filteredDriverIds = [];
        } else {
          filteredDriverIds = (vehicleCategories || []).map((vc) => vc.driver_id);
          console.log("Drivers with matching vehicle type assignment:", filteredDriverIds.length);
        }
      }
    }

    // Step 6: Calculate distance/ETA (Mapbox matrix with Haversine fallback)
    const candidateDrivers = locatedDrivers.filter((d) => filteredDriverIds.includes(d.id));

    let eligibleDrivers: Array<{
      id: string;
      rating: number | null;
      current_lat: number | null;
      current_lng: number | null;
      distance_km: number;
      eta_min: number | null;
    }> = [];

    try {
      const origins = candidateDrivers.map((d) => ({ lat: d.current_lat!, lng: d.current_lng! }));
      const destination = [{ lat: pickup_lat, lng: pickup_lng }];
      const matrixResults = await getDistanceMatrix(origins, destination);

      const etaMap = new Map<number, { distance_km: number; duration_min: number }>();
      for (const entry of matrixResults) {
        etaMap.set(entry.origin_index, {
          distance_km: entry.distance_km,
          duration_min: entry.duration_min,
        });
      }

      eligibleDrivers = candidateDrivers
        .map((driver, idx) => {
          const gmResult = etaMap.get(idx);
          const distance = gmResult
            ? gmResult.distance_km
            : calculateDistanceKm(
              pickup_lat,
              pickup_lng,
              driver.current_lat!,
              driver.current_lng!,
            );
          return {
            id: driver.id,
            rating: driver.rating,
            current_lat: driver.current_lat,
            current_lng: driver.current_lng,
            distance_km: Math.round(distance * 10) / 10,
            eta_min: gmResult ? gmResult.duration_min : null,
          };
        })
        .filter((driver) => driver.distance_km <= max_distance_km)
        .sort((a, b) => a.distance_km - b.distance_km);

      console.log("[find-drivers] Distance Matrix used for ETA calculation");
    } catch (gmErr) {
      console.warn("[find-drivers] Distance Matrix failed, falling back to Haversine:", gmErr);
      eligibleDrivers = candidateDrivers
        .map((driver) => {
          const distance = calculateDistanceKm(
            pickup_lat,
            pickup_lng,
            driver.current_lat!,
            driver.current_lng!,
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
        .filter((driver) => driver.distance_km <= max_distance_km)
        .sort((a, b) => a.distance_km - b.distance_km);
    }

    console.log("Eligible drivers after distance filter:", eligibleDrivers.length);

    if (eligibleDrivers.length === 0) {
      return successResponse({
        drivers: [],
        message: "No drivers available right now.",
        subtext: "Please try again in a few minutes or adjust your pickup location.",
      });
    }

    return successResponse({
      drivers: eligibleDrivers,
      service_area_ids: serviceAreaIds,
      region: matchingRegion,
      settings: {
        currency_code: matchingRegion.currency_code,
        distance_unit: matchingRegion.distance_unit,
        timezone: matchingRegion.timezone,
      },
    });
  } catch (error) {
    console.error("Error in find-drivers:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "Internal server error",
      500,
      {
        drivers: [],
        message: "No drivers available right now.",
        subtext: "Please try again in a few minutes or adjust your pickup location.",
      },
    );
  }
});
