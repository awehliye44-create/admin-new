/**
 * B5 — Arrive confirm-SELECT skip when waiting stamp proven.
 * Run: deno test --allow-read supabase/tests/_shared/arrivePickupB5Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isArrivePickupB5Enabled,
  measureArrivePickupB5Workload,
  shouldSkipPostWaitingTripSelect,
} from "./offline/arrivePickupB5SSOT.ts";

Deno.test("B5 flag defaults OFF", () => {
  assertEquals(isArrivePickupB5Enabled(undefined), false);
  assertEquals(isArrivePickupB5Enabled("1"), true);
});

Deno.test("skip only when B5 ON and waiting stamp proven", () => {
  assertEquals(
    shouldSkipPostWaitingTripSelect({
      b5Enabled: false,
      waitingStartedAt: "2026-11-27T12:00:00.000Z",
      tripWaitingStartedAt: null,
    }),
    false,
  );
  assertEquals(
    shouldSkipPostWaitingTripSelect({
      b5Enabled: true,
      waitingStartedAt: "2026-11-27T12:00:00.000Z",
      tripWaitingStartedAt: null,
    }),
    true,
  );
  assertEquals(
    shouldSkipPostWaitingTripSelect({
      b5Enabled: true,
      waitingStartedAt: null,
      tripWaitingStartedAt: null,
    }),
    false,
  );
});

Deno.test("isolated OFF/ON: proven stamps skip confirm SELECT; missing keep SELECT", () => {
  const cases = [
    { waitingStartedAt: "t1", tripWaitingStartedAt: null as string | null },
    { waitingStartedAt: "t2", tripWaitingStartedAt: null },
    { waitingStartedAt: null, tripWaitingStartedAt: null },
    { waitingStartedAt: null, tripWaitingStartedAt: "existing" },
  ];
  const off = measureArrivePickupB5Workload({ enabled: false, cases });
  const on = measureArrivePickupB5Workload({ enabled: true, cases });
  assertEquals(off.confirm_selects, 4);
  assertEquals(off.skipped, 0);
  assertEquals(on.confirm_selects, 1); // only fully missing
  assertEquals(on.skipped, 3);
});

Deno.test("stop-workflow wires B5 skip without dropping waiting fail-closed", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "shouldSkipPostWaitingTripSelect");
  assertStringIncludes(src, "isArrivePickupB5Enabled");
  assertStringIncludes(src, "PICKUP_WAITING_START_FAILED");
  assertStringIncludes(src, "pickup_waiting_started_at missing after Arrived");
  assertStringIncludes(src, "tryStartPickupWaiting");
  assertStringIncludes(src, "assertFarFromLocation");
  // Notify remains off-path.
  assertStringIncludes(src, "arrive_pickup_p2");
});
