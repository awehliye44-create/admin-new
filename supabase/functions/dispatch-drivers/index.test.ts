import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

// Replica of the radiusStepsMeters builder used in dispatch-drivers/index.ts
function buildRadiusSteps(start: number, expand: number, max: number): number[] {
  return [start, expand, max].filter(
    (m, i, arr) => Number.isFinite(m) && m > 0 && (i === 0 || m > arr[i - 1]),
  );
}

Deno.test("radiusStepsMeters: strictly increasing values are kept", () => {
  assertEquals(buildRadiusSteps(7000, 9000, 13000), [7000, 9000, 13000]);
});

Deno.test("radiusStepsMeters: equal/decreasing steps are dropped", () => {
  assertEquals(buildRadiusSteps(5000, 5000, 13000), [5000, 13000]);
  assertEquals(buildRadiusSteps(8000, 4000, 13000), [8000, 13000]);
  assertEquals(buildRadiusSteps(8000, 9000, 9000), [8000, 9000]);
});

Deno.test("radiusStepsMeters: zero/non-finite values are dropped", () => {
  assertEquals(buildRadiusSteps(0, 9000, 13000), [9000, 13000]);
});

Deno.test({
  name:
    "find_nearby_drivers: expanding radius around a real online driver yields monotonic non-decreasing counts and discovers the driver",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
    });

    // Pick a real, currently-online driver from driver_presence as the pickup center.
    // Uses the same predicates the RPC uses (status/health/intent/offline_reason).
    const { data: online, error: onlineErr } = await supabase
      .from("driver_presence")
      .select("driver_id, lat, lng, status, presence_health, offline_reason, updated_at")
      .eq("status", "online")
      .eq("presence_health", "healthy")
      .is("offline_reason", null)
      .not("lat", "is", null)
      .not("lng", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1);

    assertEquals(onlineErr, null, `driver_presence query error: ${JSON.stringify(onlineErr)}`);
    assert(online && online.length > 0, "no online driver found to anchor the test");
    const anchor = online[0];
    const p_lat = Number(anchor.lat);
    const p_lng = Number(anchor.lng);
    console.log(`[test] anchor driver ${anchor.driver_id} @ ${p_lat},${p_lng}`);

    // Pull the live global radius steps — no magic numbers.
    const { data: gs, error: gsErr } = await supabase
      .from("global_dispatch_settings")
      .select("start_radius_meters, expand_radius_meters, max_radius_meters")
      .eq("singleton", true)
      .maybeSingle();
    assertEquals(gsErr, null, `global_dispatch_settings error: ${JSON.stringify(gsErr)}`);
    assert(gs, "global_dispatch_settings singleton missing");

    const steps = buildRadiusSteps(
      Number(gs.start_radius_meters),
      Number(gs.expand_radius_meters),
      Number(gs.max_radius_meters),
    );
    console.log("[test] live radius steps (m):", steps);
    assert(steps.length >= 1, "expected at least one radius step from live config");
    for (let i = 1; i < steps.length; i++) {
      assert(steps[i] > steps[i - 1], `live steps not strictly increasing: ${steps}`);
    }

    // Call RPC at each step; results must be monotonically non-decreasing and
    // the anchor driver must be present in every step (distance == 0 to itself).
    const counts: number[] = [];
    for (const r of steps) {
      const { data, error } = await supabase.rpc("find_nearby_drivers", {
        p_lat,
        p_lng,
        p_radius_meters: r,
        p_limit: 100,
        p_stale_seconds: 60,
      });
      assertEquals(error, null, `RPC error at ${r}m: ${JSON.stringify(error)}`);
      const rows = data ?? [];
      counts.push(rows.length);
      const foundAnchor = rows.some((d: any) => d.driver_id === anchor.driver_id);
      assert(foundAnchor, `anchor driver missing at radius ${r}m`);
    }
    console.log("[test] driver counts per radius (m):", steps, "=>", counts);

    for (let i = 1; i < counts.length; i++) {
      assert(
        counts[i] >= counts[i - 1],
        `non-monotonic: ${steps[i]}m=${counts[i]} < ${steps[i - 1]}m=${counts[i - 1]}`,
      );
    }

    try {
      await supabase.removeAllChannels();
      // @ts-ignore — best-effort cleanup
      supabase.realtime?.disconnect?.();
    } catch (_) { /* ignore */ }
  },
});
