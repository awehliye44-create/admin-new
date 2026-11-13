/**
 * D1–D8 scheduled post-activation rematch / fairness execution tests.
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildScheduledOriginDriverCancelRematchPatch,
  buildInstantOriginDriverCancelRematchPatch,
  shouldConvertScheduledOriginOnDriverCancel,
  isAccidentOrBreakdownCancelReason,
  normalizeDriverCancelReason,
  DRIVER_CANCEL_REMATCH_CAS_STATUSES,
} from "./scheduledDriverCancelRematchSSOT.ts";
import {
  resolveScheduledPickupEligibleFromMs,
  isBeforeScheduledPickupEligibleWindow,
} from "./scheduledPickupWaitingFairnessSSOT.ts";
import { sumSegmentSecondsAt } from "./waitingSegmentClock.ts";
import { buildPickupWaitingSnapshot } from "./waitingAdminConfig.ts";
import { createInMemorySupabase } from "./inMemorySupabaseFake.ts";
import {
  buildExclusiveActivationOfferSnapshot,
  buildExclusiveActivationRideOfferPush,
} from "./scheduledActivationExclusiveSSOT.ts";
import { rebroadcastTripViaAutoDispatch } from "./dispatchOrchestrator.ts";
import {
  shouldSurfacePostActivationLateness,
  buildTrafficDelayNotificationId,
} from "./scheduledPostActivationLatenessSSOT.ts";

Deno.test("D1: scheduled-origin cancel patch converts to instant rematch", () => {
  assert(
    shouldConvertScheduledOriginOnDriverCancel({
      dispatch_mode: "scheduled",
      scheduled_status: "driver_en_route",
      is_scheduled: true,
      scheduled_at: "2026-11-13T14:00:00.000Z",
    }),
  );
  const patch = buildScheduledOriginDriverCancelRematchPatch({
    nowIso: "2026-11-13T13:50:00.000Z",
    searchingExpiresAtIso: "2026-11-13T13:56:00.000Z",
    maxExistingBroadcastRound: 3,
    maxBroadcastSequences: 9,
    excludeDriverId: "driver-a",
    existingExcludedDriverIds: [],
    existingCancelledDriverIds: [],
    cancelReason: "Vehicle breakdown",
  });
  assertEquals(patch.dispatch_mode, "instant");
  assertEquals(patch.scheduled_status, "converted_to_instant");
  assertEquals(patch.status, "searching_new_driver");
  assertEquals(patch.confirmed_driver_id, null);
  assertEquals(patch.driver_id, null);
  assertEquals(patch.searching_expires_at, "2026-11-13T13:56:00.000Z");
  assertEquals(patch.cancel_reason, "Vehicle breakdown");
  assertEquals(patch.scheduled_ack_status, "cancelled");
  assertEquals(patch.scheduled_jit_activate_at, null);
  assert((patch.excluded_driver_ids as string[]).includes("driver-a"));
  assert((patch.cancelled_driver_ids as string[]).includes("driver-a"));
  const expires = Date.parse(String(patch.searching_expires_at));
  const now = Date.parse("2026-11-13T13:50:00.000Z");
  assertEquals(Math.round((expires - now) / 60_000), 6);
});

Deno.test("D1: instant-origin rematch keeps existing rematch shape", () => {
  assertEquals(
    shouldConvertScheduledOriginOnDriverCancel({
      dispatch_mode: "instant",
      scheduled_status: "converted_to_instant",
    }),
    false,
  );
  const patch = buildInstantOriginDriverCancelRematchPatch({
    nowIso: "2026-11-13T12:00:00.000Z",
    searchingExpiresAtIso: "2026-11-13T12:03:00.000Z",
    rematchBroadcastRound: 3,
    excludeDriverId: "d1",
    cancelReason: "driver_cancelled",
  });
  assertEquals(patch.status, "searching_new_driver");
  assertEquals(patch.dispatch_mode, undefined);
});

Deno.test("D3: rematch CAS status list excludes in_progress", () => {
  assert(
    !(DRIVER_CANCEL_REMATCH_CAS_STATUSES as readonly string[]).includes(
      "in_progress",
    ),
  );
  assert(
    (DRIVER_CANCEL_REMATCH_CAS_STATUSES as readonly string[]).includes(
      "en_route_to_pickup",
    ),
  );
  assert(
    (DRIVER_CANCEL_REMATCH_CAS_STATUSES as readonly string[]).includes(
      "arrived_at_pickup",
    ),
  );
});

Deno.test("D4: eligible floor is max(arrived, scheduled)", () => {
  const arrived = "2026-11-13T13:45:00.000Z";
  const scheduled = "2026-11-13T14:00:00.000Z";
  const from = resolveScheduledPickupEligibleFromMs({
    arrivedAtIso: arrived,
    scheduledAtIso: scheduled,
    isScheduledOrigin: true,
  });
  assertEquals(from, Date.parse(scheduled));
  assert(
    isBeforeScheduledPickupEligibleWindow({
      nowMs: Date.parse("2026-11-13T13:50:00.000Z"),
      arrivedAtIso: arrived,
      scheduledAtIso: scheduled,
      isScheduledOrigin: true,
    }),
  );
  const lateArrive = resolveScheduledPickupEligibleFromMs({
    arrivedAtIso: "2026-11-13T14:07:00.000Z",
    scheduledAtIso: scheduled,
    isScheduledOrigin: true,
  });
  assertEquals(lateArrive, Date.parse("2026-11-13T14:07:00.000Z"));
});

Deno.test("D4: segment sum clamps pre-scheduled time to zero", () => {
  const scheduledMs = Date.parse("2026-11-13T14:00:00.000Z");
  const rows = [
    {
      started_at: "2026-11-13T13:45:00.000Z",
      ended_at: "2026-11-13T14:05:00.000Z",
    },
  ];
  assertEquals(
    sumSegmentSecondsAt(rows, Date.parse("2026-11-13T14:05:00.000Z")),
    20 * 60,
  );
  assertEquals(
    sumSegmentSecondsAt(
      rows,
      Date.parse("2026-11-13T14:05:00.000Z"),
      scheduledMs,
    ),
    5 * 60,
  );
  assertEquals(
    sumSegmentSecondsAt(
      rows,
      Date.parse("2026-11-13T13:59:00.000Z"),
      scheduledMs,
    ),
    0,
  );
});

Deno.test("D4: pickup snapshot freezes before scheduled pickup", () => {
  const config = {
    free_pickup_waiting_seconds: 180,
    free_pickup_waiting_minutes: 3,
    pickup_paid_waiting_enabled: true,
    pickup_paid_waiting_rate_pence_per_minute: 20,
    waiting_charge_interval_seconds: 60,
    waiting_charge_interval_source: "dispatch_settings",
    pickup_waiting_max_minutes: 30,
    no_show_waiting_seconds: 300,
    no_show_apply_after_arrival_only: true,
    pickup_radius_meters: 150,
    pickup_radius_enabled: true,
    config_available: true,
    enable_stop_waiting_charge: false,
    free_stop_waiting_seconds: 60,
    stop_waiting_rate_pence_per_minute: 0,
    stop_grace_source: "default",
    pickup_grace_source: "dispatch_settings",
  };
  const snap = buildPickupWaitingSnapshot({
    driverArrivedAt: "2026-11-13T13:45:00.000Z",
    waitingStatus: "free_waiting",
    // deno-lint-ignore no-explicit-any
    config: config as any,
    nowMs: Date.parse("2026-11-13T13:50:00.000Z"),
    countedInRadiusSeconds: 0,
    scheduledAtIso: "2026-11-13T14:00:00.000Z",
    isScheduledOrigin: true,
  });
  assertEquals(snap.pickup_waiting_state, "awaiting_scheduled_pickup");
  assertEquals(snap.pickup_waiting_elapsed_seconds, 0);
  assertEquals(snap.pickup_waiting_grace_remaining_seconds, 180);
  assertEquals(snap.no_show_eligible, false);
});

Deno.test("D5: late passenger fee fairness source lock", () => {
  const src = Deno.readTextFileSync(
    new URL("./terminalFeeDecisionSSOT.ts", import.meta.url),
  );
  assert(src.includes("driverLateNoArrival"));
  assert(src.includes("rematchInProgress"));
});

Deno.test("D6: lateness surface without auto-reassign", () => {
  const v = shouldSurfacePostActivationLateness({
    nowMs: Date.parse("2026-11-13T14:10:00.000Z"),
    scheduledAtIso: "2026-11-13T14:00:00.000Z",
    status: "en_route_to_pickup",
    scheduledStatus: "driver_en_route",
    driverId: "d1",
    gpsSampledAtIso: "2026-11-13T14:09:00.000Z",
  });
  assertEquals(v.lateVsPickup, true);
  assertEquals(v.escalate, true);
  assertEquals(v.minutesPastPickup, 10);
  assertEquals(
    buildTrafficDelayNotificationId("trip-1"),
    "traffic_delay_scheduled:trip-1",
  );
});

Deno.test("D7: accident/breakdown reason preserved helpers", () => {
  assert(isAccidentOrBreakdownCancelReason("Accident on M1"));
  assert(isAccidentOrBreakdownCancelReason("Vehicle breakdown"));
  assertEquals(normalizeDriverCancelReason("  Accident  "), "Accident");
});

Deno.test("D2/D8/D1 source locks", () => {
  const dispatch = Deno.readTextFileSync(
    new URL("../scheduled-dispatch/index.ts", import.meta.url),
  );
  assert(dispatch.includes('.is("confirmed_driver_id", null)'));
  assert(dispatch.includes("scheduledPostActivationLatenessSSOT"));
  assert(dispatch.includes("scheduledEarlyArrivalUnlockSSOT"));
  assert(dispatch.includes("SCHEDULED_EARLY_ARRIVAL_UNLOCK"));
  const getActive = Deno.readTextFileSync(
    new URL("../get-active-trip/index.ts", import.meta.url),
  );
  assert(getActive.includes('scheduledStatusLive === "driver_en_route"'));
  assert(getActive.includes("early_arrival"));
  assert(getActive.includes("eligible_waiting_from_at"));
  const cancelEdge = Deno.readTextFileSync(
    new URL("../driver-cancel-before-pickup/index.ts", import.meta.url),
  );
  assert(cancelEdge.includes("buildScheduledOriginDriverCancelRematchPatch"));
  assert(cancelEdge.includes('.is("started_at", null)'));
  assert(cancelEdge.includes("DRIVER_CANCEL_REMATCH_CAS_STATUSES"));
  const stopWf = Deno.readTextFileSync(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  assert(stopWf.includes('.is("confirmed_driver_id", null)'));
  assert(stopWf.includes("ASSIGNMENT_TAKEN"));
  assert(stopWf.includes("eligibleFromMsForPickupTrip"));
  assert(stopWf.includes("early_arrival"));
});

Deno.test("D4 early arrival unlock gate — due only at/after scheduled_at", async () => {
  const { isScheduledEarlyArrivalDueForUnlock } = await import(
    "./scheduledEarlyArrivalUnlockSSOT.ts"
  );
  const base = {
    status: "arrived_at_pickup",
    scheduledAtIso: "2026-11-13T14:00:00.000Z",
    pickupWaitingStartedAt: "2026-11-13T13:45:00.000Z",
    startedAt: null as string | null,
  };
  assertEquals(
    isScheduledEarlyArrivalDueForUnlock({
      ...base,
      nowMs: Date.parse("2026-11-13T13:59:00.000Z"),
    }),
    false,
  );
  assertEquals(
    isScheduledEarlyArrivalDueForUnlock({
      ...base,
      nowMs: Date.parse("2026-11-13T14:00:00.000Z"),
    }),
    true,
  );
  assertEquals(
    isScheduledEarlyArrivalDueForUnlock({
      ...base,
      nowMs: Date.parse("2026-11-13T14:00:00.000Z"),
      startedAt: "2026-11-13T13:50:00.000Z",
    }),
    false,
  );
});


// ---------------------------------------------------------------------------
// D1–D8 execution: ownership CAS races + replacement offer creation
// (in-memory compare-and-set — each filtered UPDATE is atomic like a Postgres row CAS)
// ---------------------------------------------------------------------------

const SCHEDULED_AT = "2026-11-13T14:00:00.000Z";
const TERMINAL_STATUSES =
  "(completed,cancelled,canceled,customer_cancelled,expired,expired_no_driver,no_show,declined,in_progress)";

function scheduledTrip(extra: Record<string, unknown> = {}) {
  return {
    id: "trip-1",
    status: "driver_en_route",
    confirmed_driver_id: "driver-a",
    driver_id: "driver-a",
    started_at: null,
    dispatch_mode: "scheduled",
    scheduled_status: "driver_en_route",
    is_scheduled: true,
    scheduled_at: SCHEDULED_AT,
    excluded_driver_ids: [],
    cancelled_driver_ids: [],
    current_broadcast_round: 2,
    final_fare_pence: 480,
    ...extra,
  };
}

/** Same query shape as driver-cancel-before-pickup ownership CAS. */
function driverCancelCas(
  sb: ReturnType<typeof createInMemorySupabase>,
  driverId: string,
  patch: Record<string, unknown>,
) {
  return sb
    .from("trips")
    .update(patch)
    .eq("id", "trip-1")
    .eq("confirmed_driver_id", driverId)
    .in("status", [...DRIVER_CANCEL_REMATCH_CAS_STATUSES])
    .is("started_at", null)
    .select("id, status")
    .maybeSingle();
}

