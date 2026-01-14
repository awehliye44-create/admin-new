import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CheckGeofenceRequest {
  driver_id: string;
  lat: number;
  lng: number;
  previous_lat?: number;
  previous_lng?: number;
  trip_id?: string;
}

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

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: CheckGeofenceRequest = await req.json();
    const { driver_id, lat, lng, previous_lat, previous_lng, trip_id } = body;

    if (!driver_id || lat === undefined || lng === undefined) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: driver_id, lat, lng" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get driver's region
    const { data: driver, error: driverError } = await supabase
      .from("drivers")
      .select("region_id")
      .eq("id", driver_id)
      .single();

    if (driverError || !driver) {
      return new Response(
        JSON.stringify({ error: "Driver not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
        // Check polygon containment
        const { data: currentInside } = await supabase.rpc("point_in_polygon", {
          point_lat: lat,
          point_lng: lng,
          polygon_geojson: zone.geo_boundary,
        });
        isCurrentlyInside = currentInside === true;

        if (previous_lat !== undefined && previous_lng !== undefined) {
          const { data: previousInside } = await supabase.rpc("point_in_polygon", {
            point_lat: previous_lat,
            point_lng: previous_lng,
            polygon_geojson: zone.geo_boundary,
          });
          wasPreviouslyInside = previousInside === true;
        }
      } else if (zone.shape_type === "circle" && zone.center_lat && zone.center_lng && zone.radius_meters) {
        // Check circle containment
        const { data: currentInside } = await supabase.rpc("point_in_circle", {
          point_lat: lat,
          point_lng: lng,
          center_lat: zone.center_lat,
          center_lng: zone.center_lng,
          radius_meters: zone.radius_meters,
        });
        isCurrentlyInside = currentInside === true;

        if (previous_lat !== undefined && previous_lng !== undefined) {
          const { data: previousInside } = await supabase.rpc("point_in_circle", {
            point_lat: previous_lat,
            point_lng: previous_lng,
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

    // Log geofence events to database (throttled - check for recent events)
    for (const event of events) {
      // Check if we already logged this event in the last 5 minutes
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
      // Get trip details to check if we should trigger auto-arrive
      const { data: trip } = await supabase
        .from("trips")
        .select("status, pickup_latitude, pickup_longitude")
        .eq("id", trip_id)
        .single();

      if (trip && trip.status === "en_route_to_pickup" && trip.pickup_latitude && trip.pickup_longitude) {
        // Check if any zone has auto-arrive enabled and driver is within radius
        for (const zone of geofenceZones || []) {
          const metadata = zone.metadata || {};
          if (metadata.auto_arrive_radius_meters) {
            // Calculate distance to pickup
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

    return new Response(
      JSON.stringify({
        success: true,
        events,
        events_count: events.length,
        auto_arrive: autoArriveTriggered
          ? {
              triggered: true,
              ...autoArriveZone,
            }
          : { triggered: false },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error checking geofence:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
