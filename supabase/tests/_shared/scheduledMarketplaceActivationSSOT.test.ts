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

Deno.test("STEP 2 selects only scheduled_status=scheduled at/after persisted broadcast_at", async () => {
  const src = await Deno.readTextFile(DISPATCH);
  assertStringIncludes(src, '.eq("scheduled_status", "scheduled")');
  assertStringIncludes(src, '.lte("scheduled_broadcast_at", now.toISOString())');
  assertStringIncludes(src, '.not("scheduled_broadcast_at", "is", null)');
  assertStringIncludes(src, "isScheduledMarketplaceActivationDue");
  assertStringIncludes(src, 'scheduled_status: "broadcasting"');
  assertStringIncludes(src, '.eq("scheduled_status", "scheduled")');
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
    step2.includes('.eq("scheduled_status", "scheduled")'),
    "activation update must CAS on scheduled_status=scheduled",
  );
  assert(
    step2.includes(".is(\"driver_id\", null)"),
    "activation update must refuse assigned trips",
  );
  assertEquals(
    step2.includes("forceRebroadcast: true"),
    true,
    "activation still hands to auto-dispatch once",
  );
  const autoDispatchCalls = step2.split("triggerAutoDispatch(").length - 1;
  assertEquals(autoDispatchCalls, 1, "STEP 2 must invoke auto-dispatch once per successful activation");
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
});
