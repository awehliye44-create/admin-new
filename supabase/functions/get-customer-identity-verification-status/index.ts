import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getServiceSupabase } from "../_shared/customerIdentityVeriff.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function mapAppState(status: string | null | undefined): string {
  switch (status) {
    case "approved":
      return "approved";
    case "declined":
      return "rejected";
    case "resubmission_requested":
      return "retry_required";
    case "expired":
    case "abandoned":
      return "expired";
    case "processing":
    case "submitted":
      return "manual_review";
    case "error":
      return "network_error";
    case "started":
    default:
      return "required";
  }
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
      verification_id?: string | null;
      service_area_id?: string | null;
    };

    const service = getServiceSupabase();
    const { data: customer } = await service
      .from("customers")
      .select("id, identity_verified_at, name_edit_locked")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!customer) {
      return json({ ok: false, code: "NO_PROFILE" }, 404);
    }

    if (customer.identity_verified_at) {
      return json({
        ok: true,
        code: "OK",
        status: "approved",
        app_state: "approved",
        verified: true,
        name_edit_locked: customer.name_edit_locked === true,
        identity_verified_at: customer.identity_verified_at,
      });
    }

    let query = service
      .from("customer_identity_verifications")
      .select(
        "id, status, attempt_count, max_attempts, expires_at, decided_at, failure_code, provider_session_id",
      )
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false })
      .limit(1);

    if (body.verification_id) {
      query = service
        .from("customer_identity_verifications")
        .select(
          "id, status, attempt_count, max_attempts, expires_at, decided_at, failure_code, provider_session_id",
        )
        .eq("customer_id", customer.id)
        .eq("id", body.verification_id)
        .limit(1);
    }

    const { data: rows } = await query;
    const row = rows?.[0] ?? null;

    if (!row) {
      return json({
        ok: true,
        code: "OK",
        status: null,
        app_state: "required",
        verified: false,
        name_edit_locked: false,
      });
    }

    return json({
      ok: true,
      code: "OK",
      verification_id: row.id,
      status: row.status,
      app_state: mapAppState(row.status),
      attempt_count: row.attempt_count,
      max_attempts: row.max_attempts,
      expires_at: row.expires_at,
      decided_at: row.decided_at,
      failure_code: row.failure_code,
      verified: false,
      name_edit_locked: false,
    });
  } catch (e) {
    console.error("[get-customer-identity-status] unexpected", e);
    return json({
      ok: false,
      code: "INTERNAL",
      message: e instanceof Error ? e.message : "unexpected_error",
    }, 500);
  }
});
