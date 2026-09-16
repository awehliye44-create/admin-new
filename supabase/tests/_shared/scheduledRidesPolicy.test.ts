import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shouldUseUrgentFallbackTrigger } from "./scheduledRidesPolicy.ts";

Deno.test("edge urgent fallback gate mirrors SSOT", () => {
  assertEquals(shouldUseUrgentFallbackTrigger({ confirmedDriverId: null }), true);
  assertEquals(shouldUseUrgentFallbackTrigger({ confirmedDriverId: "x" }), false);
  assertEquals(
    shouldUseUrgentFallbackTrigger({
      confirmedDriverId: null,
      enableScheduledToUrgentConversion: false,
    }),
    false,
  );
});
