/**
 * MK-260916-030 regression: scheduled trip → chargeable cancel → payment
 * disposed/captured → schedule-dispatch runs → trip MUST stay cancelled, MUST
 * NOT become searching, MUST NOT broadcast, MUST NOT be acceptable by a driver.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runScheduleDispatchConversionSweep } from "../../functions/_shared/scheduleDispatchConversionSweep.ts";
import {
  buildCancelledScheduledStatePatch,
  isTripTerminalForDispatch,
} from "../../functions/_shared/tripTerminalDispatch.ts";
import { asSupabase, InMemorySupabase } from "./support/inMemorySupabase.ts";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const PICKUP_SOON = new Date(NOW.getTime() + 10 * 60_000).toISOString();

/** accept_ride_offer (live DB) only accepts trips in these statuses. */
const ACCEPT_RIDE_OFFER_TRIP_STATUSES = new Set([
  "pending", "searching", "searching_new_driver", "offered", "broadcasting",
  "offering", "negotiating", "accepted", "confirmed", "driver_assigned",
]);

function scheduledTrip(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    is_scheduled: true,
    dispatch_mode: "scheduled",
    scheduled_status: "scheduled",
    status: "scheduled",
    dispatch_status: null,
    scheduled_at: PICKUP_SOON,
    scheduled_broadcast_at: null,
    scheduled_convert_at: null,
    pickup_latitude: 51.5,
    pickup_longitude: -0.12,
    vehicle_type_id: "vt",
    service_area_id: "sa",
    confirmed_driver_id: null,
    driver_id: null,
    ...overrides,
  };
}

function seed(trips: Array<Record<string, unknown>>) {
  return new InMemorySupabase({
    tables: {
      global_dispatch_settings: [{
        singleton: true,
        enable_scheduled_to_urgent_conversion: true,
        scheduled_response_window_minutes: 5,
        urgent_dispatch_trigger_minutes_before_pickup: 30,
        locked_driver_response_minutes: 5,
        max_driver_find_time_minutes: 10,
        scheduled_urgent_card_label: "Urgent",
        scheduled_rides_enabled: true,
      }],
      trips,
      ride_offers: [],
      payment_sessions: [],
    },
  });
}

/** Mirrors cancel-trip's terminal trip update for a chargeable late cancel. */
function applyChargeableCancel(db: InMemorySupabase, tripId: string) {
  const trip = db.rows("trips").find((t) => t.id === tripId)!;
  Object.assign(trip, {
    status: "cancelled",
    cancelled_at: NOW.toISOString(),
    cancelled_by: "passenger",
    cancellation_reason: "customer_cancelled",
    cancellation_fee_pence: 500,
    financial_outcome: "CANCELLATION_FEE",
    dispatch_status: "cancelled",
    ...buildCancelledScheduledStatePatch(trip),
  });
  db.rows("payment_sessions").push({
    id: `ps-${tripId}`,
    trip_id: tripId,
    status: "captured",
    captured_amount_pence: 500,
  });
}

function sweep(db: InMemorySupabase) {
  const dispatched: string[] = [];
  const gated: string[] = [];
  const run = runScheduleDispatchConversionSweep({
    supabase: asSupabase(db),
    now: NOW,
    triggerAutoDispatch: (tripId) => {
      dispatched.push(tripId);
      return Promise.resolve({ ok: true, data: null });
    },
    assertPaymentGate: (tripId) => {
      gated.push(tripId);
      return Promise.resolve();
    },
    isPaymentGateError: (_e): _e is Error => false,
    logAudit: () => Promise.resolve(),
  });
  return { run, dispatched, gated };
}

function assertStillCancelled(db: InMemorySupabase, tripId: string) {
  const trip = db.rows("trips").find((t) => t.id === tripId)!;
  assertEquals(trip.status, "cancelled", "trip must remain cancelled");
  assert(trip.status !== "searching", "trip must not become searching");
  assert(trip.dispatch_status !== "broadcasting", "trip must not broadcast");
  assert(trip.broadcast_enabled !== true, "broadcast must not be enabled");
  assert(trip.dispatch_mode !== "instant", "must not be converted to instant");
  assert(!ACCEPT_RIDE_OFFER_TRIP_STATUSES.has(String(trip.status)), "driver accept RPC would allow this status");
  assert(isTripTerminalForDispatch(trip as never));
}

