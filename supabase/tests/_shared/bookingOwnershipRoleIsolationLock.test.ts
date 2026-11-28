/**
 * #57 — Booking ownership + dual-role isolation lock.
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveCancelTripCallerAuthority } from "../../functions/_shared/cancelTripCallerAuthSSOT.ts";

const PASSENGER = "CU065";
const DRIVER = "MK0007";
const DUAL_CUSTOMER = "CU044"; // same Auth as MK0007 — not the passenger
const USER = "dual-role-auth-user";

Deno.test("#57 lock: dual-role rider cancel of foreign booking is 403 with zero fall-through", () => {
  const denied = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "rider",
    isAdmin: false,
    callerUserId: USER,
    customerId: DUAL_CUSTOMER,
    driverId: DRIVER,
    tripPassengerId: PASSENGER,
    tripDriverId: null,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(denied.ok, false);
  if (!denied.ok) {
    assertEquals(denied.status, 403);
    assertEquals(denied.code, "RIDER_NOT_PASSENGER");
  }
});

Deno.test("#57 lock: same dual-role may cancel as assigned driver only", () => {
  const ok = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "driver",
    isAdmin: false,
    callerUserId: USER,
    customerId: DUAL_CUSTOMER,
    driverId: DRIVER,
    tripPassengerId: PASSENGER,
    tripDriverId: null,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.cancelledBy, "driver");
    assertEquals(ok.cancelledById, DRIVER);
  }
});

Deno.test("#57 lock: cancel-trip wires SSOT before fee/mutation", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/cancel-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "resolveCancelTripCallerAuthority");
  assertStringIncludes(src, "claimedCancelledBy");
  assertStringIncludes(src, "Never fall through");
  assertStringIncludes(src, "if (!authz.ok)");
  const authzIdx = src.indexOf("const authz = resolveCancelTripCallerAuthority");
  const denyIdx = src.indexOf("if (!authz.ok)");
  const tripUpdateIdx = src.indexOf(".update(tripUpdate)");
  assertEquals(authzIdx > 0, true);
  assertEquals(denyIdx > authzIdx, true);
  assertEquals(tripUpdateIdx > denyIdx, true);
});

Deno.test("#57 lock: migration ships ownership RPCs + access-role gates", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270227180000_booking_ownership_role_isolation.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(mig, "customer_list_my_trips");
  assertStringIncludes(mig, "customer_get_my_trip");
  assertStringIncludes(mig, "onecab_jwt_access_role");
  assertStringIncludes(mig, "passenger_id = v_customer_id");
  assertStringIncludes(mig, "SECURITY DEFINER");
});

Deno.test("#57 lock: bind-onecab-access-role Edge exists", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/bind-onecab-access-role/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "onecab_auth_session_roles");
  assertStringIncludes(src, "customer");
  assertStringIncludes(src, "driver");
});
