import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateFinancialOutcomeEntitlement,
  resolveEntitledTerminalDriverId,
} from "../../functions/_shared/financialOutcomeEntitlementGuardSSOT.ts";

const D1 = "d1";
const D2 = "d2";
const ARRIVED = "2026-09-16T19:00:00Z";

Deno.test("entitled driver prefers previous, then confirmed, then assigned driver", () => {
  assertEquals(resolveEntitledTerminalDriverId({ previous_driver_id: D1, confirmed_driver_id: D2, driver_id: D2 }), D1);
  assertEquals(resolveEntitledTerminalDriverId({ confirmed_driver_id: D2, driver_id: D1 }), D2);
  assertEquals(resolveEntitledTerminalDriverId({ driver_id: D1 }), D1);
  assertEquals(resolveEntitledTerminalDriverId({}), null);
});

Deno.test("completed trips can never receive a cancellation outcome (MK-260923-017)", () => {
  for (const trip of [
    { status: "completed", driver_id: D1, arrived_at: ARRIVED },
    { status: "cancelled", completed_at: "2026-09-23T18:47:21Z", driver_id: D1, arrived_at: ARRIVED },
  ]) {
    assertEquals(
      evaluateFinancialOutcomeEntitlement({ trip, requestedDriverId: D1, outcome: "NO_SHOW" }),
      { ok: false, status: 409, code: "COMPLETED_TRIP_NOT_ELIGIBLE" },
    );
  }
});

Deno.test("outcome requires an entitled driver matching the requested driver", () => {
  assertEquals(
    evaluateFinancialOutcomeEntitlement({
      trip: { status: "cancelled" },
      requestedDriverId: D1,
      outcome: "LATE_PASSENGER_CANCELLATION",
    }),
    { ok: false, status: 409, code: "NO_ENTITLED_DRIVER" },
  );
  assertEquals(
    evaluateFinancialOutcomeEntitlement({
      trip: { status: "cancelled", driver_id: D1, arrived_at: ARRIVED },
      requestedDriverId: D2,
      outcome: "NO_SHOW",
    }),
    { ok: false, status: 403, code: "DRIVER_NOT_ENTITLED" },
  );
});

Deno.test("no-show and arrival cancellation require the driver to have arrived", () => {
  for (const outcome of ["NO_SHOW", "ARRIVAL_CANCELLATION"]) {
    assertEquals(
      evaluateFinancialOutcomeEntitlement({ trip: { status: "cancelled", driver_id: D1 }, requestedDriverId: D1, outcome }),
      { ok: false, status: 409, code: "DRIVER_NEVER_ARRIVED" },
    );
  }
  assertEquals(
    evaluateFinancialOutcomeEntitlement({
      trip: { status: "customer_cancelled", driver_id: D1 },
      requestedDriverId: D1,
      outcome: "LATE_PASSENGER_CANCELLATION",
    }),
    { ok: true, entitledDriverId: D1 },
  );
});

Deno.test("a different stamped outcome is never replaced; the same outcome is idempotent", () => {
  const trip = { status: "no_show", driver_id: D1, arrived_at: ARRIVED, financial_outcome: "NO_SHOW" };
  assertEquals(
    evaluateFinancialOutcomeEntitlement({ trip, requestedDriverId: D1, outcome: "ARRIVAL_CANCELLATION" }),
    { ok: false, status: 409, code: "OUTCOME_CONFLICT" },
  );
  assertEquals(
    evaluateFinancialOutcomeEntitlement({ trip, requestedDriverId: D1, outcome: "NO_SHOW" }),
    { ok: true, entitledDriverId: D1 },
  );
});