Deno.test("cancel-trip patch terminalises scheduled state only for scheduled trips", () => {
  assertEquals(buildCancelledScheduledStatePatch({ is_scheduled: true, scheduled_at: null }), { scheduled_status: "cancelled" });
  assertEquals(buildCancelledScheduledStatePatch({ is_scheduled: null, scheduled_at: PICKUP_SOON }), { scheduled_status: "cancelled" });
  assertEquals(buildCancelledScheduledStatePatch({ is_scheduled: false, scheduled_at: null }), {});
  assertEquals(buildCancelledScheduledStatePatch({ scheduled_at: "  " }), {});
});

Deno.test("cancel-trip applies the scheduled-state patch to its terminal trip update", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/cancel-trip/index.ts", import.meta.url));
  assert(src.includes("is_scheduled, scheduled_status"), "cancel-trip must select scheduled fields");
  const patchAt = src.indexOf("Object.assign(tripUpdate, buildCancelledScheduledStatePatch(trip))");
  const updateAt = src.indexOf(".update(tripUpdate)");
  assert(patchAt > 0 && updateAt > patchAt, "scheduled patch must be applied before the trips update");
});

Deno.test("MK-260916-030: chargeable cancel + captured payment → sweep leaves trip cancelled, no dispatch", async () => {
  const db = seed([scheduledTrip("trip-cancelled")]);
  applyChargeableCancel(db, "trip-cancelled");
  assertEquals(db.rows("trips")[0].scheduled_status, "cancelled");
  const writesBefore = db.writes.length;

  const { run, dispatched, gated } = sweep(db);
  const result = await run;

  assert(result.ok);
  assertEquals(result.convertedToInstant, 0);
  assertEquals(dispatched, [], "auto-dispatch must not be triggered");
  assertEquals(gated, [], "payment gate must not even be evaluated");
  assertEquals(db.writes.slice(writesBefore).filter((w) => w.table === "trips").length, 0);
  assertEquals(db.writesTo("ride_offers").length, 0);
  assertStillCancelled(db, "trip-cancelled");
});

Deno.test("MK-260916-030 legacy shape: cancelled trip with stale scheduled_status=scheduled is never selected", async () => {
  // Exact incident shape: old cancel-trip left scheduled_status non-terminal.
  const db = seed([scheduledTrip("trip-legacy", { status: "cancelled", dispatch_status: null, scheduled_status: "scheduled" })]);
  const { run, dispatched } = sweep(db);
  const result = await run;
  assert(result.ok);
  assertEquals(result.processed, 0);
  assertEquals(dispatched, []);
  assertEquals(db.writesTo("trips").length, 0);
  assertStillCancelled(db, "trip-legacy");
});

Deno.test("every terminal trip status is excluded from conversion", async () => {
  const statuses = ["cancelled", "canceled", "customer_cancelled", "completed", "expired", "no_show"];
  const db = seed(statuses.map((s, i) => scheduledTrip(`t-${i}`, { status: s })));
  const { run, dispatched } = sweep(db);
  const result = await run;
  assert(result.ok);
  assertEquals(result.convertedToInstant, 0);
  assertEquals(dispatched, []);
  for (const [i, s] of statuses.entries()) {
    assertEquals(db.rows("trips").find((t) => t.id === `t-${i}`)!.status, s);
  }
});

Deno.test("conversion update guard: trip cancelled between select and update is not converted", async () => {
  const db = seed([scheduledTrip("trip-race")]);
  const dispatched: string[] = [];
  const result = await runScheduleDispatchConversionSweep({
    supabase: asSupabase(db),
    now: NOW,
    triggerAutoDispatch: (tripId) => {
      dispatched.push(tripId);
      return Promise.resolve({ ok: true, data: null });
    },
    // cancel-trip commits after the candidate query but before the conversion update.
    assertPaymentGate: () => {
      applyChargeableCancel(db, "trip-race");
      return Promise.resolve();
    },
    isPaymentGateError: (_e): _e is Error => false,
    logAudit: () => Promise.resolve(),
  });
  assert(result.ok);
  assertEquals(result.convertedToInstant, 0);
  assertEquals(result.results[0].detail, "convert_matched_0_rows");
  assertEquals(dispatched, []);
  assertEquals(db.writesTo("ride_offers").length, 0);
  assertStillCancelled(db, "trip-race");
});

Deno.test("control: a live scheduled trip inside the urgent window IS converted and dispatched", async () => {
  const db = seed([scheduledTrip("trip-live")]);
  const { run, dispatched } = sweep(db);
  const result = await run;
  assert(result.ok);
  assertEquals(result.convertedToInstant, 1);
  assertEquals(dispatched, ["trip-live"]);
  const trip = db.rows("trips")[0];
  assertEquals(trip.status, "searching");
  assertEquals(trip.scheduled_status, "converted_to_instant");
});
