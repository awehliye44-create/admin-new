/**
 * B4-B — parallel tip_order ∥ tips_enabled reads (flag-gated).
 * Run: deno test --allow-read supabase/tests/_shared/completeTripB4bLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isCompleteTripB4bEnabled,
  measureCompleteTripB4bWorkload,
  shouldParalleliseTipSetupReads,
} from "./offline/completeTripB4bSSOT.ts";

Deno.test("B4-B flag defaults OFF", () => {
  assertEquals(isCompleteTripB4bEnabled(undefined), false);
  assertEquals(isCompleteTripB4bEnabled("0"), false);
  assertEquals(isCompleteTripB4bEnabled("1"), true);
});

Deno.test("parallel only when both tip reads required", () => {
  assertEquals(
    shouldParalleliseTipSetupReads({
      needsOrderLookup: true,
      canReadTipsEnabled: true,
    }),
    true,
  );
  assertEquals(
    shouldParalleliseTipSetupReads({
      needsOrderLookup: false,
      canReadTipsEnabled: true,
    }),
    false,
  );
});

Deno.test("isolated OFF/ON wall time: parallel = max, sequential = sum", () => {
  const off = measureCompleteTripB4bWorkload({
    enabled: false,
    orderLookupMs: 80,
    tipsEnabledMs: 64,
    bothRequired: true,
  });
  const on = measureCompleteTripB4bWorkload({
    enabled: true,
    orderLookupMs: 80,
    tipsEnabledMs: 64,
    bothRequired: true,
  });
  assertEquals(off.wall_ms, 144);
  assertEquals(on.wall_ms, 80);
  assertEquals(off.query_count, 2);
  assertEquals(on.query_count, 2);
  assertEquals(on.parallel, true);
  assertEquals(off.parallel, false);
  // Latency saving (not query elimination).
  assertEquals(off.wall_ms - on.wall_ms, 64);
});

Deno.test("stop-workflow B4-B path preserves fail-closed + B4-A + PENDING", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "isCompleteTripB4bEnabled");
  assertStringIncludes(src, "shouldParalleliseTipSetupReads");
  assertStringIncludes(src, "Promise.all");
  assertStringIncludes(src, "TIP_WINDOW_STAMP_UNAVAILABLE");
  assertStringIncludes(src, "decideTipWindowPersistPath");
  assertStringIncludes(src, "await postPendingEntitlement");
  assertEquals(src.includes("complete_trip_atomic"), false);
});
