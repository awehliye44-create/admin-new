/**
 * Public edge: resolve driver signup location options.
 * Detection priority: GPS coords (caller) → trusted IP country → phone dial fallback.
 * Suggestion only — does not persist region assignment.
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
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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
    if (iso && iso !== "XX" && iso !== "T1") return iso;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const body = req.method === "POST"
      ? await req.json().catch(() => ({}))
      : {};
    const latitude = typeof body.latitude === "number" ? body.latitude : null;
    const longitude = typeof body.longitude === "number" ? body.longitude : null;
    const phoneRaw = body.phone_country_code ?? body.country_code ?? null;
    const phoneIso = phoneDialToIsoCountry(
      typeof phoneRaw === "string" ? phoneRaw : null,
    );
    const overrideIso = normalizeSignupCountryCode(
      typeof body.country_code === "string" && !String(body.country_code).startsWith("+")
        ? body.country_code
        : null,
    );

    const ipIso = readTrustedIpCountry(req);
    const hasGps = latitude != null && longitude != null
      && Number.isFinite(latitude) && Number.isFinite(longitude);
    const gpsIso = hasGps ? guessCountryFromCoordinates(latitude, longitude) : null;

    // Explicit manual country picker override.
    let countryCode: string | null = null;
    let detection_source: DriverSignupDetectionSource = "none";

    if (body.manual_country === true && overrideIso) {
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
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data, error } = await supabase.rpc("get_driver_signup_location_options", {
      p_latitude: hasGps ? latitude : null,
      p_longitude: hasGps ? longitude : null,
      p_country_code: countryCode,
    });

    if (error) {
      console.error("get_driver_signup_location_options failed", error);
      return jsonResponse({
        success: false,
        error: error.message,
        detected_country_code: countryCode,
        detected_region: null,
        regions: [],
        service_areas: [],
        detection_source,
      }, 500);
    }

    const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const regions = Array.isArray(payload.regions) ? payload.regions : [];

    return jsonResponse({
      success: true,
      ...payload,
      regions,
      service_areas: [],
      detection_source,
      unavailable: regions.length === 0,
    });
  } catch (err) {
    console.error("driver-signup-location-options", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : "INTERNAL_ERROR",
      regions: [],
      service_areas: [],
      detection_source: "none",
    }, 500);
  }
});
