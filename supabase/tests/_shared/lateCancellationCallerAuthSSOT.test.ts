import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authoriseLateCancellationCaller } from "../../functions/_shared/lateCancellationCallerAuthSSOT.ts";

const PASSENGER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

Deno.test("passenger who owns the trip is recorded as passenger regardless of body", () => {
  const d = authoriseLateCancellationCaller({
    caller: { kind: "user", userId: "u1", customerIds: [PASSENGER] },
    tripPassengerId: PASSENGER,
    requestedCancelledBy: "admin",
  });
  assertEquals(d, { ok: true, cancelledBy: "passenger", actorUserId: "u1", callerKind: "user" });
});

Deno.test("authenticated user who does not own the trip is refused", () => {
  const d = authoriseLateCancellationCaller({
    caller: { kind: "user", userId: "u2", customerIds: [OTHER] },
    tripPassengerId: PASSENGER,
  });
  assertEquals(d, { ok: false, status: 403, code: "NOT_TRIP_PASSENGER" });
});

Deno.test("user with no customer profile is refused even when the trip has no passenger", () => {
  assertEquals(
    authoriseLateCancellationCaller({ caller: { kind: "user", userId: "u3", customerIds: [] }, tripPassengerId: null }),
    { ok: false, status: 403, code: "NOT_TRIP_PASSENGER" },
  );
});

Deno.test("active staff with a cancelling role is recorded as admin", () => {
  for (const role of ["super_admin", "admin", "operator"]) {
    const d = authoriseLateCancellationCaller({
      caller: { kind: "staff", userId: "s1", role, isActive: true },
      tripPassengerId: PASSENGER,
      requestedCancelledBy: "passenger",
    });
    assertEquals(d, { ok: true, cancelledBy: "admin", actorUserId: "s1", callerKind: "staff" });
  }
});

Deno.test("inactive staff and non-cancelling roles are refused", () => {
  assertEquals(
    authoriseLateCancellationCaller({
      caller: { kind: "staff", userId: "s2", role: "admin", isActive: false },
      tripPassengerId: PASSENGER,
    }),
    { ok: false, status: 403, code: "STAFF_INACTIVE" },
  );
  assertEquals(
    authoriseLateCancellationCaller({
      caller: { kind: "staff", userId: "s3", role: "support", isActive: true },
      tripPassengerId: PASSENGER,
    }),
    { ok: false, status: 403, code: "FORBIDDEN" },
  );
});

Deno.test("service role defaults to passenger and accepts only known actors", () => {
  assertEquals(
    authoriseLateCancellationCaller({ caller: { kind: "service_role" }, tripPassengerId: PASSENGER }),
    { ok: true, cancelledBy: "passenger", actorUserId: null, callerKind: "service_role" },
  );
  assertEquals(
    authoriseLateCancellationCaller({
      caller: { kind: "service_role" },
      tripPassengerId: PASSENGER,
      requestedCancelledBy: " System ",
    }),
    { ok: true, cancelledBy: "system", actorUserId: null, callerKind: "service_role" },
  );
  assertEquals(
    authoriseLateCancellationCaller({
      caller: { kind: "service_role" },
      tripPassengerId: PASSENGER,
      requestedCancelledBy: "driver",
    }),
    { ok: false, status: 403, code: "INVALID_CANCELLED_BY" },
  );
});
