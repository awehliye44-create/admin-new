/**
 * LOCK — Driver Assistant auth must read drivers.driver_status (not drivers.status).
 *
 * Run: deno test --allow-read supabase/functions/_shared/driverAssistantRuntimeLock.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RUNTIME = new URL(
  "../onecab-assistant/driverAssistantRuntime.ts",
  import.meta.url,
);

Deno.test("driver assistant runtime selects driver_status from drivers", async () => {
  const src = await Deno.readTextFile(RUNTIME);
  assertEquals(src.includes('select("id, driver_status, deleted_at, first_name")'), true);
  assertEquals(src.includes('select("id, status, deleted_at, first_name")'), false);
  assertEquals(src.includes("row.driver_status"), true);
});
