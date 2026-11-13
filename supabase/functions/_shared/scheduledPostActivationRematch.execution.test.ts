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

