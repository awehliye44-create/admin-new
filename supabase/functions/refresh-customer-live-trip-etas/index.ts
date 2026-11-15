/**
 * Cron / service-role sweep: refresh Live Trip ETA from existing route cache.
 * Never calls Google/Mapbox. Coalesces inside publish-customer-live-trip.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  assertCronOrServiceRoleAuth,
  cronAuthCorsHeaders,
} from "../_shared/cronEdgeAuth.ts";
import { resolveCustomerLiveTripPlatformGates } from "../_shared/customerLiveTripFeatureFlag.ts";
import { publishCustomerLiveTripBestEffort } from "../_shared/publishCustomerLiveTripBestEffort.ts";
import { probeCustomerLiveActivityApnsCredentials } from "../_shared/customerLiveTripApns.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cronAuthCorsHeaders });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const auth = await assertCronOrServiceRoleAuth(req, body);
  if (!auth.ok) return auth.response;

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE);
  const gates = await resolveCustomerLiveTripPlatformGates(admin);

  // Safe APNs credential shape probe — never enables fanout / never returns secrets.
  if (body.probe_apns === true) {
    const probe = await probeCustomerLiveActivityApnsCredentials();
    const envTri = (name: string): "true" | "false" | "unset" => {
      const v = Deno.env.get(name)?.trim().toLowerCase();
      if (v === "false" || v === "0" || v === "off") return "false";
      if (v === "true" || v === "1" || v === "on") return "true";
      return "unset";
    };
    let dbEnabled: boolean | null = null;
    let dbAndroid: boolean | null = null;
    let dbIos: boolean | null = null;
    try {
      const { data } = await admin
        .from("customer_live_trip_settings")
        .select("enabled, android_enabled, ios_enabled")
        .eq("id", true)
        .maybeSingle();
      if (data) {
        dbEnabled = data.enabled === true;
        if (typeof data.android_enabled === "boolean") {
          dbAndroid = data.android_enabled;
        }
        if (typeof data.ios_enabled === "boolean") dbIos = data.ios_enabled;
      }
    } catch {
      // ignore
    }
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "apns_probe",
        probe,
        gates,
        kill_switch: {
          env_global: envTri("CUSTOMER_LIVE_TRIP_ENABLED"),
          env_android: envTri("CUSTOMER_LIVE_TRIP_ANDROID_ENABLED"),
          env_ios: envTri("CUSTOMER_LIVE_TRIP_IOS_ENABLED"),
          db_enabled: dbEnabled,
          db_android: dbAndroid,
          db_ios: dbIos,
        },
        fanout_unchanged: true,
      }),
      {
        status: 200,
        headers: { ...cronAuthCorsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // Emergency disable: end every previously live projection.
  if (!gates.globalEnabled) {
    const { data: liveRows } = await admin
      .from("customer_live_trip_projections")
      .select("trip_id")
      .eq("eligible", true)
      .eq("terminal", false)
      .limit(200);
    for (const row of liveRows ?? []) {
      const tripId = String(row.trip_id ?? "").trim();
      if (!tripId) continue;
      await fetch(`${SUPABASE_URL}/functions/v1/publish-customer-live-trip`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SERVICE}`,
          apikey: SERVICE,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          trip_id: tripId,
          force_end: true,
          priority: "terminal",
        }),
      }).catch(() => undefined);
    }
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "emergency_end",
        ended: (liveRows ?? []).length,
        gates,
      }),
      { status: 200, headers: { ...cronAuthCorsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!gates.androidEnabled && !gates.iosEnabled) {
    return new Response(
      JSON.stringify({ ok: true, mode: "noop", reason: "platforms_disabled", gates }),
      { status: 200, headers: { ...cronAuthCorsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { data: rows } = await admin
    .from("customer_live_trip_projections")
    .select("trip_id, lifecycle_stage, assignment_generation, last_published_at")
    .eq("eligible", true)
    .eq("terminal", false)
    .limit(150);

  let enqueued = 0;
  for (const row of rows ?? []) {
    const tripId = String(row.trip_id ?? "").trim();
    if (!tripId) continue;
    publishCustomerLiveTripBestEffort(tripId, { priority: "eta" });
    enqueued += 1;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      mode: "eta_refresh",
      enqueued,
      gates,
      auth_source: auth.source,
    }),
    { status: 200, headers: { ...cronAuthCorsHeaders, "Content-Type": "application/json" } },
  );
});
