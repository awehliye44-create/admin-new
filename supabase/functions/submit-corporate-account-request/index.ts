import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  checkRateLimit,
  getClientIP,
  nativeAppCorsHeaders as corsHeaders,
} from "../_shared/security.ts";
import { normalizeOnboardingPhone, isValidOnboardingPhone } from "../_shared/onboardingValidation.ts";
import { geocodeCorporateAddress } from "../_shared/corporateAddressGeocode.ts";
import {
  CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
  SERVICE_AREA_COUNTRY_MISMATCH,
  assertServiceAreaCountryMatch,
  normalizeIsoCountryCode,
} from "../../../shared/corporateServiceAreaCountrySSOT.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 16_384;

type SubmitBody = Record<string, unknown>;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sanitizeText(value: unknown, maxLen: number): string {
  return String(value ?? "").trim().slice(0, maxLen);
}

function sanitizeOptionalInt(value: unknown, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.floor(n);
}

function parseSubmitBody(raw: SubmitBody) {
  const company_name = sanitizeText(raw.company_name, 200);
  const contact_name = sanitizeText(raw.contact_name, 120);
  const contact_email = sanitizeText(raw.contact_email, 254).toLowerCase();
  const contact_phone = sanitizeText(raw.contact_phone, 32);
  const address = sanitizeText(raw.address, 500);
  const city = sanitizeText(raw.city, 120);
  const country = sanitizeText(raw.country, 80);
  const tax_id = sanitizeText(raw.tax_id, 64);
  const notes = sanitizeText(raw.notes, 2000);
  const employee_count = sanitizeOptionalInt(raw.employee_count, 1_000_000);
  const estimated_monthly_trips = sanitizeOptionalInt(raw.estimated_monthly_trips, 1_000_000);
  const region_id = sanitizeText(raw.region_id, 64);
  const service_area_id = sanitizeText(raw.service_area_id, 64);

  const errors: string[] = [];
  if (!company_name) errors.push("company_name_required");
  if (!contact_name) errors.push("contact_name_required");
  if (!contact_email || !EMAIL_RE.test(contact_email)) errors.push("contact_email_invalid");

  if (contact_phone && !isValidOnboardingPhone(normalizeOnboardingPhone(contact_phone))) {
    errors.push("contact_phone_invalid");
  }

  return {
    ok: errors.length === 0,
    errors,
    row: {
      company_name,
      contact_name,
      contact_email,
      contact_phone: contact_phone ? normalizeOnboardingPhone(contact_phone) : null,
      address: address || null,
      city: city || null,
      country: country || null,
      tax_id: tax_id || null,
      employee_count,
      estimated_monthly_trips,
      notes: notes || null,
      region_id: region_id || null,
      service_area_id: service_area_id || null,
      status: "pending" as const,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Payload too large" }, 413);
  }

  const clientIp = getClientIP(req);
  const rate = checkRateLimit(clientIp, {
    keyPrefix: "submit-corporate-account-request",
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!rate.allowed) {
    return jsonResponse(
      { error: "Too many requests. Please try again later.", code: "RATE_LIMITED" },
      429,
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const rawText = await req.text();
    if (rawText.length > MAX_BODY_BYTES) {
      return jsonResponse({ error: "Payload too large" }, 413);
    }

    let body: SubmitBody;
    try {
      body = JSON.parse(rawText) as SubmitBody;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    // Reject client attempts to set privileged columns.
    for (const forbidden of [
      "status",
      "user_id",
      "reviewed_at",
      "reviewed_by",
      "rejection_reason",
      "approved_at",
      "suspended_at",
      "id",
      "created_at",
      "updated_at",
      "country_code",
    ]) {
      if (forbidden in body) {
        delete body[forbidden];
      }
    }

    const parsed = parseSubmitBody(body);
    if (!parsed.ok) {
      return jsonResponse({ error: "Validation failed", codes: parsed.errors }, 400);
    }

    const addressText = parsed.row.address ?? "";
    const requestedSaId = parsed.row.service_area_id;

    if (requestedSaId && addressText.length < 2) {
      return jsonResponse({
        error: "Enter a company address or postcode to select a service area.",
        code: "ADDRESS_REQUIRED",
      }, 400);
    }

    const service = createClient(supabaseUrl, serviceKey);

    let resolvedCountry = normalizeIsoCountryCode(parsed.row.country);
    let resolvedCity = parsed.row.city;
    let resolvedRegionId = parsed.row.region_id;

    if (addressText.length >= 2) {
      const geo = await geocodeCorporateAddress(addressText);
      resolvedCountry = normalizeIsoCountryCode(geo?.countryCode) ?? resolvedCountry;
      if (geo?.city && !resolvedCity) resolvedCity = geo.city;
    }

    if (requestedSaId) {
      if (!resolvedCountry) {
        return jsonResponse({
          error: CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
          code: "SERVICE_UNAVAILABLE",
        }, 400);
      }

      const { data: sa, error: saErr } = await service
        .from("service_areas")
        .select("id, region_id, is_active, regions!inner(country_code)")
        .eq("id", requestedSaId)
        .eq("is_active", true)
        .maybeSingle();

      if (saErr || !sa) {
        return jsonResponse({ error: "Invalid or inactive service area" }, 400);
      }

      const region = (Array.isArray(sa.regions) ? sa.regions[0] : sa.regions) as {
        country_code?: string;
      } | null;
      try {
        assertServiceAreaCountryMatch(resolvedCountry, region?.country_code);
      } catch {
        return jsonResponse({
          error: CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
          code: SERVICE_AREA_COUNTRY_MISMATCH,
        }, 400);
      }
      resolvedRegionId = String(sa.region_id);
    }

    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const anon = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await anon.auth.getUser();
      if (user?.id) {
        const jwtEmail = String(user.email ?? "").trim().toLowerCase();
        if (jwtEmail && jwtEmail !== parsed.row.contact_email) {
          return jsonResponse(
            { error: "Contact email must match your signed-in account.", code: "EMAIL_MISMATCH" },
            403,
          );
        }
        userId = user.id;
      }
    }

    const insertRow = {
      ...parsed.row,
      city: resolvedCity,
      country: resolvedCountry,
      country_code: resolvedCountry,
      region_id: resolvedRegionId,
      user_id: userId,
    };

    const { data, error } = await service
      .from("corporate_account_requests")
      .insert(insertRow)
      .select("id, status, created_at")
      .single();

    if (error) {
      console.error("[submit-corporate-account-request] insert error:", error);
      return jsonResponse({ error: "Could not submit request. Please try again." }, 500);
    }

    return jsonResponse({
      success: true,
      request_id: data.id,
      status: data.status,
      created_at: data.created_at,
    });
  } catch (err) {
    console.error("[submit-corporate-account-request] error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
