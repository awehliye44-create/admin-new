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

Deno.test("same-request route leg fingerprint cache is request-local only", async () => {
  const mod = await Deno.readTextFile(
    `${FUNCTIONS}request-trip-modification/index.ts`,
  );
  assert(mod.includes("routeLegByFingerprint"));
  assert(mod.includes("routeLegFingerprint"));
  assert(mod.includes('mark("route_leg_cache_hit")'));
  // Fingerprint must include origin, destination, and remaining intermediate stops.
  const fpAt = mod.indexOf("const routeLegFingerprint");
  const fpBody = mod.slice(fpAt, fpAt + 450);
  assert(fpBody.includes("originLat") && fpBody.includes("originLng"));
  assert(fpBody.includes("destLat") && fpBody.includes("destLng"));
  assert(fpBody.includes("intermediates.map"));
  // Must not introduce a cross-request or module-level route cache.
  assert(!mod.includes("globalThis"));
  const moduleTop = mod.slice(0, mod.indexOf("serveWithEdgeTiming"));
  assert(
    !moduleTop.includes("routeLegByFingerprint"),
    "route leg cache must not be module-scoped",
  );
  const cacheDecl = mod.indexOf("const routeLegByFingerprint = new Map");
  const dualStart = mod.indexOf('mark("route_dual_start")');
  assert(cacheDecl > 0 && dualStart > cacheDecl, "cache must be scoped inside the request handler before dual fetch");
  // Fare / increment path unchanged.
  assert(mod.includes("executeFareIncreaseModificationPayment"));
});
