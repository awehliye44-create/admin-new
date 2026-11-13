/**
 * Arrive/start thin trip selects must include authoritative driver_net_pence
 * so Driver active-trip hydrate cannot sticky-zero earnings (MK-261113-003).
 *
 * Run: deno test --no-check --allow-read supabase/functions/_shared/arriveWaitingTripSelectNetLock.test.ts
 */

import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const STOP_WORKFLOW = Deno.readTextFileSync(
  new URL("../stop-workflow/index.ts", import.meta.url),
);

Deno.test("ARRIVE_WAITING_TRIP_SELECT includes driver_net_pence + airport", () => {
  assertStringIncludes(STOP_WORKFLOW, "ARRIVE_WAITING_TRIP_SELECT");
  const marker = "const ARRIVE_WAITING_TRIP_SELECT =";
  const start = STOP_WORKFLOW.indexOf(marker);
  if (start < 0) throw new Error("ARRIVE_WAITING_TRIP_SELECT missing");
  const slice = STOP_WORKFLOW.slice(start, start + 900);
  assertStringIncludes(slice, "driver_net_pence");
  assertStringIncludes(slice, "driver_net_before_tip_pence");
  assertStringIncludes(slice, "airport_charge_pence");
  assertStringIncludes(slice, "commissionable_fare_pence");
  assertStringIncludes(slice, "confirmed_driver_id");
});

Deno.test("tryStartPickupWaiting returns blocked_outside_radius when outside", () => {
  assertStringIncludes(
    STOP_WORKFLOW,
    "waiting_status: outsideRadius ? 'blocked_outside_radius' : 'free_waiting'",
  );
  assertStringIncludes(STOP_WORKFLOW, "waiting_still_starts_on_arrived");
});