/** Same query shape as stop-workflow offer-claim CAS. */
function offerClaimCas(sb: ReturnType<typeof createInMemorySupabase>, driverId: string) {
  return sb
    .from("trips")
    .update({ driver_id: driverId, confirmed_driver_id: driverId, status: "accepted" })
    .eq("id", "trip-1")
    .is("confirmed_driver_id", null)
    .is("started_at", null)
    .not("status", "in", TERMINAL_STATUSES)
    .select("id");
}

function buildPatch(excludeDriverId = "driver-a") {
  return buildScheduledOriginDriverCancelRematchPatch({
    nowIso: "2026-11-13T13:50:00.000Z",
    searchingExpiresAtIso: "2026-11-13T13:56:00.000Z",
    maxExistingBroadcastRound: 2,
    maxBroadcastSequences: 9,
    excludeDriverId,
    cancelReason: "Vehicle breakdown",
  });
}

Deno.test("B1 ownership race: two drivers claiming a free trip — exactly one wins", async () => {
  const sb = createInMemorySupabase({
    trips: [scheduledTrip({ confirmed_driver_id: null, driver_id: null, status: "searching_new_driver" })],
  });
  const [b, c] = await Promise.all([offerClaimCas(sb, "driver-b"), offerClaimCas(sb, "driver-c")]);
  const winners = [b, c].filter((r) => (r.data as unknown[]).length === 1);
  assertEquals(winners.length, 1);
  const trip = sb.db.trips[0];
  assert(["driver-b", "driver-c"].includes(trip.confirmed_driver_id as string));
  assertEquals(trip.driver_id, trip.confirmed_driver_id);
});

