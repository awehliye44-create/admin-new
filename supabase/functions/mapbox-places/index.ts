import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAPBOX_ACCESS_TOKEN = Deno.env.get("MAPBOX_ACCESS_TOKEN");

// The Mapbox token is URL-restricted (allowlisted to the production domain).
// Server-side requests have no browser Referer, so we send the allowlisted
// origin explicitly on every Mapbox call to satisfy the token restriction.
const MAPBOX_REFERER = Deno.env.get("MAPBOX_REFERER") || "https://co.onecab.net/";

// Fetch wrapper that always attaches the allowlisted Referer header so the
// URL-restricted Mapbox token is accepted on server-side requests.
function mbFetch(url: string): Promise<Response> {
  return fetch(url, { headers: { Referer: MAPBOX_REFERER } });
}

interface AutocompleteRequest {
  input: string;
  sessionToken?: string;
  location?: { lat: number; lng: number };
  components?: string; // e.g., "country:gb"
}

interface DistanceRequest {
  origin: string;
  destination: string;
  waypoints?: string[];
}

interface PlaceDetailsRequest {
  placeId: string;
  sessionToken?: string;
}

// Parse the country code out of a Google-style components string ("country:gb")
function parseCountry(components?: string): string {
  if (!components) return "gb";
  const match = components.match(/country:([a-zA-Z]{2})/);
  return match ? match[1].toLowerCase() : "gb";
}

// Resolve an address string to [lng, lat] using Mapbox forward geocoding.
// Accepts raw "lat,lng" strings as a shortcut.
async function geocodeToCoords(query: string, country: string): Promise<[number, number] | null> {
  const latLng = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (latLng) {
    return [parseFloat(latLng[2]), parseFloat(latLng[1])]; // [lng, lat]
  }

  const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(
    query
  )}&country=${country}&limit=1&access_token=${MAPBOX_ACCESS_TOKEN}`;
  const res = await mbFetch(url);
  const data = await res.json();
  const coords = data?.features?.[0]?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length === 2) {
    return [coords[0], coords[1]]; // [lng, lat]
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!MAPBOX_ACCESS_TOKEN) {
      console.error("MAPBOX_ACCESS_TOKEN not configured");
      return new Response(
        JSON.stringify({ error: "Mapbox access token not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "autocomplete") {
      const body: AutocompleteRequest = await req.json();
      const { input, sessionToken, location, components } = body;

      if (!input || input.length < 2) {
        return new Response(
          JSON.stringify({ predictions: [] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const country = parseCountry(components);
      let mbUrl = `https://api.mapbox.com/search/searchbox/v1/suggest?q=${encodeURIComponent(
        input
      )}&country=${country}&language=en&limit=6&types=address,street,place,locality,postcode,poi&access_token=${MAPBOX_ACCESS_TOKEN}`;

      if (sessionToken) mbUrl += `&session_token=${sessionToken}`;
      if (location) mbUrl += `&proximity=${location.lng},${location.lat}`;

      console.log("Mapbox suggest for:", input);
      const response = await mbFetch(mbUrl);
      const data = await response.json();

      if (!response.ok) {
        console.error("Mapbox Suggest error:", data);
        return new Response(
          JSON.stringify({ predictions: [], status: "ERROR" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const predictions = (data.suggestions || []).map((s: any) => ({
        place_id: s.mapbox_id,
        description: s.full_address || [s.name, s.place_formatted].filter(Boolean).join(", "),
        structured_formatting: {
          main_text: s.name,
          secondary_text: s.place_formatted || s.full_address || "",
        },
      }));

      return new Response(
        JSON.stringify({ predictions, status: "OK" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "details") {
      const body: PlaceDetailsRequest = await req.json();
      const { placeId, sessionToken } = body;

      if (!placeId) {
        return new Response(
          JSON.stringify({ error: "placeId is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let mbUrl = `https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(
        placeId
      )}?access_token=${MAPBOX_ACCESS_TOKEN}`;
      if (sessionToken) mbUrl += `&session_token=${sessionToken}`;

      console.log("Mapbox retrieve for:", placeId);
      const response = await mbFetch(mbUrl);
      const data = await response.json();

      const feature = data?.features?.[0];
      if (!response.ok || !feature) {
        console.error("Mapbox Retrieve error:", data);
        return new Response(
          JSON.stringify({ error: data?.message || "Failed to get place details" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const [lng, lat] = feature.geometry.coordinates;
      const props = feature.properties || {};

      return new Response(
        JSON.stringify({
          result: {
            formatted_address: props.full_address || props.place_formatted || props.name,
            name: props.name,
            geometry: { location: { lat, lng } },
          },
          status: "OK",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "distance") {
      const body: DistanceRequest = await req.json();
      const { origin, destination, waypoints } = body;

      if (!origin || !destination) {
        return new Response(
          JSON.stringify({ error: "origin and destination are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const country = parseCountry();
      const points = [origin, ...(waypoints?.filter(Boolean) || []), destination];

      const coords: [number, number][] = [];
      for (const point of points) {
        const c = await geocodeToCoords(point, country);
        if (!c) {
          return new Response(
            JSON.stringify({ error: `Could not locate address: ${point}` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        coords.push(c);
      }

      const path = coords.map(([lng, lat]) => `${lng},${lat}`).join(";");
      const mbUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${path}?alternatives=false&overview=false&steps=false&access_token=${MAPBOX_ACCESS_TOKEN}`;

      console.log("Mapbox directions for", points.length, "points");
      const response = await mbFetch(mbUrl);
      const data = await response.json();

      const route = data?.routes?.[0];
      if (!response.ok || !route) {
        console.error("Mapbox Directions error:", data);
        return new Response(
          JSON.stringify({ error: data?.message || "Failed to get route" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const totalDistanceMeters = route.distance;
      const totalDurationSeconds = route.duration;

      const legs = (route.legs || []).map((leg: any, i: number) => ({
        distance: {
          value: leg.distance,
          text: `${(leg.distance / 1609.34).toFixed(1)} mi`,
        },
        duration: {
          value: leg.duration,
          text: `${Math.round(leg.duration / 60)} mins`,
        },
        start_address: points[i],
        end_address: points[i + 1],
      }));

      return new Response(
        JSON.stringify({
          distance: {
            value: totalDistanceMeters,
            text: `${(totalDistanceMeters / 1609.34).toFixed(1)} mi`,
          },
          duration: {
            value: totalDurationSeconds,
            text: `${Math.round(totalDurationSeconds / 60)} mins`,
          },
          legs: legs.length > 1 ? legs : undefined,
          status: "OK",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "reverse-geocode") {
      const body = await req.json();
      const { lat, lng } = body;

      if (lat == null || lng == null) {
        return new Response(
          JSON.stringify({ error: "lat and lng are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const mbUrl = `https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lng}&latitude=${lat}&access_token=${MAPBOX_ACCESS_TOKEN}`;
      console.log("Mapbox reverse geocode for:", lat, lng);
      const response = await mbFetch(mbUrl);
      const data = await response.json();

      const address = data?.features?.[0]?.properties?.full_address ||
        data?.features?.[0]?.properties?.place_formatted || null;

      return new Response(
        JSON.stringify({
          results: address ? [{ formatted_address: address }] : [],
          address,
          status: address ? "OK" : "ZERO_RESULTS",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use: autocomplete, details, distance, or reverse-geocode" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in mapbox-places function:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});