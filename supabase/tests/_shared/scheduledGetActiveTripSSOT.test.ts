/**
 * MK-260916-038: get-active-trip must not return a future unassigned scheduled
 * trip as the current live broadcasting ride.
 *
 * Run: deno test --allow-read supabase/tests/_shared/scheduledGetActiveTripSSOT.test.ts
 */
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = new URL(
  "../../functions/get-active-trip/index.ts",
  import.meta.url,
);

Deno.test("get-active-trip future unassigned scheduled is not a live trip", async () => {
  const src = await Deno.readTextFile(SRC);
  assertStringIncludes(src, "function isCustomerLiveTrip");
  assertStringIncludes(src, "const hasDriver = Boolean(row.driver_id || row.confirmed_driver_id)");
  const fn = src.slice(
    src.indexOf("function isCustomerLiveTrip"),
    src.indexOf("serveWithEdgeTiming(\"get-active-trip\""),
  );
  assert(
    fn.includes("hasDriver &&") && fn.includes("SCHEDULED_LIVE_STATES.includes(status)"),
    "scheduled live trip requires an assigned driver plus a live status",
  );
  assert(
    fn.includes("scheduledDispatchWindowReached(row, nowMs)"),
    "scheduled live trip still respects the canonical activation window",
  );
  assert(
    !fn.includes("scheduled_status === \"broadcasting\"") &&
      !fn.includes('scheduledStatus === "broadcasting"'),
    "polluted scheduled_status=broadcasting must not make an unassigned future trip live",
  );
});