Deno.test("B2 ownership race: driver A cancel vs replacement claim — loser gets ASSIGNMENT_TAKEN / CONFLICT, never both", async () => {
  const sb = createInMemorySupabase({ trips: [scheduledTrip()] });
  // A cancels (wins).
  const cancel = await driverCancelCas(sb, "driver-a", buildPatch());
  assertEquals((cancel.data as { id: string } | null)?.id, "trip-1");
  // B claims the now-free trip (wins).
  const claim = await offerClaimCas(sb, "driver-b");
  assertEquals((claim.data as unknown[]).length, 1);
  // A's replayed cancel now misses the CAS (assignment changed) — cannot clobber B.
  const replay = await driverCancelCas(sb, "driver-a", buildPatch());
  assertEquals(replay.data, null);
  assertEquals(sb.db.trips[0].confirmed_driver_id, "driver-b");
  // C's late claim misses → stop-workflow returns ASSIGNMENT_TAKEN.
  const late = await offerClaimCas(sb, "driver-c");
  assertEquals((late.data as unknown[]).length, 0);
  assertEquals(sb.db.trips[0].confirmed_driver_id, "driver-b");
});

Deno.test("B3 ownership race: claim lands FIRST — A's cancel CAS misses and the claim survives", async () => {
  // Trip already re-assigned to B (e.g. admin / JIT reassignment) while A's cancel is in flight.
  const sb = createInMemorySupabase({
    trips: [scheduledTrip({ confirmed_driver_id: "driver-b", driver_id: "driver-b" })],
  });
  const cancel = await driverCancelCas(sb, "driver-a", buildPatch());
  assertEquals(cancel.data, null);
  assertEquals(sb.db.trips[0].confirmed_driver_id, "driver-b");
  assertEquals(sb.db.trips[0].status, "driver_en_route");
});

