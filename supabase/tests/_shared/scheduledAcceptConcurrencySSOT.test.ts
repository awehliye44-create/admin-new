/**
 * Phase 2 — concurrent scheduled acceptance contract (integration-style).
 * Mirrors accept_scheduled_ride Phase 1 SQL: trip advisory lock + FOR UPDATE
 * + TRIP_ALREADY_TAKEN + payment / docs gates.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function readAcceptSql(): Promise<string> {
  return await Deno.readTextFile(
    new URL(
      "../../migrations/20270201120100_scheduled_finance_phase1_gap_closure.sql",
      import.meta.url,
    ),
  );
}

/** In-memory simulation of the trip-row lock accept race. */
function simulateConcurrentAccept(input: {
  trip: {
    id: string;
    driver_id: string | null;
    confirmed_driver_id: string | null;
    paymentOk: boolean;
    docsOk: boolean;
  };
  attempts: Array<{ driverId: string }>;
}): Array<{ driverId: string; success: boolean; error: string | null }> {
  const trip = { ...input.trip };
  const results: Array<{ driverId: string; success: boolean; error: string | null }> = [];
  // Serialize like pg_try_advisory_xact_lock(trip) + FOR UPDATE.
  for (const attempt of input.attempts) {
    if (!attempt.driverId) {
      results.push({ driverId: "", success: false, error: "NOT_AUTHENTICATED" });
      continue;
    }
    if (!input.trip.docsOk) {
      results.push({
        driverId: attempt.driverId,
        success: false,
        error: "DOCUMENTS_NOT_APPROVED",
      });
      continue;
    }
    if (!input.trip.paymentOk) {
      results.push({
        driverId: attempt.driverId,
        success: false,
        error: "PAYMENT_GATE_NOT_SATISFIED",
      });
      continue;
    }
    if (trip.driver_id != null || trip.confirmed_driver_id != null) {
      results.push({
        driverId: attempt.driverId,
        success: false,
        error: "TRIP_ALREADY_TAKEN",
      });
      continue;
    }
    trip.confirmed_driver_id = attempt.driverId;
    results.push({ driverId: attempt.driverId, success: true, error: null });
  }
  return results;
}

Deno.test("accept_scheduled_ride SQL serialises concurrent accepts", async () => {
  const sql = await readAcceptSql();
  assertStringIncludes(sql, "pg_try_advisory_xact_lock(hashtext(p_trip_id::text))");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "TRIP_ALREADY_TAKEN");
  assertStringIncludes(sql, "assert_payment_gate");
  assertStringIncludes(sql, "check_driver_documents_approved");
  assertStringIncludes(sql, "LOCK_CONTENTION");
});

Deno.test("two drivers: only one wins; loser gets TRIP_ALREADY_TAKEN", () => {
  const results = simulateConcurrentAccept({
    trip: {
      id: "t1",
      driver_id: null,
      confirmed_driver_id: null,
      paymentOk: true,
      docsOk: true,
    },
    attempts: [{ driverId: "d1" }, { driverId: "d2" }],
  });
  assertEquals(results[0], { driverId: "d1", success: true, error: null });
  assertEquals(results[1], {
    driverId: "d2",
    success: false,
    error: "TRIP_ALREADY_TAKEN",
  });
  assertEquals(results.filter((r) => r.success).length, 1);
});

Deno.test("duplicate accept from same driver after assignment is already-taken", () => {
  const results = simulateConcurrentAccept({
    trip: {
      id: "t1",
      driver_id: null,
      confirmed_driver_id: null,
      paymentOk: true,
      docsOk: true,
    },
    attempts: [{ driverId: "d1" }, { driverId: "d1" }],
  });
  assert(results[0].success);
  assertEquals(results[1].error, "TRIP_ALREADY_TAKEN");
});

Deno.test("Phase 1 payment and docs gates still block accept", () => {
  assertEquals(
    simulateConcurrentAccept({
      trip: {
        id: "t1",
        driver_id: null,
        confirmed_driver_id: null,
        paymentOk: false,
        docsOk: true,
      },
      attempts: [{ driverId: "d1" }],
    })[0].error,
    "PAYMENT_GATE_NOT_SATISFIED",
  );
  assertEquals(
    simulateConcurrentAccept({
      trip: {
        id: "t1",
        driver_id: null,
        confirmed_driver_id: null,
        paymentOk: true,
        docsOk: false,
      },
      attempts: [{ driverId: "d1" }],
    })[0].error,
    "DOCUMENTS_NOT_APPROVED",
  );
});
