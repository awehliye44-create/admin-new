/**
 * deno test --allow-read supabase/tests/_shared/customerLiveTripRuntimeGate.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isCustomerLiveTripRuntimeCompatible,
  LIVE_TRIP_CLIENT_CAPABILITY,
  parseNativeBuildInParens,
} from "../../functions/_shared/customerLiveTripRuntimeGate.ts";

Deno.test("parseNativeBuildInParens reads trailing build", () => {
  assertEquals(parseNativeBuildInParens("1.0.6(46)"), 46);
  assertEquals(parseNativeBuildInParens("1.0.6(23)"), 23);
  assertEquals(parseNativeBuildInParens("1.0.6"), null);
  assertEquals(parseNativeBuildInParens(null), null);
});

Deno.test("compatible Android 1.0.6(46)+ allowed; older blocked", () => {
  assertEquals(
    isCustomerLiveTripRuntimeCompatible({
      platform: "android",
      appVersion: "1.0.6(46)",
    }),
    true,
  );
  assertEquals(
    isCustomerLiveTripRuntimeCompatible({
      platform: "android",
      appVersion: "1.0.6",
    }),
    true,
  );
  assertEquals(
    isCustomerLiveTripRuntimeCompatible({
      platform: "android",
      appVersion: "1.0.6(45)",
    }),
    false,
  );
  assertEquals(
    isCustomerLiveTripRuntimeCompatible({
      platform: "android",
      appVersion: "1.0.5",
    }),
    false,
  );
});

Deno.test("compatible iOS 1.0.6(23)+ allowed; older blocked", () => {
  assertEquals(
    isCustomerLiveTripRuntimeCompatible({
      platform: "ios",
      appVersion: "1.0.6(23)",
    }),
    true,
  );
  assertEquals(
    isCustomerLiveTripRuntimeCompatible({
      platform: "ios",
      appVersion: "1.0.6(22)",
    }),
    false,
  );
});

Deno.test("capability ack unlocks even without parenthetical build", () => {
  assertEquals(
    isCustomerLiveTripRuntimeCompatible({
      platform: "android",
      appVersion: "1.0.6",
      clientCapabilities: [LIVE_TRIP_CLIENT_CAPABILITY],
    }),
    true,
  );
});

Deno.test("unknown platform / missing build fail closed", () => {
  assertEquals(
    isCustomerLiveTripRuntimeCompatible({
      platform: "android",
      appVersion: null,
    }),
    false,
  );
  assertEquals(
    isCustomerLiveTripRuntimeCompatible({ platform: "web" }),
    false,
  );
});
