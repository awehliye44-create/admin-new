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
    "find_nearby_drivers RPC returns monotonically non-decreasing counts as radius expands",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
    });
    const p_lat = 51.5074;
    const p_lng = -0.1278;
    const steps = [1000, 7000, 13000];
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
      counts.push((data ?? []).length);
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
