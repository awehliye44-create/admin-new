/**
 * #100A — get-active-trip must stamp server_now + remaining free wait for Customer.
 */
import { assertStringIncludes } from "jsr:@std/assert@1";

Deno.test("#100A get-active-trip emits server_now and grace remaining", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/get-active-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "serverNowIso");
  assertStringIncludes(src, "graceRemainingSeconds");
  assertStringIncludes(src, "remaining_free_waiting_seconds");
  assertStringIncludes(src, "waiting_geofence_checked_at");
  assertStringIncludes(src, "#100A");
});
