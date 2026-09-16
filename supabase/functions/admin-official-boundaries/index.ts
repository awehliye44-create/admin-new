/**
 * Admin official boundary search / catalog.
 * Sources: ONECAB official_admin_boundaries catalog + Nominatim (OSM) polygons.
 * Map display stays Mapbox; this edge only supplies normalized GeoJSON.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform",
};

const NOMINATIM_UA = "ONECAB-AdminBoundaryEditor/1.0 (admin@onecab.app)";

type AdminLevel = "country" | "state" | "county" | "city";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function mapNominatimType(item: Record<string, unknown>): AdminLevel {
  const addresstype = String(item.addresstype || "");
  const type = String(item.type || "");
  if (addresstype === "country" || type === "country") return "country";
  if (["state", "region", "province", "administrative"].includes(addresstype)) return "state";
  if (["county", "district"].includes(addresstype)) return "county";
  if (["city", "town", "municipality", "suburb"].includes(addresstype)) return "city";
  if (type === "administrative") {
    const rank = Number(item.place_rank || 0);
    if (rank <= 4) return "country";
    if (rank <= 8) return "state";
    if (rank <= 12) return "county";
    return "city";
  }
  return "city";
}

async function nominatimSearch(params: URLSearchParams) {
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const res = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ success: false, error: "Unauthorized" }, 401);

    const adminDb = createClient(supabaseUrl, serviceKey);
    const { data: roles } = await adminDb
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id);
    const isAdmin = (roles || []).some((r: { role: string }) => r.role === "admin");
    if (!isAdmin) return json({ success: false, error: "Admin only" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list_countries");

    if (action === "list_countries") {
      const { data, error } = await adminDb
        .from("official_admin_boundaries")
        .select("country_code, country_name")
        .eq("is_active", true)
        .eq("admin_level", "country")
        .order("country_name");
      if (error) throw error;
      const seen = new Set<string>();
      const countries = [];
      for (const row of data || []) {
        if (seen.has(row.country_code)) continue;
        seen.add(row.country_code);
        countries.push({ country_code: row.country_code, country_name: row.country_name });
      }
      // Always include common launch countries even before seed expansion
      for (const c of [
        { country_code: "SO", country_name: "Somalia" },
        { country_code: "GB", country_name: "United Kingdom" },
        { country_code: "UG", country_name: "Uganda" },
      ]) {
        if (!seen.has(c.country_code)) countries.push(c);
      }
      countries.sort((a, b) => a.country_name.localeCompare(b.country_name));
      return json({ success: true, countries });
    }

    if (action === "list_levels") {
      const countryCode = String(body.country_code || "").toUpperCase();
      const { data, error } = await adminDb
        .from("official_admin_boundaries")
        .select("admin_level")
        .eq("is_active", true)
        .eq("country_code", countryCode);
      if (error) throw error;
      const levels = Array.from(new Set((data || []).map((r: { admin_level: string }) => r.admin_level)));
      if (!levels.includes("country")) levels.unshift("country");
      return json({ success: true, levels });
    }

    if (action === "list_areas") {
      const countryCode = String(body.country_code || "").toUpperCase();
      const adminLevel = String(body.admin_level || "country") as AdminLevel;
      const { data, error } = await adminDb
        .from("official_admin_boundaries")
        .select("id, name, display_name, admin_level, country_code, point_count, bbox, osm_type, osm_id")
        .eq("is_active", true)
        .eq("country_code", countryCode)
        .eq("admin_level", adminLevel)
        .order("name");
      if (error) throw error;
      return json({ success: true, areas: data || [] });
    }

    if (action === "get_area") {
      const id = String(body.id || "");
      const { data, error } = await adminDb
        .from("official_admin_boundaries")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return json({ success: false, error: "Area not found" }, 404);
      return json({ success: true, area: data });
    }

    if (action === "search") {
      const query = String(body.query || "").trim();
      const countryCode = String(body.country_code || "").toUpperCase() || undefined;
      if (query.length < 2) return json({ success: false, error: "Query too short" }, 400);

      // Catalog first
      let catalogQ = adminDb
        .from("official_admin_boundaries")
        .select("id, name, display_name, admin_level, country_code, point_count, bbox, osm_type, osm_id, geojson")
        .eq("is_active", true)
        .or(`name.ilike.%${query}%,display_name.ilike.%${query}%`)
        .limit(8);
      if (countryCode) catalogQ = catalogQ.eq("country_code", countryCode);
      const { data: catalog } = await catalogQ;

      const params = new URLSearchParams({
        q: query,
        format: "json",
        polygon_geojson: "1",
        limit: "6",
        addressdetails: "1",
      });
      if (countryCode) params.set("countrycodes", countryCode.toLowerCase());

      let nominatim: Record<string, unknown>[] = [];
      try {
        nominatim = await nominatimSearch(params);
      } catch (e) {
        console.warn("nominatim_search_failed", String(e));
      }

      const results = [
        ...(catalog || []).map((row) => ({
          source: "catalog" as const,
          id: row.id,
          name: row.name,
          display_name: row.display_name,
          admin_level: row.admin_level,
          country_code: row.country_code,
          point_count: row.point_count,
          geojson: row.geojson,
          bbox: row.bbox,
        })),
        ...nominatim
          .filter((item) => item.geojson && ["Polygon", "MultiPolygon"].includes(String((item.geojson as { type?: string }).type)))
          .map((item) => ({
            source: "nominatim" as const,
            id: `osm:${item.osm_type}:${item.osm_id}`,
            name: String(item.name || item.display_name || "Area"),
            display_name: String(item.display_name || item.name || ""),
            admin_level: mapNominatimType(item),
            country_code: countryCode || null,
            point_count: null,
            geojson: item.geojson,
            bbox: item.boundingbox,
            osm_type: item.osm_type,
            osm_id: item.osm_id,
          })),
      ];

      return json({ success: true, results });
    }

    if (action === "import_to_catalog") {
      // Persist a Nominatim (or uploaded) boundary into the catalog for reuse
      const countryCode = String(body.country_code || "").toUpperCase();
      const countryName = String(body.country_name || countryCode);
      const adminLevel = String(body.admin_level || "city") as AdminLevel;
      const name = String(body.name || "").trim();
      const displayName = String(body.display_name || name);
      const geojson = body.geojson;
      const osmType = body.osm_type ? String(body.osm_type) : null;
      const osmId = body.osm_id != null ? Number(body.osm_id) : null;
      if (!countryCode || !name || !geojson) {
        return json({ success: false, error: "country_code, name, geojson required" }, 400);
      }
      const payload = {
        country_code: countryCode,
        country_name: countryName,
        admin_level: adminLevel,
        name,
        display_name: displayName,
        osm_type: osmType,
        osm_id: osmId,
        geojson,
        bbox: body.bbox ?? null,
        point_count: body.point_count ?? null,
        is_active: true,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = osmType && osmId != null
        ? await adminDb.from("official_admin_boundaries").upsert(payload, { onConflict: "osm_type,osm_id" }).select("*").single()
        : await adminDb.from("official_admin_boundaries").insert(payload).select("*").single();
      if (error) throw error;
      return json({ success: true, area: data });
    }

    return json({ success: false, error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("admin-official-boundaries", e);
    return json({ success: false, error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});
