/**
 * #111A — driver SELECT on trips must include previous_driver_id after terminal
 * assignment clear (Wallet No-show presentation).
 *
 * Run: deno test --allow-read supabase/tests/_shared/bug111aDriverPreviousTripSelectLock.test.ts
 */
import {
  assertStringIncludes,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("#111A migration grants previous_driver_id SELECT", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20270304160000_bug111a_driver_previous_trip_select.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "previous_driver_id = current_driver_profile_id()");
  assertStringIncludes(src, "Drivers can view their assigned trips");
  assertStringIncludes(src, "FOR SELECT");
  assertStringIncludes(src, "Extend SELECT only");
  assertStringIncludes(src, "#111A");
  // Never widen UPDATE via previous_driver_id (cross-driver mutation / privacy).
  assertEquals(/FOR UPDATE[\s\S]*previous_driver_id/.test(src), false);
});
