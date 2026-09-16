/**
 * Resolve active service areas for a corporate address/postcode.
 * Country is geocoded server-side; catalogue is regions.country_code scoped.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";
import { geocodeCorporateAddress } from "../_shared/corporateAddressGeocode.ts";
import {
  CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
  normalizeIsoCountryCode,
} from "../../../shared/corporateServiceAreaCountrySSOT.ts";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const address = String(body.address ?? "").trim();
    if (address.length < 2) {
      return jsonResponse({
        success: true,
        country_code: null,
        service_areas: [],
        unavailable: false,
        message: "Enter a company address or postcode to see service areas.",
      });
    }

    const geo = await geocodeCorporateAddress(address);
    const countryCode = normalizeIsoCountryCode(geo?.countryCode);
    if (!geo || !countryCode) {
      return jsonResponse({
        success: true,
        country_code: null,
        service_areas: [],
        unavailable: true,
        message: CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase.rpc("get_corporate_service_areas_for_country", {
      p_country_code: countryCode,
      p_latitude: geo.latitude,
      p_longitude: geo.longitude,
    });

    if (error) {
      console.error("[corporate-service-area-options] rpc", error);
      return jsonResponse({ success: false, error: "Could not load service areas." }, 500);
    }

    const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const areas = Array.isArray(payload.service_areas) ? payload.service_areas : [];
    const unavailable = areas.length === 0;

    return jsonResponse({
      success: true,
      country_code: countryCode,
      latitude: geo.latitude,
      longitude: geo.longitude,
      formatted_address: geo.formattedAddress,
      city: geo.city,
      service_areas: areas,
      unavailable,
      message: unavailable ? CORPORATE_SERVICE_UNAVAILABLE_MESSAGE : null,
    });
  } catch (err) {
    console.error("[corporate-service-area-options]", err);
    return jsonResponse({ success: false, error: "Internal error" }, 500);
  }
});
