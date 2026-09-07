/**
 * Public edge: resolve driver signup location options + service areas.
 * Pre-auth safe (verify_jwt = false). Uses service_role only server-side.
 * Detection priority: manual country → GPS → trusted IP → phone dial.
 * Suggestion only — does not persist region assignment.
 *
 * Phase 2C: also loads get_driver_signup_service_areas for each returned
 * region so the Driver app can use one Edge call (no direct SECDEF RPCs).
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  guessCountryFromCoordinates,
  normalizeSignupCountryCode,
  phoneDialToIsoCountry,
  resolveDetectionSource,
  type DriverSignupDetectionSource,
} from "../../../shared/driverSignupLocationSSOT.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-onecab-native-client",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

/** Soft in-memory rate limit (per isolate). Public catalogue endpoint. */
const rateWindowMs = 60_000;
const rateLimitMax = 40;
const rateHits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim() || "unknown";
  return req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
}

function allowRequest(req: Request): { ok: true } | { ok: false; retryAfter: number } {
  const key = clientIp(req);
  const now = Date.now();
  let entry = rateHits.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + rateWindowMs };
  }
  entry.count += 1;
  rateHits.set(key, entry);
  if (entry.count > rateLimitMax) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...(extraHeaders ?? {}),
    },
  });
}

function readTrustedIpCountry(req: Request): string | null {
  const headers = req.headers;
  const candidates = [
    headers.get("cf-ipcountry"),
    headers.get("x-vercel-ip-country"),
    headers.get("x-country-code"),
    headers.get("x-geo-country"),
  ];
  for (const raw of candidates) {
    const iso = normalizeSignupCountryCode(raw);
    if (iso && iso !== "XX" && iso !== "T1") {
      return iso === "UK" ? "GB" : iso;
    }
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = asObject(value);
  if (!obj) return [];
  if (Array.isArray(obj.service_areas)) return obj.service_areas;
  if (Array.isArray(obj.areas)) return obj.areas;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

/** Public catalogue fields only — never leak internal config/secrets. */
function sanitizeRegion(raw: unknown): Record<string, unknown> | null {
  const row = asObject(raw);
  if (!row || typeof row.id !== "string") return null;
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : null,
    country_code: typeof row.country_code === "string" ? row.country_code : null,
    display_order: typeof row.display_order === "number" ? row.display_order : 0,
  };
}

function sanitizeServiceArea(raw: unknown, fallbackRegionId: string): Record<string, unknown> | null {
  const row = asObject(raw);
  if (!row || typeof row.id !== "string") return null;
  if (row.is_active === false || row.active === false || row.archived === true) return null;
  if (row.driver_signup_enabled === false || row.signup_enabled === false) return null;
  const regionId =
    (typeof row.region_id === "string" && row.region_id)
    || (typeof row.driving_region_id === "string" && row.driving_region_id)
    || fallbackRegionId;
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : null,
    region_id: regionId,
    display_order: typeof row.display_order === "number" ? row.display_order : 0,
    is_active: true,
    driver_signup_enabled: true,
  };
}