Deno.test("B4 concurrent double-cancel from the same driver — single rematch (idempotent CAS)", async () => {
  const sb = createInMemorySupabase({ trips: [scheduledTrip()] });
  const [x, y] = await Promise.all([
    driverCancelCas(sb, "driver-a", buildPatch()),
    driverCancelCas(sb, "driver-a", buildPatch()),
  ]);
  const hits = [x, y].filter((r) => r.data != null);
  assertEquals(hits.length, 1);
  const cancelWrites = sb.writes.filter((w) => w.table === "trips" && w.matched > 0);
  assertEquals(cancelWrites.length, 1);
});

Deno.test("B5 CAS refuses in_progress / started trips (D3)", async () => {
  const started = createInMemorySupabase({
    trips: [scheduledTrip({ status: "in_progress", started_at: "2026-11-13T14:01:00.000Z" })],
  });
  assertEquals((await driverCancelCas(started, "driver-a", buildPatch())).data, null);
  const startedOnly = createInMemorySupabase({
    trips: [scheduledTrip({ started_at: "2026-11-13T14:01:00.000Z" })],
  });
  assertEquals((await driverCancelCas(startedOnly, "driver-a", buildPatch())).data, null);
  // A late claim cannot steal an in-progress trip either.
  const free = createInMemorySupabase({
    trips: [scheduledTrip({ status: "in_progress", confirmed_driver_id: null, driver_id: null })],
  });
  assertEquals(((await offerClaimCas(free, "driver-b")).data as unknown[]).length, 0);
});

