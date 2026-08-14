import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  securityHeaders,
  jsonHeaders,
  handleCORSPreflight,
  checkRateLimit,
  rateLimitResponse,
  getClientIP,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import {
  bucketOpenTripsIntoGrid,
  buildComputedDemandZoneRows,
  DEMAND_LOOKBACK_MINUTES,
  OPEN_TRIP_STATUSES,
} from "../_shared/computeDriverDemandZones.ts";

const RATE_LIMIT_CONFIG = {
  limit: 30,
  windowMs: 60_000,
  keyPrefix: "compute-driver-demand-zones",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  const clientIP = getClientIP(req);
  const rate = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rate.allowed) {
    return rateLimitResponse(rate.retryAfterMs ?? 60_000);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return errorResponse("Server configuration error", 500);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const lookbackIso = new Date(
      Date.now() - DEMAND_LOOKBACK_MINUTES * 60_000,
    ).toISOString();

    const { data: trips, error: tripsError } = await supabase
      .from("trips")
      .select("service_area_id, pickup_latitude, pickup_longitude")
      .in("status", [...OPEN_TRIP_STATUSES])
      .is("confirmed_driver_id", null)
      .is("driver_id", null)
      .gte("created_at", lookbackIso)
      .not("pickup_latitude", "is", null)
      .not("pickup_longitude", "is", null)
      .limit(500);

    if (tripsError) {
      console.error("[compute-driver-demand-zones] trips query failed:", tripsError.message);
      return errorResponse(tripsError.message, 500);
    }

    const cells = bucketOpenTripsIntoGrid(
      (trips ?? []).map((row) => ({
        service_area_id: row.service_area_id ?? null,
        pickup_latitude: Number(row.pickup_latitude),
        pickup_longitude: Number(row.pickup_longitude),
      })),
    );

    const serviceAreaIds = [
      ...new Set(
        cells
          .map((c) => c.service_area_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];

    const regionByServiceArea = new Map<string, string | null>();
    if (serviceAreaIds.length > 0) {
      const { data: areas, error: areasError } = await supabase
        .from("service_areas")
        .select("id, region_id")
        .in("id", serviceAreaIds);

      if (areasError) {
        console.error("[compute-driver-demand-zones] service_areas query failed:", areasError.message);
        return errorResponse(areasError.message, 500);
      }

      for (const area of areas ?? []) {
        regionByServiceArea.set(area.id, area.region_id ?? null);
      }
    }

    const rows = buildComputedDemandZoneRows(cells, regionByServiceArea);

    const { error: deleteError } = await supabase
      .from("driver_demand_zones")
      .delete()
      .eq("source", "computed");

    if (deleteError) {
      console.error("[compute-driver-demand-zones] delete computed failed:", deleteError.message);
      return errorResponse(deleteError.message, 500);
    }

    if (rows.length > 0) {
      const { error: insertError } = await supabase
        .from("driver_demand_zones")
        .insert(rows);

      if (insertError) {
        console.error("[compute-driver-demand-zones] insert failed:", insertError.message);
        return errorResponse(insertError.message, 500);
      }
    }

    return successResponse({
      open_trips_scanned: trips?.length ?? 0,
      grid_cells: cells.length,
      computed_zones_written: rows.length,
      lookback_minutes: DEMAND_LOOKBACK_MINUTES,
    });
  } catch (err) {
    console.error("[compute-driver-demand-zones] unexpected error:", err);
    return errorResponse(
      err instanceof Error ? err.message : "Unexpected error",
      500,
    );
  }
});
