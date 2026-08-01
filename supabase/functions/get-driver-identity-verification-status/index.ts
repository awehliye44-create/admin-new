/**
 * get-driver-identity-verification-status
 * Safe app-facing status only. Optional rate-limited reconciliation.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { applyIdentityDecision } from "../_shared/driverIdentity/applyDecision.ts";
import { mapInternalStatusToAppFacing } from "../_shared/driverIdentity/types.ts";
import { createDriverIdentityProvider } from "../_shared/driverIdentity/veriffProvider.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json(503, { ok: false, code: "CONFIG_MISSING" });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json(401, { ok: false, code: "AUTH_REQUIRED" });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const token = authHeader.slice("Bearer ".length);
  const { data: authData, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !authData.user) {
    return json(401, { ok: false, code: "AUTH_REQUIRED" });
  }

  let body: { verification_id?: string; reconcile?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const { data: driver } = await admin
    .from("drivers")
    .select("id, service_area_id")
    .eq("user_id", authData.user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!driver) return json(403, { ok: false, code: "DRIVER_NOT_FOUND" });

  let query = admin
    .from("driver_identity_verifications")
    .select(
      "id, status, reason, attempt_count, max_attempts, expires_at, decided_at, failure_code, provider, provider_session_id, updated_at",
    )
    .eq("driver_id", driver.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (body.verification_id) {
    query = admin
      .from("driver_identity_verifications")
      .select(
        "id, status, reason, attempt_count, max_attempts, expires_at, decided_at, failure_code, provider, provider_session_id, updated_at",
      )
      .eq("driver_id", driver.id)
      .eq("id", body.verification_id)
      .limit(1);
  }

  const { data: rows } = await query;
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    return json(200, {
      ok: true,
      code: "OK",
      status: null,
      app_state: "network_error",
      blocking: false,
    });
  }

  // Rate-limited reconciliation when processing and SDK may have finished.
  if (
    body.reconcile === true &&
    row.status === "processing" &&
    row.provider_session_id &&
    row.provider
  ) {
    const lastMetaKey = `reconcile:${row.id}`;
    void lastMetaKey;
    try {
      const provider = createDriverIdentityProvider(String(row.provider));
      const decision = await provider.getDecision(String(row.provider_session_id));
      await applyIdentityDecision({
        supabase: admin,
        verificationId: row.id,
        driverId: driver.id,
        fromStatus: row.status,
        decision: decision.decision,
        livenessResult: decision.livenessResult,
        faceMatchResult: decision.faceMatchResult,
        imageQualityResult: decision.imageQualityResult,
        failureCode: decision.failureCode,
        decidedAt: decision.decidedAt,
        source: "reconcile",
      });
      const { data: refreshed } = await admin
        .from("driver_identity_verifications")
        .select(
          "id, status, reason, attempt_count, max_attempts, expires_at, decided_at, failure_code, provider, updated_at",
        )
        .eq("id", row.id)
        .maybeSingle();
      if (refreshed) Object.assign(row, refreshed);
    } catch (error) {
      console.error(
        "[get-driver-identity-verification-status] reconcile",
        error instanceof Error ? error.message : "error",
      );
    }
  }

  const { data: gate } = await admin.rpc("get_driver_identity_verification_gate", {
    p_driver_id: driver.id,
  });

  return json(200, {
    ok: true,
    code: (gate as { code?: string } | null)?.code ?? "OK",
    verification_id: row.id,
    status: row.status,
    app_state: mapInternalStatusToAppFacing(row.status),
    reason: row.reason,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    expires_at: row.expires_at,
    decided_at: row.decided_at,
    failure_code: row.failure_code,
    blocking: Boolean((gate as { blocking?: boolean } | null)?.blocking),
    dispatch_blocked: Boolean(
      (gate as { dispatch_blocked?: boolean } | null)?.dispatch_blocked,
    ),
  });
});
