import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveCancelTripCallerAuthority } from "./cancelTripCallerAuthSSOT.ts";

const PASSENGER = "cust-owner";
const DRIVER = "drv-assigned";
const OTHER_CUST = "cust-other";
const OTHER_DRV = "drv-other";
const USER = "auth-user";

Deno.test("#57 rider claim requires passenger ownership — no driver fall-through", () => {
  const denied = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "rider",
    isAdmin: false,
    callerUserId: USER,
    customerId: OTHER_CUST,
    driverId: DRIVER,
    tripPassengerId: PASSENGER,
    tripDriverId: null,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(denied.ok, false);
  if (!denied.ok) assertEquals(denied.code, "RIDER_NOT_PASSENGER");
});

Deno.test("#57 dual-role assigned driver cannot cancel as rider", () => {
  const denied = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "rider",
    isAdmin: false,
    callerUserId: USER,
    customerId: OTHER_CUST, // CU044 — not passenger
    driverId: DRIVER, // MK0007 — assigned
    tripPassengerId: PASSENGER, // CU065
    tripDriverId: null,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(denied.ok, false);
});

Deno.test("#57 driver claim requires assignment", () => {
  const denied = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "driver",
    isAdmin: false,
    callerUserId: USER,
    customerId: PASSENGER,
    driverId: OTHER_DRV,
    tripPassengerId: PASSENGER,
    tripDriverId: null,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(denied.ok, false);
  if (!denied.ok) assertEquals(denied.code, "DRIVER_NOT_ASSIGNED");
});

Deno.test("#57 assigned driver cancels with driver claim", () => {
  const ok = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "driver",
    isAdmin: false,
    callerUserId: USER,
    customerId: OTHER_CUST,
    driverId: DRIVER,
    tripPassengerId: PASSENGER,
    tripDriverId: null,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(ok, {
    ok: true,
    cancelledBy: "driver",
    cancelledById: DRIVER,
  });
});

Deno.test("#57 true passenger cancels with rider claim", () => {
  const ok = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "rider",
    isAdmin: false,
    callerUserId: USER,
    customerId: PASSENGER,
    driverId: null,
    tripPassengerId: PASSENGER,
    tripDriverId: null,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(ok, {
    ok: true,
    cancelledBy: "rider",
    cancelledById: PASSENGER,
  });
});

Deno.test("#57 dual-role passenger (also a driver) cancels own trip as rider", () => {
  // MK-261120-004 class: WhatsApp guest whose auth user also has a drivers row.
  // Rider claim must succeed when customerId matches trip passenger — driver
  // assignment on a different trip must not poison this decision.
  const ok = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "rider",
    isAdmin: false,
    callerUserId: USER,
    customerId: PASSENGER,
    driverId: OTHER_DRV,
    tripPassengerId: PASSENGER,
    tripDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(ok, {
    ok: true,
    cancelledBy: "rider",
    cancelledById: PASSENGER,
  });
});

Deno.test("#57 forged admin claim from non-admin is forbidden", () => {
  const denied = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "admin",
    isAdmin: false,
    callerUserId: USER,
    customerId: PASSENGER,
    driverId: DRIVER,
    tripPassengerId: PASSENGER,
    tripDriverId: null,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(denied.ok, false);
  if (!denied.ok) assertEquals(denied.code, "FORBIDDEN");
});

Deno.test("#57 body cancelled_by is not trusted without matching identity", () => {
  const denied = resolveCancelTripCallerAuthority({
    claimedCancelledBy: "rider",
    isAdmin: false,
    callerUserId: USER,
    customerId: null,
    driverId: DRIVER,
    tripPassengerId: PASSENGER,
    tripDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(denied.ok, false);
});