function sanitizeDetectedRegion(raw: unknown): Record<string, unknown> | null {
  const row = asObject(raw);
  if (!row || typeof row.id !== "string") return null;
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : null,
    country_code: typeof row.country_code === "string" ? row.country_code : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const limited = allowRequest(req);
  if (!limited.ok) {
    return jsonResponse(
      {
        success: false,
        error: "RATE_LIMIT_EXCEEDED",
        regions: [],
        service_areas: [],
        detection_source: "none",
      },
      429,
      { "Retry-After": String(limited.retryAfter) },
    );
  }

  try {
    const body = req.method === "POST"
      ? await req.json().catch(() => ({}))
      : {};
    const bodyObj = asObject(body) ?? {};

    const latitude = typeof bodyObj.latitude === "number" ? bodyObj.latitude : null;
    const longitude = typeof bodyObj.longitude === "number" ? bodyObj.longitude : null;
    const phoneRaw = bodyObj.phone_country_code ?? bodyObj.country_code ?? null;
    const phoneIso = phoneDialToIsoCountry(
      typeof phoneRaw === "string" ? phoneRaw : null,
    );
    let overrideIso = normalizeSignupCountryCode(
      typeof bodyObj.country_code === "string" && !String(bodyObj.country_code).startsWith("+")
        ? bodyObj.country_code
        : null,
    );
    if (overrideIso === "UK") overrideIso = "GB";

    const ipIso = readTrustedIpCountry(req);
    const hasGps = latitude != null && longitude != null
      && Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90
      && longitude >= -180 && longitude <= 180;
    const gpsIso = hasGps ? guessCountryFromCoordinates(latitude!, longitude!) : null;

    let countryCode: string | null = null;
    let detection_source: DriverSignupDetectionSource = "none";

    if (bodyObj.manual_country === true && overrideIso) {
      countryCode = overrideIso;
      detection_source = "none";
    } else if (gpsIso) {
      countryCode = gpsIso;
      detection_source = "gps";
    } else if (ipIso) {
      countryCode = ipIso;
      detection_source = "ip";
    } else if (phoneIso) {
      countryCode = phoneIso;
      detection_source = "phone";
    } else if (overrideIso) {
      countryCode = overrideIso;
      detection_source = resolveDetectionSource({
        hasGps: false,
        hasIpCountry: false,
        hasPhoneCountry: false,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await supabase.rpc("get_driver_signup_location_options", {
      p_latitude: hasGps ? latitude : null,
      p_longitude: hasGps ? longitude : null,
      p_country_code: countryCode,
    });

    if (error) {
      console.error("get_driver_signup_location_options failed", error.code ?? error.message);
      return jsonResponse({
        success: false,
        error: "LOCATION_OPTIONS_UNAVAILABLE",
        detected_country_code: countryCode,
        detected_region: null,
        regions: [],
        service_areas: [],
        detection_source,
        unavailable_reason: "RPC_UNAVAILABLE",
      }, 500);
    }

    const payload = asObject(data) ?? {};
    const rawRegions = Array.isArray(payload.regions) ? payload.regions : [];
    let regions = rawRegions
      .map((r) => sanitizeRegion(r))
      .filter((r): r is Record<string, unknown> => Boolean(r));

    // Overlay Admin Region Name SSOT (`regions.name`) when available.
    const regionIds = regions.map((r) => String(r.id));
    if (regionIds.length > 0) {
      const { data: nameRows } = await supabase
        .from("regions")
        .select("id, name")
        .in("id", regionIds)
        .eq("signup_enabled", true);
      const nameById = new Map<string, string>();
      for (const row of nameRows ?? []) {
        const id = typeof row?.id === "string" ? row.id : null;
        const name = typeof row?.name === "string" ? row.name.trim() : "";
        if (id && name) nameById.set(id, name);
      }
      regions = regions.map((r) => {
        const overlay = nameById.get(String(r.id));
        return overlay ? { ...r, name: overlay } : r;
      });
    }

    const service_areas: Record<string, unknown>[] = [];
    for (const region of regions) {
      const regionId = String(region.id);
      const { data: areaRaw, error: areaErr } = await supabase.rpc(
        "get_driver_signup_service_areas",
        { p_region_id: regionId },
      );
      if (areaErr) {
        console.error("get_driver_signup_service_areas failed", regionId, areaErr.code ?? areaErr.message);
        continue;
      }
      for (const item of asList(areaRaw)) {
        const area = sanitizeServiceArea(item, regionId);
        if (area) service_areas.push(area);
      }
    }

    const unavailable_reason =
      typeof payload.unavailable_reason === "string" ? payload.unavailable_reason : null;

    return jsonResponse({
      success: true,
      detected_country_code: typeof payload.detected_country_code === "string"
        ? payload.detected_country_code
        : countryCode,
      detected_region: sanitizeDetectedRegion(payload.detected_region),
      regions,
      service_areas,
      detection_source,
      unavailable: regions.length === 0,
      unavailable_reason: regions.length === 0
        ? (unavailable_reason || (countryCode ? "NO_SIGNUP_REGION_IN_AREA" : "COUNTRY_REQUIRED"))
        : null,
    });
  } catch (err) {
    console.error("driver-signup-location-options", err instanceof Error ? err.message : err);
    return jsonResponse({
      success: false,
      error: "INTERNAL_ERROR",
      regions: [],
      service_areas: [],
      detection_source: "none",
      unavailable_reason: "INTERNAL_ERROR",
    }, 500);
  }
});
