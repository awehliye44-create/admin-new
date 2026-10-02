import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  getServiceSupabase,
  loadCustomerIdentitySettings,
  resolveCustomerIdentityServiceAreaId,
} from "../_shared/customerIdentityVeriff.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/** Statuses that permanently consume an attempt slot. */
const CONSUMED_ATTEMPT_STATUSES = [
  "submitted",
  "approved",
  "declined",
  "rejected",
  "expired",
  "abandoned",
  "resubmission_requested",
  "review",
  "manual_review",
] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const anon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const {
      data: { user },
      error: userError,
    } = await anon.auth.getUser();
    if (userError || !user) {
      return json({ ok: false, code: "UNAUTHENTICATED" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as {
      service_area_id?: string | null;
      device_id?: string | null;
    };

    const service = getServiceSupabase();
    const { data: customer, error: customerError } = await service
      .from("customers")
      .select("id, first_name, last_name, identity_verified_at")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (customerError || !customer) {
      return json({ ok: false, code: "NO_PROFILE", message: "Customer profile not found." }, 404);
    }

    if (customer.identity_verified_at) {
      return json({
        ok: false,
        code: "ALREADY_VERIFIED",
        message: "Your identity is already verified.",
        status: "approved",
      });
    }

    const preferred =
      typeof body.service_area_id === "string" && body.service_area_id.trim()
        ? body.service_area_id.trim()
        : null;
    const serviceAreaId = await resolveCustomerIdentityServiceAreaId(
      service,
      customer.id,
      preferred,
    );

    if (!serviceAreaId) {
      return json({
        ok: false,
        code: "FEATURE_OFF",
        message: "Identity verification is not available in your area yet.",
      });
    }

    const settings = await loadCustomerIdentitySettings(service, serviceAreaId);
    if (!settings || settings.mode === "off") {
      return json({
        ok: false,
        code: "FEATURE_OFF",
        message: "Identity verification is turned off for this area.",
      });
    }

    // Reuse an open capture session so retries do not burn the attempt budget.
    const nowIso = new Date().toISOString();
    const { data: openRow } = await service
      .from("customer_identity_verifications")
      .select(
        "id, expires_at, attempt_count, document_type, id_front_path, id_back_path, selfie_path",
      )
      .eq("customer_id", customer.id)
      .eq("status", "started")
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (openRow) {
      return json({
        ok: true,
        code: "OK",
        verification_id: openRow.id,
        customer_id: customer.id,
        status: "started",
        provider: "manual",
        expires_at: openRow.expires_at,
        attempt_count: openRow.attempt_count,
        document_type: openRow.document_type,
        reused: true,
      });
    }

    const { count: attemptCount } = await service
      .from("customer_identity_verifications")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customer.id)
      .in("status", [...CONSUMED_ATTEMPT_STATUSES]);

    const attempts = attemptCount ?? 0;
    if (attempts >= settings.maximum_attempts) {
      return json({
        ok: false,
        code: "MAX_ATTEMPTS",
        message: "You have reached the maximum number of verification attempts.",
        attempt_count: attempts,
        max_attempts: settings.maximum_attempts,
      });
    }

    const { data: verification, error: insertError } = await service
      .from("customer_identity_verifications")
      .insert({
        customer_id: customer.id,
        service_area_id: serviceAreaId,
        provider: "manual",
        status: "started",
        reason: settings.mode === "mandatory" ? "customer_mandatory" : "customer_optional",
        attempt_count: attempts + 1,
        max_attempts: settings.maximum_attempts,
        started_at: new Date().toISOString(),
        expires_at: new Date(
          Date.now() + settings.session_expiry_minutes * 60_000,
        ).toISOString(),
        device_id: body.device_id ?? null,
        metadata: { mode: settings.mode, capture: "in_app" },
      })
      .select("id, expires_at, attempt_count")
      .single();

    if (insertError || !verification) {
      console.warn("[start-customer-identity] insert failed", insertError);
      return json({
        ok: false,
        code: "SAVE_FAILED",
        message: "Could not start verification.",
      }, 500);
    }

    return json({
      ok: true,
      code: "OK",
      verification_id: verification.id,
      customer_id: customer.id,
      status: "started",
      provider: "manual",
      expires_at: verification.expires_at,
      attempt_count: verification.attempt_count,
    });
  } catch (e) {
    console.error("[start-customer-identity] unexpected", e);
    return json({
      ok: false,
      code: "INTERNAL",
      message: e instanceof Error ? e.message : "unexpected_error",
    }, 500);
  }
});
