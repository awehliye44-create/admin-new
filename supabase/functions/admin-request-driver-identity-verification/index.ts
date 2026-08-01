/**
 * admin-request-driver-identity-verification
 * Creates a verification requirement. Does not open Veriff.
 */
import { requireAdmin } from "../_shared/adminPaymentGate.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;

  let body: {
    driver_id?: string;
    reason?: string;
    note?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "INVALID_JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const driverId = body.driver_id?.trim();
  const reason = (body.reason || "admin_requested").trim();
  if (!driverId) {
    return new Response(JSON.stringify({ ok: false, error: "DRIVER_ID_REQUIRED" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const allowedReasons = new Set([
    "periodic_check",
    "random_check",
    "new_device",
    "suspicious_login",
    "unusual_location",
    "admin_requested",
    "expired_verification",
    "account_reactivation",
    "risk_rule",
    "provider_retry",
  ]);
  if (!allowedReasons.has(reason)) {
    return new Response(JSON.stringify({ ok: false, error: "INVALID_REASON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: driver } = await gate.supabase
    .from("drivers")
    .select("id, service_area_id")
    .eq("id", driverId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!driver) {
    return new Response(JSON.stringify({ ok: false, error: "DRIVER_NOT_FOUND" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: settings } = await gate.supabase
    .from("service_area_identity_verification_settings")
    .select("maximum_attempts, active_work_deferral_enabled, enabled, provider")
    .eq("service_area_id", driver.service_area_id)
    .maybeSingle();

  const { data: hasWork } = await gate.supabase.rpc(
    "driver_has_accepted_active_or_stacked_work",
    { p_driver_id: driverId },
  );

  const initialStatus =
    hasWork === true && settings?.active_work_deferral_enabled !== false
      ? "deferred_active_work"
      : "required";

  // Close any non-terminal active rows first if conflict — one active unique index.
  const { data: active } = await gate.supabase
    .from("driver_identity_verifications")
    .select("id, status")
    .eq("driver_id", driverId)
    .in("status", [
      "required",
      "deferred_active_work",
      "started",
      "processing",
      "manual_review",
      "reference_unavailable",
    ])
    .maybeSingle();

  if (active) {
    return new Response(
      JSON.stringify({
        ok: true,
        already_active: true,
        verification_id: active.id,
        status: active.status,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const { data: inserted, error } = await gate.supabase
    .from("driver_identity_verifications")
    .insert({
      driver_id: driverId,
      provider: settings?.provider || "veriff",
      reason,
      status: initialStatus,
      attempt_count: 0,
      max_attempts: settings?.maximum_attempts ?? 3,
      service_area_id: driver.service_area_id,
      requested_at: new Date().toISOString(),
      metadata: {
        admin_note: body.note ?? null,
        requested_by: gate.userId,
      },
    })
    .select("id, status")
    .maybeSingle();

  if (error || !inserted) {
    return new Response(
      JSON.stringify({ ok: false, error: error?.message || "INSERT_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  await gate.supabase.from("driver_identity_verification_events").insert({
    verification_id: inserted.id,
    driver_id: driverId,
    actor_user_id: gate.userId,
    actor_role: "admin",
    event_type: "admin_requested",
    to_status: inserted.status,
    reason,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      verification_id: inserted.id,
      status: inserted.status,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
