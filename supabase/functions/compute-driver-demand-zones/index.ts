import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  handleCORSPreflight,
  checkRateLimit,
  rateLimitResponse,
  getClientIP,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { requireDemandZoneRecomputeAuth } from "../_shared/demandZoneRecomputeAuth.ts";
import {
  evaluateComputedZonesForServiceArea,
  type TripForDemand,
} from "../_shared/computeDriverDemandZones.ts";
import { OPEN_TRIP_DEMAND_STATUSES, type DemandLevel } from "../../../shared/demandZoneSurgeSSOT.ts";

const RATE_LIMIT_CONFIG = {
  limit: 30,
  windowMs: 60_000,
  keyPrefix: "compute-driver-demand-zones",
};

interface SettingsRow {
  service_area_id: string;
  heat_map_enabled: boolean;
  open_trip_max_lifetime_minutes: number;
  low_min_trips: number;
  low_max_trips: number;
  medium_min_trips: number;
  medium_max_trips: number;
  high_min_trips: number;
  consecutive_checks_required: number;
  zone_radius_meters: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  const clientIP = getClientIP(req);
  const rate = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rate.allowed) {
    return rateLimitResponse(rate);
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
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        // Empty body is fine for cron.
      }
    }

    const auth = await requireDemandZoneRecomputeAuth(req, body);
    if (!auth.ok) {
      return auth.response;
    }

    let scopedServiceAreaId: string | null = null;
    if (typeof body?.service_area_id === "string" && body.service_area_id.trim()) {
      scopedServiceAreaId = body.service_area_id.trim();
    }

    let settingsQuery = supabase
      .from("service_area_demand_zone_settings")
      .select(
        "service_area_id, heat_map_enabled, open_trip_max_lifetime_minutes, low_min_trips, low_max_trips, medium_min_trips, medium_max_trips, high_min_trips, consecutive_checks_required, zone_radius_meters",
      )
      .eq("heat_map_enabled", true);

    if (scopedServiceAreaId) {
      settingsQuery = settingsQuery.eq("service_area_id", scopedServiceAreaId);
    }

    const { data: settingsRows, error: settingsError } = await settingsQuery;
    if (settingsError) {
      console.error("[compute-driver-demand-zones] settings query failed:", settingsError.message);
      return errorResponse(settingsError.message, 500);
    }

    const enabledSettings = (settingsRows ?? []) as SettingsRow[];
    if (enabledSettings.length === 0) {
      return successResponse({
        service_areas_processed: 0,
        open_trips_scanned: 0,
        computed_zones_written: 0,
        message: scopedServiceAreaId
          ? "Heat map disabled or no settings for this service area."
          : "No service areas have heat map enabled.",
      });
    }

    const serviceAreaIds = enabledSettings.map((s) => s.service_area_id);
    const maxLifetime = Math.max(...enabledSettings.map((s) => s.open_trip_max_lifetime_minutes));
    const lookbackIso = new Date(Date.now() - maxLifetime * 60_000).toISOString();

    const { data: tripsRaw, error: tripsError } = await supabase
      .from("trips")
      .select("id, service_area_id, pickup_latitude, pickup_longitude, status, driver_id, confirmed_driver_id, created_at")
      .in("service_area_id", serviceAreaIds)
      .in("status", [...OPEN_TRIP_DEMAND_STATUSES])
      .is("confirmed_driver_id", null)
      .is("driver_id", null)
      .gte("created_at", lookbackIso)
      .not("pickup_latitude", "is", null)
      .not("pickup_longitude", "is", null)
      .limit(2000);

    if (tripsError) {
      console.error("[compute-driver-demand-zones] trips query failed:", tripsError.message);
      return errorResponse(tripsError.message, 500);
    }

    const trips = (tripsRaw ?? []) as TripForDemand[];

    const { data: areas, error: areasError } = await supabase
      .from("service_areas")
      .select("id, region_id")
      .in("id", serviceAreaIds);

    if (areasError) {
      console.error("[compute-driver-demand-zones] service_areas query failed:", areasError.message);
      return errorResponse(areasError.message, 500);
    }

    const regionByServiceArea = new Map<string, string | null>();
    for (const area of areas ?? []) {
      regionByServiceArea.set(area.id, area.region_id ?? null);
    }

    const { data: existingZonesRaw, error: existingError } = await supabase
      .from("driver_demand_zones")
      .select("id, service_area_id, center_lat, center_lng, proposed_demand_level, confirmed_demand_level, consecutive_match_count, level_changed_at")
      .eq("source", "computed")
      .in("service_area_id", serviceAreaIds);

    if (existingError) {
      console.error("[compute-driver-demand-zones] existing zones query failed:", existingError.message);
      return errorResponse(existingError.message, 500);
    }

    const existingByServiceArea = new Map<string, typeof existingZonesRaw>();
    for (const zone of existingZonesRaw ?? []) {
      const list = existingByServiceArea.get(zone.service_area_id) ?? [];
      list.push(zone);
      existingByServiceArea.set(zone.service_area_id, list);
    }

    const evaluatedAtIso = new Date().toISOString();
    let totalWritten = 0;

    for (const settings of enabledSettings) {
      const saKeptIds = new Set<string>();
      const upserts = evaluateComputedZonesForServiceArea({
        trips,
        settings,
        existingZones: (existingByServiceArea.get(settings.service_area_id) ?? []).map((z) => ({
          id: z.id,
          center_lat: Number(z.center_lat),
          center_lng: Number(z.center_lng),
          proposed_demand_level: z.proposed_demand_level as DemandLevel | null,
          confirmed_demand_level: z.confirmed_demand_level as DemandLevel | null,
          consecutive_match_count: z.consecutive_match_count ?? 0,
          level_changed_at: z.level_changed_at ?? null,
        })),
        regionId: regionByServiceArea.get(settings.service_area_id) ?? null,
        serviceAreaId: settings.service_area_id,
        evaluatedAtIso,
      });

      for (const row of upserts) {
        const priorConfirmed = (existingByServiceArea.get(settings.service_area_id) ?? [])
          .find((z) => z.id === row.id)?.confirmed_demand_level ?? null;

        const payload = {
          name: row.name,
          center_lat: row.center_lat,
          center_lng: row.center_lng,
          radius_meters: row.radius_meters,
          demand_level: row.demand_level,
          proposed_demand_level: row.proposed_demand_level,
          confirmed_demand_level: row.confirmed_demand_level,
          consecutive_match_count: row.consecutive_match_count,
          last_open_trip_count: row.last_open_trip_count,
          last_evaluated_at: row.last_evaluated_at,
          ...(row.level_changed_at ? { level_changed_at: row.level_changed_at } : {}),
          active: row.active,
          region_id: row.region_id,
          service_area_id: row.service_area_id,
          source: row.source,
        };

        if (row.id) {
          const { error: updateError } = await supabase
            .from("driver_demand_zones")
            .update(payload)
            .eq("id", row.id);
          if (updateError) {
            console.error("[compute-driver-demand-zones] update failed:", updateError.message);
            return errorResponse(updateError.message, 500);
          }
          if (priorConfirmed !== row.confirmed_demand_level) {
            await supabase.rpc("log_demand_zone_event", {
              _service_area_id: settings.service_area_id,
              _zone_id: row.id,
              _action: "level_confirmed",
              _old_value: { confirmed_demand_level: priorConfirmed },
              _new_value: {
                confirmed_demand_level: row.confirmed_demand_level,
                proposed_demand_level: row.proposed_demand_level,
                open_trip_count: row.last_open_trip_count,
              },
              _reason: "recompute",
            });
          }
          saKeptIds.add(row.id);
          totalWritten += 1;
          continue;
        }

        const { data: inserted, error: insertError } = await supabase
          .from("driver_demand_zones")
          .insert(payload)
          .select("id")
          .single();

        if (insertError) {
          console.error("[compute-driver-demand-zones] insert failed:", insertError.message);
          return errorResponse(insertError.message, 500);
        }
        if (inserted?.id) saKeptIds.add(inserted.id);
        totalWritten += 1;
      }

      const staleIds = (existingByServiceArea.get(settings.service_area_id) ?? [])
        .map((z) => z.id)
        .filter((id) => !saKeptIds.has(id));

      if (staleIds.length > 0) {
        const { error: deleteError } = await supabase
          .from("driver_demand_zones")
          .delete()
          .in("id", staleIds);
        if (deleteError) {
          console.error("[compute-driver-demand-zones] stale delete failed:", deleteError.message);
          return errorResponse(deleteError.message, 500);
        }
      }
    }

    return successResponse({
      service_areas_processed: enabledSettings.length,
      open_trips_scanned: trips.length,
      computed_zones_written: totalWritten,
      lookback_minutes: maxLifetime,
      scoped_service_area_id: scopedServiceAreaId,
    });
  } catch (err) {
    console.error("[compute-driver-demand-zones] unexpected error:", err);
    return errorResponse(
      err instanceof Error ? err.message : "Unexpected error",
      500,
    );
  }
});
