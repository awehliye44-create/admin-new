/**
 * LOCK — terminal trip stamp errors are never silent, and never touch the ledger.
 *
 * Invariant: capture − terminal commission (0) − ACTUAL provider fee = driver
 * terminal net (450 − 0 − 24 = 426). The TRIP_EARNING_NET row is the entitlement
 * SSOT: a failed trip projection is detected, logged and audited
 * (ops_events TERMINAL_TRIP_STAMP_FAILED) — it never rolls back or duplicates
 * the ledger, and never throws into the settlement path.
 * A chargeable cancellation is not a completed ride: completed_at is never written.
 *
 * MK-261002-014 / -015: the stamp update failed the old CHECK and the result
 * was ignored, leaving the booking quote 500/75/425 on the trip.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildTerminalOutcomeTripPatch,
  computeTerminalOutcomeEntitlement,
  stampTerminalOutcomeTripRow,
  TERMINAL_TRIP_STAMP_FAILED_EVENT,
} from "../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";
import { postTerminalOutcomeSettlement } from "../../functions/_shared/canonicalTypedWalletPostingSSOT.ts";
import { settleNoShowFee } from "../../functions/_shared/noShowSettlement.ts";
import { createFakeDb, type FakeRow } from "./waitingSsotFakeDb.ts";

const TRIP = "trip-014";
const DRIVER = "c40dd8a6-f422-40bc-9534-bae7be88b93e";

function seed(over: { fee_status?: string; fee?: number | null; status?: string; outcome?: string } = {}) {
  const trip: FakeRow = {
    id: TRIP,
    status: over.status ?? "cancelled",
    financial_outcome: over.outcome ?? "ARRIVAL_CANCELLATION",
    gross_fare_pence: 500,
    commission_pence: 75,
    driver_net_pence: 425,
    provider_fee_pence: 24,
    capture_amount_pence: 450,
    completed_at: null,
    cancelled_at: "2026-10-02T12:29:40.000Z",
    previous_driver_id: DRIVER,
  };
  return {
    trips: [trip],
    payment_sessions: [{
      id: "ps-014",
      trip_id: TRIP,
      captured_amount_pence: 450,
      provider_processing_fee_pence: over.fee === undefined ? 24 : over.fee,
      fee_status: over.fee_status ?? "ACTUAL",
      status: "captured",
      captured_at: "2026-10-02T12:29:43.321Z",
    }],
    driver_wallet_ledger: [] as FakeRow[],
    ops_events: [] as FakeRow[],
  };
}

const evidence014 = {
  payment_session_id: "ps-014",
  captured_pence: 450,
  provider_fee_pence: 24,
  provider_fee_confirmed: true,
};

function silenceConsole<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error;
  const l = console.log;
  console.error = () => {};
  console.log = () => {};
  return fn().finally(() => {
    console.error = e;
    console.log = l;
  });
}

Deno.test("stamp patch: 450 − 0 − 24 = 426 and never writes completed_at", () => {
  const ent = computeTerminalOutcomeEntitlement(evidence014);
  for (const outcome of ["ARRIVAL_CANCELLATION", "NO_SHOW", "LATE_PASSENGER_CANCELLATION"] as const) {
    const patch = buildTerminalOutcomeTripPatch({ outcome, entitlement: ent, paymentMethod: "card", nowIso: "2026-10-02T12:30:00.000Z" })!;
    assertEquals("completed_at" in patch, false, outcome);
    assertEquals(patch.gross_fare_pence, 450);
    assertEquals(patch.commission_pence, 0);
    assertEquals(patch.provider_fee_pence, 24);
    assertEquals(patch.driver_net_pence, 426);
    assertEquals(
      Number(patch.gross_fare_pence) - Number(patch.commission_pence) - Number(patch.provider_fee_pence),
      Number(patch.driver_net_pence),
    );
    assertEquals(patch.status, outcome === "NO_SHOW" ? "no_show" : "cancelled");
  }
});

Deno.test("stamp: success writes the terminal projection and keeps the trip cancelled", async () => {
  const db = createFakeDb(seed());
  // deno-lint-ignore no-explicit-any
  const r = await stampTerminalOutcomeTripRow({ supabase: db.client as any, tripId: TRIP, outcome: "ARRIVAL_CANCELLATION", evidence: evidence014, paymentMethod: "card" });
  assertEquals(r.stamp_status, "STAMPED");
  const t = db.tables.trips[0]!;
  assertEquals([t.gross_fare_pence, t.commission_pence, t.provider_fee_pence, t.driver_net_pence], [450, 0, 24, 426]);
  assertEquals(t.status, "cancelled");
  assertEquals(t.completed_at, null);
  assertEquals(db.tables.ops_events.length, 0);
});

Deno.test("stamp: update error is audited, reported and never thrown", async () => {
  const db = createFakeDb(seed(), { failUpdate: (table) => table === "trips" });
  const r = await silenceConsole(() =>
    // deno-lint-ignore no-explicit-any
    stampTerminalOutcomeTripRow({ supabase: db.client as any, tripId: TRIP, outcome: "ARRIVAL_CANCELLATION", evidence: evidence014 })
  );
  assertEquals(r.stamp_status, "STAMP_UPDATE_FAILED");
  assert(r.stamp_error?.includes("simulated update failure"));
  assertEquals(db.tables.ops_events.length, 1);
  const ev = db.tables.ops_events[0]!;
  assertEquals(ev.event_type, TERMINAL_TRIP_STAMP_FAILED_EVENT);
  assertEquals(ev.trip_id, TRIP);
  assertEquals(ev.amount_pence, 426);
  assertEquals((ev.metadata as Record<string, unknown>).ledger_is_ssot, true);
  assertEquals(db.tables.trips[0]!.driver_net_pence, 425);
});

Deno.test("stamp: readback mismatch is audited (update reported success but did not land)", async () => {
  const db = createFakeDb(seed());
  const client = {
    from(table: string) {
      const b = db.client.from(table);
      if (table !== "trips") return b;
      const origUpdate = b.update;
      b.update = (_p: FakeRow) => origUpdate.call(b, {});
      return b;
    },
  };
  const r = await silenceConsole(() =>
    // deno-lint-ignore no-explicit-any
    stampTerminalOutcomeTripRow({ supabase: client as any, tripId: TRIP, outcome: "ARRIVAL_CANCELLATION", evidence: evidence014 })
  );
  assertEquals(r.stamp_status, "STAMP_READBACK_MISMATCH");
  assertEquals(db.tables.ops_events.length, 1);
  assertEquals((db.tables.ops_events[0]!.metadata as Record<string, unknown>).stamp_status, "STAMP_READBACK_MISMATCH");
});

Deno.test("stamp: provider fee pending → no trip write, no audit", async () => {
  const db = createFakeDb(seed({ fee_status: "ESTIMATED" }));
  const r = await stampTerminalOutcomeTripRow({
    // deno-lint-ignore no-explicit-any
    supabase: db.client as any,
    tripId: TRIP,
    outcome: "ARRIVAL_CANCELLATION",
    evidence: { ...evidence014, provider_fee_confirmed: false, provider_fee_pence: null },
  });
  assertEquals(r.stamp_status, "SKIPPED_PROVIDER_FEE_PENDING");
  assertEquals(db.writes.filter((w) => w.table === "trips").length, 0);
  assertEquals(db.tables.ops_events.length, 0);
});

Deno.test("settlement: stamp failure still posts exactly one TEN 426; replay never duplicates", async () => {
  const db = createFakeDb(seed(), { failUpdate: (table) => table === "trips" });
  const args = {
    // deno-lint-ignore no-explicit-any
    supabase: db.client as any,
    tripId: TRIP,
    driverId: DRIVER,
    serviceAreaId: null,
    feePence: 450,
    outcome: "ARRIVAL_CANCELLATION" as const,
    paymentMethod: "card",
    currencyCode: "GBP",
  };
  const first = await silenceConsole(() => postTerminalOutcomeSettlement(args));
  assertEquals(first.stamp_status, "STAMP_UPDATE_FAILED");
  assertEquals(first.credited, true);
  assertEquals(first.driver_net_pence, 426);
  const second = await silenceConsole(() => postTerminalOutcomeSettlement(args));
  assertEquals(second.credited, true);
  const ten = db.tables.driver_wallet_ledger.filter((r) => r.type === "TRIP_EARNING_NET");
  assertEquals(ten.length, 1);
  assertEquals(ten[0]!.amount_pence, 426);
  assertEquals(ten[0]!.driver_id, DRIVER);
  assertEquals(db.tables.ops_events.length, 2);
});

Deno.test("no-show settlement: status update never re-writes settlement amounts over the stamp", async () => {
  const db = createFakeDb(seed({ status: "no_show", outcome: "NO_SHOW" }));
  const r = await silenceConsole(() =>
    settleNoShowFee({
      // deno-lint-ignore no-explicit-any
      supabase: db.client as any,
      tripId: TRIP,
      driverId: DRIVER,
      passengerId: null,
      paymentMethod: "card",
      currencyCode: "GBP",
      feePence: 450,
      cardCharged: true,
    })
  );
  assertEquals(r.stamp_status, "STAMPED");
  assertEquals(r.status_update_error, null);
  const t = db.tables.trips[0]!;
  assertEquals([t.gross_fare_pence, t.commission_pence, t.provider_fee_pence, t.driver_net_pence], [450, 0, 24, 426]);
  assertEquals(t.status, "no_show");
  assertEquals(t.completed_at, null);
  const statusWrites = db.writes.filter((w) => w.table === "trips" && w.payload.payment_status != null);
  assertEquals(statusWrites.length, 1);
  assertEquals("driver_net_pence" in statusWrites[0]!.payload, false);
  assertEquals("gross_fare_pence" in statusWrites[0]!.payload, false);
  assertEquals(db.tables.driver_wallet_ledger.filter((x) => x.type === "TRIP_EARNING_NET").length, 1);
});
