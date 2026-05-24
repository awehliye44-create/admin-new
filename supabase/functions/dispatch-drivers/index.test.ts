import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

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

Deno.test("radiusStepsMeters: invalid/zero values are dropped", () => {
  assertEquals(buildRadiusSteps(0, 9000, 13000), [9000, 13000]);
  assertEquals(buildRadiusSteps(NaN as unknown as number, 9000, 13000), [9000, 13000]);
});

Deno.test("global_dispatch_settings singleton produces a valid increasing step array", async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data, error } = await supabase
    .from("global_dispatch_settings")
    .select("start_radius_meters, expand_radius_meters, max_radius_meters")
    .eq("singleton", true)
    .maybeSingle();
  assertEquals(error, null);
  assert(data, "global_dispatch_settings singleton missing");
  const steps = buildRadiusSteps(
    Number(data.start_radius_meters),
    Number(data.expand_radius_meters),
    Number(data.max_radius_meters),
  );
  assert(steps.length >= 1, "expected at least one radius step");
  for (let i = 1; i < steps.length; i++) {
    assert(steps[i] > steps[i - 1], `steps not strictly increasing: ${steps}`);
  }
  console.log("[test] radius steps (m):", steps);
});

Deno.test("find_nearby_drivers RPC returns monotonically non-decreasing counts as radius expands", async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  // Central London
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
      `non-monotonic: step ${steps[i]}m returned ${counts[i]} (< previous ${counts[i - 1]})`,
    );
  }
});
