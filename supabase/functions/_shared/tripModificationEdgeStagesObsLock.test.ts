/**
 * C1-F3 — observation-only Edge stages_ms on request-trip-modification.
 * No financial / increment behaviour change.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const FUNCTIONS = new URL("../", import.meta.url).pathname;

Deno.test("serveWithEdgeTiming records optional stages_ms into ops metadata", async () => {
  const timing = await Deno.readTextFile(`${FUNCTIONS}_shared/edgeFunctionTiming.ts`);
  assert(timing.includes("stagesMs"));
  assert(timing.includes("EdgeStageClock"));
  assert(timing.includes("stages_ms: timer.stagesMs"));
});

Deno.test("request-trip-modification marks route/fare/revolut stages", async () => {
  const mod = await Deno.readTextFile(
    `${FUNCTIONS}request-trip-modification/index.ts`,
  );
  assert(mod.includes('mark("route_dual_start")'));
  assert(mod.includes('mark("fare_estimate_after_start")'));
  assert(mod.includes('mark("fare_estimate_before_start")'));
  assert(mod.includes('mark("revolut_increment_start")'));
  assert(mod.includes("stages_ms: stages?.snapshot"));
});

Deno.test("does not change incremental auth call site", async () => {
  const mod = await Deno.readTextFile(
    `${FUNCTIONS}request-trip-modification/index.ts`,
  );
  assert(mod.includes("executeFareIncreaseModificationPayment"));
  assert(!mod.includes("create-payment-recovery"));
});
