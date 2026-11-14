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
