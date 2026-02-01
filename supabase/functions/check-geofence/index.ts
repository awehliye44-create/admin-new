import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { 
  securityHeaders, 
  corsHeaders, 
  checkRateLimit, 
  getClientIP, 
  rateLimitResponse,
  successResponse,
  errorResponse
} from "../_shared/security.ts";
import { 
  validateSchema, 
  checkGeofenceSchema, 
  CheckGeofenceRequest 
} from "../_shared/validation.ts";

// Rate limit: 120 requests per minute per IP (high frequency for location updates)
const RATE_LIMIT_CONFIG = { limit: 120, windowMs: 60 * 1000 };

interface GeofenceEvent {
  zone_id: string;
  zone_name: string;
  event_type: "enter" | "exit";
  staging_zone: boolean;
  auto_arrive_radius_meters?: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const clientIP = getClientIP(req);

  // Check rate limit
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.log(`[check-geofence] Rate limit exceeded for IP: ${clientIP}`);
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }

  try {
    // Parse and validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON in request body', 400);
    }

    const validation = validateSchema<CheckGeofenceRequest>(body, checkGeofenceSchema);
    if (!validation.success) {
      console.log(`[check-geofence] Validation failed:`, validation.errors);
      return errorResponse('Validation failed', 400, { validation_errors: validation.errors });
    }

    const { driver_id, lat, lng, prev_lat, prev_lng, trip_id } = validation.data!;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get driver's region
    const { data: driver, error: driverError } = await supabase
      .from("drivers")
      .select("region_id")
      .eq("id", driver_id)
      .single();

    if (driverError || !driver) {
      return errorResponse("Driver not found", 404);
    }

    // Get all active GEOFENCE zones in the driver's region
    const { data: geofenceZones, error: zonesError } = await supabase
      .from("custom_zones")
      .select("*")
      .eq("region_id", driver.region_id)
      .eq("zone_type", "GEOFENCE")
      .eq("is_active", true);

    if (zonesError) throw zonesError;

    const events: GeofenceEvent[] = [];
    const triggeredZoneIds: string[] = [];

    // Check each geofence zone
    for (const zone of geofenceZones || []) {
      let isCurrentlyInside = false;
      let wasPreviouslyInside = false;

      if (zone.shape_type === "polygon" && zone.geo_boundary) {
        const { data: currentInside } = await supabase.rpc("point_in_polygon", {
          point_lat: lat,
          point_lng: lng,
          polygon_geojson: zone.geo_boundary,
        });
        isCurrentlyInside = currentInside === true;

        if (prev_lat !== undefined && prev_lng !== undefined) {
          const { data: previousInside } = await supabase.rpc("point_in_polygon", {
            point_lat: prev_lat,
            point_lng: prev_lng,
            polygon_geojson: zone.geo_boundary,
          });
          wasPreviouslyInside = previousInside === true;
        }
      } else if (zone.shape_type === "circle" && zone.center_lat && zone.center_lng && zone.radius_meters) {
        const { data: currentInside } = await supabase.rpc("point_in_circle", {
          point_lat: lat,
          point_lng: lng,
          center_lat: zone.center_lat,
          center_lng: zone.center_lng,
          radius_meters: zone.radius_meters,
        });
        isCurrentlyInside = currentInside === true;

        if (prev_lat !== undefined && prev_lng !== undefined) {
          const { data: previousInside } = await supabase.rpc("point_in_circle", {
            point_lat: prev_lat,
            point_lng: prev_lng,
            center_lat: zone.center_lat,
            center_lng: zone.center_lng,
            radius_meters: zone.radius_meters,
          });
          wasPreviouslyInside = previousInside === true;
        }
      }

      const metadata = zone.metadata || {};

      // Detect enter event
      if (isCurrentlyInside && !wasPreviouslyInside && metadata.trigger_on_enter) {
        events.push({
          zone_id: zone.id,
          zone_name: zone.name,
          event_type: "enter",
          staging_zone: metadata.staging_zone || false,
          auto_arrive_radius_meters: metadata.auto_arrive_radius_meters,
        });
        triggeredZoneIds.push(zone.id);
      }

      // Detect exit event
      if (!isCurrentlyInside && wasPreviouslyInside && metadata.trigger_on_exit) {
        events.push({
          zone_id: zone.id,
          zone_name: zone.name,
          event_type: "exit",
          staging_zone: metadata.staging_zone || false,
        });
        triggeredZoneIds.push(zone.id);
      }
    }

    // Log geofence events to database (throttled)
    for (const event of events) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      
      const { data: recentEvents } = await supabase
        .from("geofence_events")
        .select("id")
        .eq("driver_id", driver_id)
        .eq("zone_id", event.zone_id)
        .eq("event_type", event.event_type)
        .gte("created_at", fiveMinutesAgo)
        .limit(1);

      if (!recentEvents || recentEvents.length === 0) {
        await supabase.from("geofence_events").insert({
          driver_id,
          zone_id: event.zone_id,
          event_type: event.event_type,
          trip_id: trip_id || null,
          lat,
          lng,
        });
      }
    }

    // Check for auto-arrive trigger
    let autoArriveTriggered = false;
    let autoArriveZone = null;

    if (trip_id) {
      const { data: trip } = await supabase
        .from("trips")
        .select("status, pickup_latitude, pickup_longitude")
        .eq("id", trip_id)
        .single();

      if (trip && trip.status === "en_route_to_pickup" && trip.pickup_latitude && trip.pickup_longitude) {
        for (const zone of geofenceZones || []) {
          const metadata = zone.metadata || {};
          if (metadata.auto_arrive_radius_meters) {
            const { data: withinRadius } = await supabase.rpc("point_in_circle", {
              point_lat: lat,
              point_lng: lng,
              center_lat: trip.pickup_latitude,
              center_lng: trip.pickup_longitude,
              radius_meters: metadata.auto_arrive_radius_meters,
            });

            if (withinRadius) {
              autoArriveTriggered = true;
              autoArriveZone = {
                zone_id: zone.id,
                zone_name: zone.name,
                auto_arrive_radius_meters: metadata.auto_arrive_radius_meters,
              };
              break;
            }
          }
        }
      }
    }

    return successResponse({
      events,
      events_count: events.length,
      auto_arrive: autoArriveTriggered
        ? {
            triggered: true,
            ...autoArriveZone,
          }
        : { triggered: false },
    });
  } catch (error: any) {
    console.error("Error checking geofence:", error);
    return errorResponse(error.message || "Unknown error", 500);
  }
});
