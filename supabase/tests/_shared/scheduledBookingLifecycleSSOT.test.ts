/**
 * MK-260916-038 scheduled INSERT lifecycle lock.
 *
 * Run: deno test --allow-read supabase/tests/_shared/scheduledBookingLifecycleSSOT.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261116230000_scheduled_booking_lifecycle_insert_status.sql",
  import.meta.url,
);

Deno.test("RC1: INSERT trigger stamps scheduled_status=scheduled, never broadcasting", async () => {
  const src = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(src, "NEW.scheduled_status := 'scheduled'");
  assertEquals(
    src.includes("NEW.scheduled_status := 'broadcasting'"),
    false,
    "INSERT trigger must not open the marketplace",
  );
  assertStringIncludes(src, "NEW.status := 'scheduled'");
  assertStringIncludes(src, "NEW.dispatch_mode := 'scheduled'");
  assertStringIncludes(src, "NEW.is_scheduled := true");
  assert(
    src.includes("AND NEW.driver_id IS NULL"),
    "must keep assigned/confirmed inserts out of the pre-marketplace stamp",
  );
});

Deno.test("RC1: immediate trips still early-return without scheduled_at", async () => {
  const src = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(
    src,
    "IF NOT v_is_scheduled OR NEW.scheduled_at IS NULL THEN",
  );
  assertStringIncludes(src, "RETURN NEW;");
});

Deno.test("RC1: lifecycle trigger is BEFORE INSERT only, never UPDATE", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20261116234000_scheduled_lifecycle_insert_trigger_only.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "BEFORE INSERT ON public.trips");
  assertStringIncludes(src, "trg_enforce_scheduled_trip_lifecycle");
  assertEquals(
    src.includes("BEFORE INSERT OR UPDATE"),
    false,
    "lifecycle trigger must not fire on STEP 2 UPDATE",
  );
  assertStringIncludes(src, "DROP TRIGGER IF EXISTS");
});
