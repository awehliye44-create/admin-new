/**
 * start-driver-identity-verification
 * Creates Veriff Selfie2Selfie session server-side. Never trusts client device_id.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { createDriverIdentityProvider } from "../_shared/driverIdentity/veriffProvider.ts";
import {
  downloadDriverDocumentBytes,
  resolveTrustedIdentityReference,
} from "../_shared/driverIdentity/resolveTrustedReference.ts";

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
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json(503, { ok: false, code: "CONFIG_MISSING" });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json(401, { ok: false, code: "AUTH_REQUIRED" });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(supabaseUrl, serviceKey);

  const token = authHeader.slice("Bearer ".length);
  const { data: authData, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !authData.user) {
    return json(401, { ok: false, code: "AUTH_REQUIRED" });
  }
  const userId = authData.user.id;

  const { data: driver, error: driverErr } = await admin
    .from("drivers")
    .select("id, first_name, last_name, service_area_id, approval_status, driver_status, current_trip_id")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (driverErr || !driver) {
    return json(403, { ok: false, code: "DRIVER_NOT_FOUND" });
  }

  if (String(driver.approval_status || "").toLowerCase() !== "approved") {
    return json(403, { ok: false, code: "DRIVER_NOT_APPROVED" });
  }

  if (!driver.service_area_id) {
    return json(400, { ok: false, code: "DRIVER_SERVICE_AREA_NOT_ASSIGNED" });
  }

  const { data: settings } = await admin
    .from("service_area_identity_verification_settings")
    .select("*")
    .eq("service_area_id", driver.service_area_id)
    .maybeSingle();

  if (!settings?.enabled) {
    return json(400, { ok: false, code: "IDENTITY_VERIFICATION_NOT_ENABLED" });
  }

  // Existing active verification?
  const { data: existing } = await admin
    .from("driver_identity_verifications")
    .select("*")
    .eq("driver_id", driver.id)
    .in("status", [
      "required",
      "deferred_active_work",
      "started",
      "processing",
      "manual_review",
      "reference_unavailable",
    ])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!existing) {
    return json(400, {
      ok: false,
      code: "IDENTITY_VERIFICATION_NOT_REQUIRED",
      message: "No active identity verification requirement.",
    });
  }

  const maxAttempts = settings.maximum_attempts ?? existing.max_attempts ?? 3;
  if ((existing.attempt_count ?? 0) >= maxAttempts) {
    return json(429, {
      ok: false,
      code: "IDENTITY_VERIFICATION_MAX_ATTEMPTS",
      verification_id: existing.id,
    });
  }

  const { data: hasWork } = await admin.rpc(
    "driver_has_accepted_active_or_stacked_work",
    { p_driver_id: driver.id },
  );

  if (hasWork === true && settings.active_work_deferral_enabled !== false) {
    await admin
      .from("driver_identity_verifications")
      .update({
        status: "deferred_active_work",
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .eq("driver_id", driver.id);

    return json(200, {
      ok: true,
      code: "IDENTITY_VERIFICATION_DEFERRED_ACTIVE_WORK",
      status: "deferred_active_work",
      verification_id: existing.id,
    });
  }

  // Canonical device identity: active push_tokens.device_id for this driver.
  // Never trust a client-supplied device_id.
  const { data: tokenRow } = await admin
    .from("push_tokens")
    .select("device_id")
    .eq("driver_id", driver.id)
    .eq("is_active", true)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const canonicalDeviceId =
    typeof tokenRow?.device_id === "string" && tokenRow.device_id.trim()
      ? tokenRow.device_id.trim()
      : null;

  const reference = await resolveTrustedIdentityReference(admin, {
    driverId: driver.id,
    userId,
  });

  if (reference.status === "unavailable") {
    await admin
      .from("driver_identity_verifications")
      .update({
        status: "reference_unavailable",
        failure_code: reference.reason,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(existing.metadata && typeof existing.metadata === "object"
            ? existing.metadata
            : {}),
          reference_reason: reference.reason,
        },
      })
      .eq("id", existing.id);

    await admin.from("driver_identity_verification_events").insert({
      verification_id: existing.id,
      driver_id: driver.id,
      actor_user_id: userId,
      actor_role: "driver",
      event_type: "reference_unavailable",
      from_status: existing.status,
      to_status: "reference_unavailable",
      reason: reference.reason,
    });

    return json(200, {
      ok: false,
      code: "IDENTITY_REFERENCE_UNAVAILABLE",
      status: "reference_unavailable",
      verification_id: existing.id,
    });
  }

  const downloaded = await downloadDriverDocumentBytes(
    admin,
    reference.privateObjectPath,
  );
  if (!downloaded) {
    return json(200, {
      ok: false,
      code: "IDENTITY_REFERENCE_UNAVAILABLE",
      status: "reference_unavailable",
      verification_id: existing.id,
    });
  }

  const providerName = String(settings.provider || "veriff");
  const provider = createDriverIdentityProvider(providerName);
  const expiryMinutes = settings.session_expiry_minutes ?? 30;

  let session;
  try {
    session = await provider.createSession({
      driverId: driver.id,
      endUserId: userId,
      firstName: driver.first_name,
      lastName: driver.last_name,
      vendorData: existing.id,
      workflowId: settings.provider_workflow_id,
      reference,
      referenceImageBytes: downloaded.bytes,
      referenceContentType: downloaded.contentType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider_error";
    console.error("[start-driver-identity-verification] provider", message);
    return json(502, { ok: false, code: "PROVIDER_SESSION_FAILED" });
  }

  const expiresAt = new Date(Date.now() + expiryMinutes * 60_000).toISOString();
  const { data: updated, error: updErr } = await admin
    .from("driver_identity_verifications")
    .update({
      provider: session.provider,
      provider_session_id: session.providerSessionId,
      status: "started",
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
      attempt_count: (existing.attempt_count ?? 0) + 1,
      max_attempts: maxAttempts,
      device_id: canonicalDeviceId,
      service_area_id: driver.service_area_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id)
    .eq("driver_id", driver.id)
    .select("id, status, attempt_count")
    .maybeSingle();

  if (updErr || !updated) {
    // Unique active / session race
    return json(409, { ok: false, code: "IDENTITY_VERIFICATION_CONFLICT" });
  }

  await admin.from("driver_identity_verification_events").insert({
    verification_id: existing.id,
    driver_id: driver.id,
    actor_user_id: userId,
    actor_role: "driver",
    event_type: "session_started",
    from_status: existing.status,
    to_status: "started",
  });

  // Return only short-lived SDK data — never log session URL.
  void userClient;
  return json(200, {
    ok: true,
    code: "OK",
    verification_id: existing.id,
    status: "started",
    provider: session.provider,
    session_url: session.sessionUrl,
    expires_at: expiresAt,
    attempt_count: updated.attempt_count,
  });
});
