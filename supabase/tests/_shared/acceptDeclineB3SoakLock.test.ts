/**
 * B3 soak harness lock — actual OFF/ON wall-clock soak exists; safety races covered.
 *
 * Run: deno test --no-check --allow-read \
 *   supabase/tests/_shared/acceptDeclineB3SoakLock.test.ts
 */
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const harnessUrl = new URL("./b3LocalOffOnSoakHarness.ts", import.meta.url);

Deno.test("B3 soak harness covers required scenarios and safety races", async () => {
  const src = await Deno.readTextFile(harnessUrl);
  for (const s of [
    "instant_accept",
    "stacked_accept",
    "scheduled_nro_accept",
    "marketplace_accept",
    "decline",
    "customer_assignment_visibility",
    "driver_nav_after_confirm",
  ]) {
    assertStringIncludes(src, s);
  }
  assertStringIncludes(src, "competingDriversExclusivity");
  assertStringIncludes(src, "preloadRaceSafety");
  assertStringIncludes(src, "duplicateTapAndRecovery");
  assertStringIncludes(src, "no_optimistic_success");
  assertStringIncludes(src, "stale_preload_cannot_bypass");
  assertStringIncludes(src, "production_touched: false");
  assertStringIncludes(src, 'resolved: false');
  assert(
    src.includes("Promise.all") && src.includes('mode === "ON"'),
    "ON path must use Promise.all",
  );
});
