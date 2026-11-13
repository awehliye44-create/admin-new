/**
 * Older Driver/Customer apps must not break on waiting_status=blocked_outside_radius.
 * Run: deno test --no-check --allow-read supabase/functions/_shared/blockedOutsideRadiusCompatLock.test.ts
 */
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const STOP = Deno.readTextFileSync(
  new URL("../stop-workflow/index.ts", import.meta.url),
);

Deno.test("arrive still returns success + waiting_started when blocked outside", () => {
  assertStringIncludes(STOP, "blocked_outside_radius");
  assertStringIncludes(STOP, "waiting_still_starts_on_arrived");
  // Status is additive — free_waiting path remains for inside radius.
  assertStringIncludes(STOP, "'free_waiting'");
});

Deno.test("resolveWaitingStatusFromResult understands blocked_outside_radius", () => {
  assertStringIncludes(
    STOP,
    'waitingResult.waiting_status === "blocked_outside_radius"',
  );
});

Deno.test("Start Trip / complete paths do not require free_waiting exclusively", () => {
  // finalizePickupWaitingOnStartTrip must not gate on free_waiting string.
  const finalizeIdx = STOP.indexOf("finalizePickupWaitingOnStartTrip");
  assert(finalizeIdx > 0);
  const slice = STOP.slice(finalizeIdx, finalizeIdx + 2500);
  assert(!slice.includes('=== "free_waiting"'));
});
