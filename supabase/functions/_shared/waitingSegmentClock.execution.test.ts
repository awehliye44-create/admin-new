/**
 * Waiting segment clock — enter/leave/resume + stale fail-closed.
 * Run: deno test --no-check --allow-read supabase/functions/_shared/waitingSegmentClock.execution.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_WAITING_RADIUS_METERS,
  TRUSTED_LOCATION_MAX_AGE_MS,
  buildRematchPickupWaitingResetPatch,
  closeOpenWaitingSegments,
  haversineMeters,
  mergeOverlappingIntervalsMs,
  planOpenWaitingSegments,
  resolveEffectiveWaitingRadiusMeters,
  sumSegmentSecondsAt,
  syncWaitingGeofenceClock,
} from "./waitingSegmentClock.ts";
import { createInMemorySupabase } from "./inMemorySupabaseFake.ts";
import {
  eligibleFromMsForPickupTrip,
} from "./scheduledPickupWaitingFairnessSSOT.ts";
import {
  isScheduledEarlyArrivalDueForUnlock,
  unlockScheduledEarlyArrivalWaiting,
} from "./scheduledEarlyArrivalUnlockSSOT.ts";
import { chargeableSecondsFromCounted } from "./waitingSegmentClock.ts";
import { buildPickupWaitingSnapshot } from "./waitingAdminConfig.ts";

Deno.test("configured 150m radius is used; default only when unset", () => {
  assertEquals(resolveEffectiveWaitingRadiusMeters(150, true), 150);
  assertEquals(
    resolveEffectiveWaitingRadiusMeters(0, true),
    DEFAULT_WAITING_RADIUS_METERS,
  );
  assertEquals(resolveEffectiveWaitingRadiusMeters(150, false), 0);
});

Deno.test("MK-261113-003 distance 933m is outside 150m", () => {
  const pickup = { lat: 52.0081825, lng: -0.7884515 };
  // ~933m offset roughly north
  const driver = { lat: 52.0165, lng: -0.7884515 };
  const d = haversineMeters(driver.lat, driver.lng, pickup.lat, pickup.lng);
  assert(d > 150);
  assert(d > 800);
});

Deno.test("trusted location max age remains 45s (fail-closed money)", () => {
  assertEquals(TRUSTED_LOCATION_MAX_AGE_MS, 45_000);
});

Deno.test("pickup snapshot uses counted seconds for free/no-show remaining", () => {
  const started = "2026-11-13T09:19:57.418Z";
  const nowMs = Date.parse(started) + 90_000; // 90s wall
  const snap = buildPickupWaitingSnapshot({
    driverArrivedAt: started,
    waitingStatus: "blocked_outside_radius",
    config: {
      config_available: true,
      free_pickup_waiting_seconds: 180,
      free_pickup_waiting_minutes: 3,
      no_show_waiting_seconds: 300,
      no_show_waiting_minutes: 5,
      pickup_paid_waiting_enabled: true,
      pickup_paid_waiting_rate_pence_per_minute: 30,
      pickup_waiting_max_minutes: 0,
      waiting_charge_interval_seconds: 15,
      waiting_charge_rounding: "completed_intervals",
      no_show_apply_after_arrival_only: true,
      pickup_radius_enabled: true,
      pickup_radius_meters: 150,
      stop_radius_enabled: true,
      stop_radius_meters: 150,
      enable_stop_waiting_charge: false,
      stop_waiting_grace_period_seconds: 180,
      stop_waiting_rate_pence_per_minute: 0,
      stop_waiting_max_minutes: 0,
      stop_waiting_charge_interval_seconds: 15,
      service_area_id: null,
      vehicle_type_id: null,
      trip_id: null,
      driver_id: null,
      frozen_at: null,
      waiting_context: "pickup",
      pickup_grace_source: "fare_pricing",
      waiting_charge_interval_source: "dispatch_settings",
    } as any,
    countedInRadiusSeconds: 0,
    nowMs,
  });
  assertEquals(snap.pickup_waiting_elapsed_seconds, 0);
  assertEquals(snap.pickup_waiting_grace_remaining_seconds, 180);
  assertEquals(snap.no_show_remaining_seconds, 300);
  assertEquals(snap.no_show_eligible, false);
});

Deno.test("blocked_outside_radius is a known waiting status (compat)", async () => {
  const stop = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  assert(stop.includes("blocked_outside_radius"));
  // Arrived still starts session (eligible accumulation separate).
  assert(stop.includes("waiting_still_starts_on_arrived"));
  // Start Trip finalize still uses counted seconds, not wall.
  assert(stop.includes("Never charge full wall-time"));
});

// ---------------------------------------------------------------------------
// Execution tests: freeze / resume / no-overlap (in-memory Supabase)
// ---------------------------------------------------------------------------

const PICKUP = { lat: 52.0081825, lng: -0.7884515 };
const TARGET = { ...PICKUP, radiusMeters: 150, radiusEnabled: true };
const OUTSIDE = { lat: 52.0165, lng: -0.7884515 }; // ~930m
const SCHEDULED = "2026-11-13T14:00:00.000Z";
const iso = (ms: number) => new Date(ms).toISOString();
const SCHED_MS = Date.parse(SCHEDULED);

function trustedAt(nowMs: number, at: { lat: number; lng: number }, ageMs = 1_000) {
  return {
    lat: at.lat,
    lng: at.lng,
    sampledAtIso: iso(nowMs - ageMs),
    source: "driver_presence" as const,
    ageMs,
  };
}

function seedTrip(extra: Record<string, unknown> = {}) {
  return {
    trips: [{
      id: "trip-1",
      pickup_waiting_counted_seconds: 0,
      stop_waiting_counted_seconds: 0,
      ...extra,
    }],
    trip_waiting_segments: [] as Record<string, unknown>[],
  };
}

async function sync(
  sb: ReturnType<typeof createInMemorySupabase>,
  nowMs: number,
  opts: {
    location?: "pickup" | "stop";
    at?: { lat: number; lng: number } | null;
    eligibleFromMs?: number | null;
    ageMs?: number;
    stopId?: string;
  } = {},
) {
  const location = opts.location ?? "pickup";
  return await syncWaitingGeofenceClock(sb, {
    tripId: "trip-1",
    driverId: "driver-1",
    locationType: location,
    stopId: opts.stopId ?? null,
    target: TARGET,
    nowIso: iso(nowMs),
    trusted: opts.at === null ? null : trustedAt(nowMs, opts.at ?? PICKUP, opts.ageMs),
    trustedResolved: true,
    eligibleFromMs: opts.eligibleFromMs ?? null,
  });
}

Deno.test("A1 freeze condition A: initial pickup before scheduled_at never opens a segment", async () => {
  const sb = createInMemorySupabase(seedTrip());
  const r = await sync(sb, SCHED_MS - 600_000, { eligibleFromMs: SCHED_MS });
  assertEquals(r.awaitingScheduledPickup, true);
  assertEquals(r.status, "paused");
  assertEquals(r.inside, false);
  assertEquals(r.countedSeconds, 0);
  assertEquals(r.skipReason, "before_scheduled_pickup");
  assertEquals(sb.db.trip_waiting_segments.length, 0);
  // free + chargeable both frozen at zero
  assertEquals(chargeableSecondsFromCounted(r.countedSeconds, 180), 0);
});

Deno.test("A2 scheduled unlock: segment opens at/after scheduled_at and counts only from then", async () => {
  const sb = createInMemorySupabase(seedTrip());
  await sync(sb, SCHED_MS - 300_000, { eligibleFromMs: SCHED_MS });
  const open = await sync(sb, SCHED_MS, { eligibleFromMs: SCHED_MS });
  assertEquals(open.segmentOpened, true);
  assertEquals(open.status, "counting");
  assertEquals(sb.db.trip_waiting_segments.length, 1);
  const later = await sync(sb, SCHED_MS + 240_000, { eligibleFromMs: SCHED_MS });
  assertEquals(later.countedSeconds, 240);
  assertEquals(later.skipReason, "already_open");
  // free wait 180 → 60 chargeable
  assertEquals(chargeableSecondsFromCounted(later.countedSeconds, 180), 60);
});

Deno.test("A3 freeze condition B: outside radius closes the segment and freezes free + chargeable", async () => {
  const sb = createInMemorySupabase(seedTrip());
  await sync(sb, SCHED_MS, { eligibleFromMs: SCHED_MS });
  const out = await sync(sb, SCHED_MS + 200_000, { at: OUTSIDE, eligibleFromMs: SCHED_MS });
  assertEquals(out.status, "paused");
  assertEquals(out.skipReason, "outside_radius");
  assertEquals(out.countedSeconds, 200);
  assertEquals(sb.db.trip_waiting_segments.filter((r) => !r.ended_at).length, 0);
  // Time passes outside: counter is frozen, never retrospectively counted.
  const still = await sync(sb, SCHED_MS + 900_000, { at: OUTSIDE, eligibleFromMs: SCHED_MS });
  assertEquals(still.countedSeconds, 200);
  assertEquals(chargeableSecondsFromCounted(still.countedSeconds, 180), 20);
});

Deno.test("A4 freeze condition B: stale GPS fails closed (no_trusted_location) and resume opens a NEW segment", async () => {
  const sb = createInMemorySupabase(seedTrip());
  await sync(sb, SCHED_MS, { eligibleFromMs: SCHED_MS });
  const stale = await sync(sb, SCHED_MS + 100_000, { at: null, eligibleFromMs: SCHED_MS });
  assertEquals(stale.skipReason, "no_trusted_location");
  assertEquals(stale.status, "paused");
  assertEquals(stale.countedSeconds, 100);
  // 10 minutes of stale/outside, then back inside.
  const resume = await sync(sb, SCHED_MS + 700_000, { eligibleFromMs: SCHED_MS });
  assertEquals(resume.segmentOpened, true);
  assertEquals(resume.countedSeconds, 100); // gap not counted retroactively
  const after = await sync(sb, SCHED_MS + 760_000, { eligibleFromMs: SCHED_MS });
  assertEquals(after.countedSeconds, 160);
  assertEquals(sb.db.trip_waiting_segments.length, 2);
});

Deno.test("A5 intermediate stop does NOT use scheduled_at freeze", async () => {
  const sb = createInMemorySupabase(seedTrip());
  // Even if a caller (wrongly) passes a future pickup floor, stop waiting ignores it.
  const r = await sync(sb, SCHED_MS - 600_000, {
    location: "stop",
    stopId: "stop-1",
    eligibleFromMs: SCHED_MS,
  });
  assertEquals(r.awaitingScheduledPickup, false);
  assertEquals(r.segmentOpened, true);
  assertEquals(r.status, "counting");
  const later = await sync(sb, SCHED_MS - 540_000, {
    location: "stop",
    stopId: "stop-1",
    eligibleFromMs: SCHED_MS,
  });
  assertEquals(later.countedSeconds, 60);
});

Deno.test("A5b stop freeze B still applies outside radius", async () => {
  const sb = createInMemorySupabase(seedTrip());
  await sync(sb, SCHED_MS, { location: "stop", stopId: "stop-1" });
  const out = await sync(sb, SCHED_MS + 90_000, {
    location: "stop",
    stopId: "stop-1",
    at: OUTSIDE,
  });
  assertEquals(out.status, "paused");
  assertEquals(out.countedSeconds, 90);
  const later = await sync(sb, SCHED_MS + 500_000, {
    location: "stop",
    stopId: "stop-1",
    at: OUTSIDE,
  });
  assertEquals(later.countedSeconds, 90);
});

Deno.test("A6 no overlapping open segments: duplicate opens collapse to one (inside)", async () => {
  const sb = createInMemorySupabase(seedTrip());
  sb.db.trip_waiting_segments.push(
    {
      id: "seg-a", trip_id: "trip-1", location_type: "pickup", stop_id: null,
      started_at: iso(SCHED_MS), ended_at: null, inside_radius: true,
    },
    {
      id: "seg-b", trip_id: "trip-1", location_type: "pickup", stop_id: null,
      started_at: iso(SCHED_MS + 10_000), ended_at: null, inside_radius: true,
    },
  );
  const r = await sync(sb, SCHED_MS + 100_000, { eligibleFromMs: SCHED_MS });
  const open = sb.db.trip_waiting_segments.filter((x) => !x.ended_at);
  assertEquals(open.length, 1);
  assertEquals(open[0].id, "seg-a"); // earliest kept
  assertEquals(r.countedSeconds, 100); // union, not 100 + 90
});

Deno.test("A6b duplicate opens ALL close when outside radius (freeze)", async () => {
  const sb = createInMemorySupabase(seedTrip());
  sb.db.trip_waiting_segments.push(
    {
      id: "seg-a", trip_id: "trip-1", location_type: "pickup", stop_id: null,
      started_at: iso(SCHED_MS), ended_at: null, inside_radius: true,
    },
    {
      id: "seg-b", trip_id: "trip-1", location_type: "pickup", stop_id: null,
      started_at: iso(SCHED_MS + 10_000), ended_at: null, inside_radius: true,
    },
  );
  const r = await sync(sb, SCHED_MS + 100_000, { at: OUTSIDE, eligibleFromMs: SCHED_MS });
  assertEquals(sb.db.trip_waiting_segments.filter((x) => !x.ended_at).length, 0);
  assertEquals(r.countedSeconds, 100);
});

Deno.test("A7 segment no-overlap helpers", () => {
  const plan = planOpenWaitingSegments(
    [
      { id: "b", started_at: iso(2_000) },
      { id: "a", started_at: iso(1_000) },
    ],
    true,
  );
  assertEquals(plan, { openNew: false, keepId: "a", closeIds: ["b"] });
  assertEquals(planOpenWaitingSegments([], true).openNew, true);
  assertEquals(planOpenWaitingSegments([{ id: "a", started_at: iso(1) }], false), {
    openNew: false,
    keepId: null,
    closeIds: ["a"],
  });
  assertEquals(
    mergeOverlappingIntervalsMs([[0, 10], [5, 20], [30, 40], [40, 50]]),
    [[0, 20], [30, 50]],
  );
  // overlapping rows never double count
  assertEquals(
    sumSegmentSecondsAt(
      [
        { started_at: iso(0), ended_at: iso(60_000) },
        { started_at: iso(30_000), ended_at: iso(90_000) },
      ],
      120_000,
    ),
    90,
  );
});

Deno.test("A8 no retrospective outside-radius count; eligible floor clamps pre-scheduled segments", () => {
  const rows = [
    { started_at: iso(SCHED_MS - 300_000), ended_at: iso(SCHED_MS + 60_000) },
    { started_at: iso(SCHED_MS + 300_000), ended_at: null },
  ];
  // Pre-scheduled 300s never count; gap (60s..300s) never counts.
  assertEquals(sumSegmentSecondsAt(rows, SCHED_MS + 360_000, SCHED_MS), 60 + 60);
  // Open row evaluated before it started contributes nothing.
  assertEquals(sumSegmentSecondsAt(rows, SCHED_MS + 200_000, SCHED_MS), 60);
});

Deno.test("A9 closeOpenWaitingSegments honours the pickup eligible floor (Start Trip before scheduled_at)", async () => {
  const sb = createInMemorySupabase(seedTrip());
  // Legacy/pre-D4 row opened before scheduled_at.
  sb.db.trip_waiting_segments.push({
    id: "seg-legacy", trip_id: "trip-1", location_type: "pickup", stop_id: null,
    started_at: iso(SCHED_MS - 600_000), ended_at: null, inside_radius: true,
  });
  const counted = await closeOpenWaitingSegments(sb, {
    tripId: "trip-1",
    locationType: "pickup",
    nowIso: iso(SCHED_MS - 300_000),
    eligibleFromMs: SCHED_MS,
  });
  assertEquals(counted, 0);
  // Without a floor the same evidence would have counted 300s (documents the gap fixed).
  const sb2 = createInMemorySupabase(seedTrip());
  sb2.db.trip_waiting_segments.push({
    id: "seg-legacy", trip_id: "trip-1", location_type: "pickup", stop_id: null,
    started_at: iso(SCHED_MS - 600_000), ended_at: null, inside_radius: true,
  });
  assertEquals(
    await closeOpenWaitingSegments(sb2, {
      tripId: "trip-1",
      locationType: "pickup",
      nowIso: iso(SCHED_MS - 300_000),
    }),
    300,
  );
});

Deno.test("A10 early arrival unlock: gate + auto-open at scheduled_at", async () => {
  const tripRow = {
    id: "trip-1",
    driver_id: "driver-1",
    arrived_at: iso(SCHED_MS - 900_000),
    pickup_arrived_at: iso(SCHED_MS - 900_000),
    scheduled_at: SCHEDULED,
    is_scheduled: true,
    pickup_latitude: PICKUP.lat,
    pickup_longitude: PICKUP.lng,
    pickup_radius_meters: 150,
    pickup_radius_enabled: true,
  };
  const presenceRow = (nowMs: number) => ({
    driver_id: "driver-1",
    lat: PICKUP.lat,
    lng: PICKUP.lng,
    last_gps_sample_at: iso(nowMs - 2_000),
  });

  const before = SCHED_MS - 60_000;
  const sb = createInMemorySupabase({
    ...seedTrip({ started_at: null }),
    driver_presence: [presenceRow(before)],
  });
  const early = await unlockScheduledEarlyArrivalWaiting(sb, tripRow, iso(before));
  assertEquals(early.unlocked, false);
  assertEquals(early.countedSeconds, 0);
  assertEquals(sb.db.trip_waiting_segments.length, 0);

  sb.db.driver_presence[0] = presenceRow(SCHED_MS);
  const due = await unlockScheduledEarlyArrivalWaiting(sb, tripRow, iso(SCHED_MS));
  assertEquals(due.unlocked, true);
  assertEquals(due.status, "counting");
  assertEquals(sb.db.trip_waiting_segments.length, 1);

  // Gate helper agrees at the boundary.
  const gate = {
    status: "arrived_at_pickup",
    scheduledAtIso: SCHEDULED,
    pickupWaitingStartedAt: iso(SCHED_MS - 900_000),
    startedAt: null,
  };
  assertEquals(isScheduledEarlyArrivalDueForUnlock({ ...gate, nowMs: SCHED_MS - 1 }), false);
  assertEquals(isScheduledEarlyArrivalDueForUnlock({ ...gate, nowMs: SCHED_MS }), true);
});

Deno.test("A11 early arrival with stale presence at scheduled_at does not open (fail closed)", async () => {
  const sb = createInMemorySupabase({
    ...seedTrip(),
    driver_presence: [{
      driver_id: "driver-1",
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      last_gps_sample_at: iso(SCHED_MS - 300_000),
    }],
  });
  const r = await unlockScheduledEarlyArrivalWaiting(
    sb,
    {
      id: "trip-1",
      driver_id: "driver-1",
      scheduled_at: SCHEDULED,
      is_scheduled: true,
      arrived_at: iso(SCHED_MS - 900_000),
      pickup_latitude: PICKUP.lat,
      pickup_longitude: PICKUP.lng,
    },
    iso(SCHED_MS),
  );
  assertEquals(r.countedSeconds, 0);
  assertEquals(sb.db.trip_waiting_segments.length, 0);
});

Deno.test("A12 rematch preserves scheduled_at; waiting reset does not touch it; new arrival floors at scheduled_at", () => {
  const reset = buildRematchPickupWaitingResetPatch(iso(SCHED_MS - 3_000_000));
  assert(!("scheduled_at" in reset));
  assert(!("is_scheduled" in reset));
  assertEquals(reset.pickup_waiting_started_at, null);
  assertEquals(reset.pickup_waiting_counted_seconds, 0);
  assertEquals(reset.waiting_geofence_status, "not_started");

  // Replacement driver arrives early again: floor is still the ORIGINAL scheduled_at.
  const trip = {
    arrived_at: iso(SCHED_MS - 600_000),
    pickup_arrived_at: iso(SCHED_MS - 600_000),
    scheduled_at: SCHEDULED,
    is_scheduled: true,
  };
  assertEquals(eligibleFromMsForPickupTrip(trip), SCHED_MS);
  // Replacement arrives late: floor is the late arrival.
  assertEquals(
    eligibleFromMsForPickupTrip({ ...trip, arrived_at: iso(SCHED_MS + 120_000), pickup_arrived_at: null }),
    SCHED_MS + 120_000,
  );
});

Deno.test("A13 source locks: finalize on Start Trip, driver-cancel and admin force-end use shared helpers", async () => {
  const stop = await Deno.readTextFile(new URL("../stop-workflow/index.ts", import.meta.url));
  assert(stop.includes("finalizeEligibleFromMs"));
  const cancel = await Deno.readTextFile(
    new URL("../driver-cancel-before-pickup/index.ts", import.meta.url),
  );
  assert(cancel.includes("buildRematchPickupWaitingResetPatch"));
  assert(cancel.includes("closeAllOpenWaitingSegmentsForTrip"));
  // scheduled_at is never nulled by the cancel/rematch path.
  assert(!/scheduled_at:\s*null/.test(cancel));
  const admin = await Deno.readTextFile(
    new URL("../admin-trip-action/index.ts", import.meta.url),
  );
  assert(admin.includes("closeAllOpenWaitingSegmentsForTrip"));
});
