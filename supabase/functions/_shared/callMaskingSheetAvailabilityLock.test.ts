/**
 * Lock: Call sheet must show masked phone when service-area enables call_masking.
 *
 * Regression: trip-communication-config required legacy.call_masking_available === true,
 * but buildTripCommunicationConfigForTrip only returns methods[] — so masking was always
 * false while VoIP stayed (voip_available !== false treats undefined as on).
 *
 * If this fails, fix the Edge function — never delete or soften the lock.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("trip-communication-config derives masking from methods, not missing call_masking_available", async () => {
  const src = await Deno.readTextFile(
    new URL("../trip-communication-config/index.ts", import.meta.url),
  );
  assertEquals(src.includes('methodNames.has("call_masking")'), true);
  assertEquals(src.includes('methodNames.has("voip")'), true);
  assertEquals(
    /callingAvailable\s*&&\s*legacy\.call_masking_available\s*===\s*true/.test(src),
    false,
  );
  assertEquals(
    /callingAvailable\s*&&\s*legacy\.voip_available\s*!==\s*false/.test(src),
    false,
  );
});

Deno.test("buildTripCommunicationConfigForTrip exposes methods from settings SSOT", async () => {
  const builder = await Deno.readTextFile(
    new URL("./tripCommunicationConfigBuilder.ts", import.meta.url),
  );
  const methods = await Deno.readTextFile(
    new URL("./tripCommunicationMethods.ts", import.meta.url),
  );
  assertEquals(builder.includes("resolveTripCommunicationConfig"), true);
  assertEquals(methods.includes("call_masking_enabled"), true);
  assertEquals(methods.includes("buildCommunicationMethods"), true);
});
