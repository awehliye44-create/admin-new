/**
 * One-time service-area assignment for an existing corporate account.
 * Country is geocoded from the company address — not taken from the client.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";
import { geocodeCorporateAddress } from "../_shared/corporateAddressGeocode.ts";
import {
  CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
  SERVICE_AREA_COUNTRY_MISMATCH,
  assertServiceAreaCountryMatch,
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

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ success: false, error: "Not authenticated" }, 401);
  }

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const corporateAccountId = String(body.corporate_account_id ?? "").trim();
    const serviceAreaId = String(body.service_area_id ?? "").trim();
    const addressFromClient = String(body.address ?? "").trim();

    if (!corporateAccountId || !serviceAreaId) {
      return jsonResponse({ success: false, error: "corporate_account_id and service_area_id are required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const anon = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await anon.auth.getUser();
    if (!user?.id) {
      return jsonResponse({ success: false, error: "Not authenticated" }, 401);
    }

    const service = createClient(supabaseUrl, serviceKey);

    const { data: membership } = await service
      .from("corporate_user_accounts")
      .select("role")
      .eq("user_id", user.id)
      .eq("corporate_account_id", corporateAccountId)
      .maybeSingle();

    if (!membership || membership.role !== "admin") {
      return jsonResponse({ success: false, error: "Not authorised for this corporate account" }, 403);
    }

    const { data: account, error: accountErr } = await service
      .from("corporate_accounts")
      .select("id, service_area_id, address, country_code")
      .eq("id", corporateAccountId)
      .maybeSingle();

    if (accountErr || !account) {
      return jsonResponse({ success: false, error: "Corporate account not found" }, 404);
    }
    if (account.service_area_id) {
      return jsonResponse({ success: false, error: "Service area already set for this account" }, 409);
    }

    const address = addressFromClient || String(account.address ?? "").trim();
    if (address.length < 2) {
      return jsonResponse({
        success: false,
        error: "Enter a company address or postcode to continue.",
        code: "ADDRESS_REQUIRED",
      }, 400);
    }

    const geo = await geocodeCorporateAddress(address);
    const countryCode = normalizeIsoCountryCode(geo?.countryCode);
    if (!geo || !countryCode) {
      return jsonResponse({
        success: false,
        error: CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
        code: "SERVICE_UNAVAILABLE",
      }, 400);
    }

    const { data: sa, error: saErr } = await service
      .from("service_areas")
      .select("id, region_id, is_active, regions!inner(id, country_code, currency_code)")
      .eq("id", serviceAreaId)
      .eq("is_active", true)
      .maybeSingle();

    if (saErr || !sa) {
      return jsonResponse({ success: false, error: "Invalid or inactive service area" }, 400);
    }

    const region = (Array.isArray(sa.regions) ? sa.regions[0] : sa.regions) as {
      country_code?: string;
      currency_code?: string;
    } | null;
    const saCountry = normalizeIsoCountryCode(region?.country_code);
    try {
      assertServiceAreaCountryMatch(countryCode, saCountry);
    } catch {
      return jsonResponse({
        success: false,
        error: CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
        code: SERVICE_AREA_COUNTRY_MISMATCH,
      }, 400);
    }

    const { error: updateErr } = await service
      .from("corporate_accounts")
      .update({
        service_area_id: serviceAreaId,
        region_id: sa.region_id,
        country_code: countryCode,
        address,
        city: geo.city ?? undefined,
        country: countryCode,
      })
      .eq("id", corporateAccountId)
      .is("service_area_id", null);

    if (updateErr) {
      console.error("[set-corporate-service-area] update", updateErr);
      const msg = String(updateErr.message ?? "");
      if (msg.includes(SERVICE_AREA_COUNTRY_MISMATCH)) {
        return jsonResponse({
          success: false,
          error: CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
          code: SERVICE_AREA_COUNTRY_MISMATCH,
        }, 400);
      }
      return jsonResponse({ success: false, error: "Could not save service area" }, 500);
    }

    return jsonResponse({
      success: true,
      service_area_id: serviceAreaId,
      country_code: countryCode,
      region_id: sa.region_id,
      currency_code: region?.currency_code ?? null,
    });
  } catch (err) {
    console.error("[set-corporate-service-area]", err);
    return jsonResponse({ success: false, error: "Internal error" }, 500);
  }
});
