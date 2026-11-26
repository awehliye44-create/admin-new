/**
 * #110 P6 H1/H2 — corporate cancel must forward to cancel-trip disposition SSOT.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const corporate = await Deno.readTextFile(
  new URL("../../functions/cancel-corporate-trip/index.ts", import.meta.url),
);
const auth = await Deno.readTextFile(
  new URL("../../functions/_shared/cancelTripCallerAuthSSOT.ts", import.meta.url),
);
const cancel = await Deno.readTextFile(
  new URL("../../functions/cancel-trip/index.ts", import.meta.url),
);

Deno.test("P6 H1: cancel-corporate-trip is a gated forwarder — no direct trips.status write", () => {
  assertStringIncludes(corporate, "requireAnyPageAccess(");
  assertStringIncludes(corporate, "cancelled_by_role: callerRole");
  assertEquals(corporate.includes("cancelled_by_role ||"), false);
  assertStringIncludes(corporate, "/functions/v1/cancel-trip");
  assertEquals(corporate.includes(".from('trips')\n      .update"), false);
  assertEquals(corporate.includes('.from("trips").update'), false);
  assertEquals(corporate.includes("dispatch_settings"), false);
  assertEquals(corporate.includes("final_fare_pence"), false);
});

Deno.test("P6 H1: cancel-trip admits corporate members / staff trip managers", () => {
  assertStringIncludes(auth, "isCorporateMemberOfTrip");
  assertStringIncludes(auth, "isStaffTripManager");
  assertStringIncludes(cancel, "corporate_account_id");
  assertStringIncludes(cancel, "isCorporateMemberOfTrip");
  assertStringIncludes(cancel, "disposeTerminalTripPayment");
});