Deno.test("B6 rematch outcome: ownership cleared, A excluded, scheduled_at + fare untouched", async () => {
  const sb = createInMemorySupabase({ trips: [scheduledTrip()] });
  await driverCancelCas(sb, "driver-a", buildPatch());
  const t = sb.db.trips[0];
  assertEquals(t.status, "searching_new_driver");
  assertEquals(t.confirmed_driver_id, null);
  assertEquals(t.driver_id, null);
  assertEquals(t.scheduled_at, SCHEDULED_AT); // preserved through conversion
  assertEquals(t.final_fare_pence, 480); // fare never rewritten by rematch
  assertEquals(t.dispatch_mode, "instant");
  assertEquals(t.scheduled_status, "converted_to_instant");
  assert((t.excluded_driver_ids as string[]).includes("driver-a"));
  assert((t.cancelled_driver_ids as string[]).includes("driver-a"));
  assertEquals(t.previous_driver_id, "driver-a");
});

Deno.test("B7 replacement offer creation: auto-dispatch is invoked with force_rebroadcast after the CAS wins", async () => {
  const invoked: Array<{ name: string; body: Record<string, unknown> }> = [];
  const sb = createInMemorySupabase({ trips: [scheduledTrip()] });
  const client = {
    from: sb.from,
    rpc: () => Promise.resolve({ data: null, error: null }),
    functions: {
      invoke: (name: string, opts: { body: Record<string, unknown> }) => {
        invoked.push({ name, body: opts.body });
        return Promise.resolve({ data: { offers_created: 3 }, error: null });
      },
    },
  };
  const cas = await driverCancelCas(sb, "driver-a", buildPatch());
  assert(cas.data != null);
  const result = await rebroadcastTripViaAutoDispatch(
    client as never,
    "trip-1",
    "driver_cancel_before_pickup",
  );
  assertEquals(result, { ok: true, path: "auto_dispatch" });
  assertEquals(invoked.length, 1);
  assertEquals(invoked[0].name, "auto-dispatch");
  assertEquals(invoked[0].body, {
    trip_id: "trip-1",
    force_rebroadcast: true,
    trigger_reason: "driver_cancel_before_pickup",
  });

  // A CAS miss must NOT create any replacement offer (caller returns 409 before rebroadcast).
  const sb2 = createInMemorySupabase({
    trips: [scheduledTrip({ confirmed_driver_id: "driver-b", driver_id: "driver-b" })],
  });
  const miss = await driverCancelCas(sb2, "driver-a", buildPatch());
  assertEquals(miss.data, null);
  assertEquals(invoked.length, 1);
});

