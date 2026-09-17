/**
 * MK-260916-038 STEP 2/3 scheduled-dispatch source lock.
 *
 * Run: deno test --allow-read supabase/tests/_shared/scheduledMarketplaceActivationSSOT.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const DISPATCH = new URL(
  "../../functions/scheduled-dispatch/index.ts",
  import.meta.url,
);

Deno.test("STEP 2 selects scheduled or leftover dispatching at/after persisted broadcast_at", async () => {
  const src = await Deno.readTextFile(DISPATCH);
  assertStringIncludes(src, '.in("scheduled_status", ["scheduled", "dispatching"])');
  assertStringIncludes(src, '.lte("scheduled_broadcast_at", now.toISOString())');
  assertStringIncludes(src, '.not("scheduled_broadcast_at", "is", null)');
  assertStringIncludes(src, "isScheduledMarketplaceActivationDue");
  assertStringIncludes(src, 'scheduled_status: "broadcasting"');
  assertStringIncludes(src, ".select(\"id\")");
  assertStringIncludes(src, "if (!activated?.id) continue");
});

Deno.test("STEP 2 CAS prevents duplicate activation on repeated cron", async () => {
  const src = await Deno.readTextFile(DISPATCH);
  const step2 = src.slice(
    src.indexOf("STEP 2: BROADCAST"),
    src.indexOf("STEP 2b:"),
  );
  assert(
    step2.includes('.in("scheduled_status", ["scheduled", "dispatching"])'),
    "activation update must CAS on scheduled_status scheduled|dispatching",
  );
  assert(
    step2.includes(".is(\"driver_id\", null)"),
    "activation update must refuse assigned trips",
  );
  assertEquals(
    step2.includes("triggerAutoDispatch("),
    false,
    "STEP 2 must not nearby-dispatch; Scheduled Jobs list only until STEP 3",
  );
  assert(
    step2.includes("notifyScheduledMarketplaceDrivers"),
    "STEP 2 must notify Scheduled Jobs drivers after marketplace open",
  );
});

Deno.test("STEP 2 notify uses scheduled_ride_request list-only push", async () => {
  const src = await Deno.readTextFile(DISPATCH);
  assertStringIncludes(src, 'type: "scheduled_ride_request"');
  assertStringIncludes(src, 'open_scheduled_jobs: "true"');
  assertStringIncludes(src, "SCHEDULED_MARKETPLACE_DRIVER_NOTIFY");
});

Deno.test("auto-dispatch refuses unconverted scheduled even with force_rebroadcast", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/auto-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "isScheduledInstantConversionPending");
  assertStringIncludes(src, "SCHEDULED_MARKETPLACE_LIST_ONLY");
  const gateIdx = src.indexOf("SCHEDULED_MARKETPLACE_LIST_ONLY");
  const eligibleIdx = src.indexOf(
    'if (!eligibleStatuses.includes(trip.status) && !force_rebroadcast)',
  );
  assert(gateIdx > 0, "list-only gate must exist");
  assert(eligibleIdx > 0, "eligibleStatuses guard must exist");
  assert(
    gateIdx < eligibleIdx,
    "list-only gate must run before force_rebroadcast status bypass",
  );
  assertStringIncludes(src, "nextAutoDispatchTripStatus");
  assertEquals(
    src.includes('status: trip.status === "searching_new_driver" ? "searching_new_driver" : "searching"'),
    false,
    "auto-dispatch must not stomp scheduled marketplace rows to searching",
  );
});

Deno.test("STEP 3 still converts via shouldConvertScheduledToUrgent + persisted convert_at", async () => {
  const src = await Deno.readTextFile(DISPATCH);
  const step3 = src.slice(
    src.indexOf("STEP 3: CONVERT TO INSTANT"),
    src.indexOf("STEP 3b:"),
  );
  assertStringIncludes(step3, "shouldConvertScheduledToUrgent");
  assertStringIncludes(step3, "scheduled_convert_at");
  assertStringIncludes(step3, "buildScheduledUrgentConversionPatch");
  assertStringIncludes(step3, "triggerAutoDispatch(");
});

Deno.test("STEP 3b stacked redispatch is convert_to_instant only", async () => {
  const src = await Deno.readTextFile(DISPATCH);
  const step3b = src.slice(
    src.indexOf("STEP 3b: RE-DISPATCH FOR STACKED RIDES"),
    src.indexOf("STEP 4:"),
  );
  assertStringIncludes(step3b, '.eq("dispatch_mode", "instant")');
  assertStringIncludes(step3b, '.eq("scheduled_status", "converted_to_instant")');
  assertEquals(
    step3b.includes('.eq("dispatch_mode", "scheduled")'),
    false,
    "STEP 3b must not nearby-dispatch unconverted scheduled marketplace rows",
  );
});

Deno.test("Admin Dispatch now pulls the window and invokes STEP 2, never stamps dispatching", async () => {
  const admin = await Deno.readTextFile(
    new URL("../../functions/admin-trip-action/index.ts", import.meta.url),
  );
  const ui = await Deno.readTextFile(
    new URL("../../../src/pages/ScheduledRides.tsx", import.meta.url),
  );
  assertStringIncludes(admin, 'action === "force_scheduled_marketplace"');
  assertStringIncludes(admin, "scheduled_broadcast_at: nowIso");
  assertStringIncludes(admin, 'scheduled_status: "scheduled"');
  assertStringIncludes(admin, "/functions/v1/scheduled-dispatch");
  assertEquals(
    admin.includes('scheduled_status: "dispatching"'),
    false,
    "admin-trip-action must not write dispatching",
  );
  assertStringIncludes(ui, "force_scheduled_marketplace");
  assertEquals(
    ui.includes("scheduled_status: 'dispatching'"),
    false,
    "ScheduledRides Dispatch now must not write dispatching",
  );
});

Deno.test("available_scheduled_jobs view uses STEP 2 marketplace gate, not honest scheduled", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20261116235000_available_scheduled_jobs_marketplace_gate.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "scheduled_marketplace_is_open");
  assertEquals(
    src.includes("ARRAY['broadcasting'::text, 'scheduled'::text, 'awaiting_confirmation'::text]"),
    false,
    "view must not list pre-STEP-2 scheduled_status=scheduled",
  );
});