Deno.test("B8 replacement offer creation: dispatch failure surfaces, never silently ok", async () => {
  const client = {
    from: () => ({}),
    rpc: () => Promise.resolve({ data: null, error: null }),
    functions: {
      invoke: () => Promise.resolve({ data: null, error: { message: "auto-dispatch 500" } }),
    },
  };
  const r = await rebroadcastTripViaAutoDispatch(client as never, "trip-1", "driver_cancel_before_pickup");
  assertEquals(r.ok, false);
  assertEquals(r.error, "auto-dispatch 500");
});

Deno.test("B9 replacement exclusive offer for driver B keeps scheduled_at, fare net and excludes nothing of B", () => {
  const trip = scheduledTrip({
    scheduled_status: "converted_to_instant",
    pickup_address: "A",
    dropoff_address: "B",
    driver_net_pence: 410,
  });
  const snap = buildExclusiveActivationOfferSnapshot({
    trip: trip as never,
    confirmedDriverId: "driver-b",
    netPence: 410,
    kind: "activation",
    expiresAtIso: "2026-11-13T14:05:00.000Z",
    departureAcknowledgement: true,
    ackNonce: "nonce-1",
  });
  assertEquals(snap.scheduled_at, SCHEDULED_AT);
  assertEquals(snap.confirmed_driver_id, "driver-b");
  assertEquals(snap.driver_net_pence, 410);
  assertEquals(snap.negotiation_disabled, true);
  assertEquals(snap.accept_action, "heading_to_pickup");
  const push = buildExclusiveActivationRideOfferPush({
    offerId: "offer-b",
    tripId: "trip-1",
    driverId: "driver-b",
    netPence: 410,
    expiresAtIso: "2026-11-13T14:05:00.000Z",
    pickupAddress: "A",
    dropoffAddress: "B",
  });
  assertEquals(push.data.driver_id, "driver-b");
  assertEquals(push.data.offer_id, "offer-b");
  assertEquals(push.data.driver_net_preview_pence, "410");
});

Deno.test("B10 instant-origin cancel keeps CAS + searching_new_driver and never nulls scheduled_at", async () => {
  const sb = createInMemorySupabase({
    trips: [scheduledTrip({ dispatch_mode: "instant", is_scheduled: false, scheduled_at: null })],
  });
  const patch = buildInstantOriginDriverCancelRematchPatch({
    nowIso: "2026-11-13T13:50:00.000Z",
    searchingExpiresAtIso: "2026-11-13T13:56:00.000Z",
    rematchBroadcastRound: 3,
    excludeDriverId: "driver-a",
    cancelReason: "Customer not found",
  });
  assert(!("scheduled_at" in patch));
  const cas = await driverCancelCas(sb, "driver-a", patch);
  assert(cas.data != null);
  assertEquals(sb.db.trips[0].confirmed_driver_id, null);
  assertEquals(sb.db.trips[0].current_broadcast_round, 3);
});
