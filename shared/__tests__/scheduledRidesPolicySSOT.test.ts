/**
 * Deno tests for scheduled rides policy SSOT.
 * Run: deno test shared/__tests__/scheduledRidesPolicySSOT.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SCHEDULED_BOOKING_POLICY_DEFAULTS,
  SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
  SCHEDULED_REMINDER_POLICY_LINKS,
  STACKING_SCHEDULED_COMMITMENT_HELP,
  STACKING_SCHEDULED_COMMITMENT_LABEL,
  buildSaCommitmentOverridePayload,
  buildScheduledPolicySavePayload,
  computeDynamicScheduledTiming,
  evaluateScheduledStackingFeasibility,
  findOverlappingScheduledCommitments,
  gateStackedOfferAgainstScheduledCommitments,
  hasOverlappingScheduledCommitments,
  mapCommitmentPolicyFromDb,
  mapCommitmentPolicyToDb,
  parseSaCommitmentOverride,
  resolveScheduledCommitmentPolicy,
  resolveScheduledDispatchPath,
  shouldUseUrgentFallbackTrigger,
  stackingDoesNotBypassCommitmentProtection,
  tripSignalsIndicateAirport,
  validateSaCommitmentOverride,
  validateScheduledBookingPolicy,
  validateScheduledCommitmentPolicy,
} from "../scheduledRidesPolicySSOT.ts";

Deno.test("maps missing DB columns to defaults (backwards compatible)", () => {
  const policy = mapCommitmentPolicyFromDb({
    scheduled_rides_enabled: true,
    locked_driver_response_minutes: 4,
  });
  assertEquals(
    policy.check_in_min_lead_minutes,
    SCHEDULED_COMMITMENT_POLICY_DEFAULTS.check_in_min_lead_minutes,
  );
  assertEquals(policy.driver_response_timeout_minutes, 4);
});

Deno.test("reads and saves all commitment policy values round-trip", () => {
  const custom = {
    ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
    check_in_min_lead_minutes: 120,
    early_arrival_buffer_minutes: 12,
    driver_response_timeout_minutes: 5,
    pickup_access_allowance_minutes: 15,
  };
  const again = mapCommitmentPolicyFromDb(mapCommitmentPolicyToDb(custom));
  assertEquals(again, custom);
});

Deno.test("disabling scheduled rides does not delete configuration", () => {
  const payload = buildScheduledPolicySavePayload({
    enabled: false,
    booking: SCHEDULED_BOOKING_POLICY_DEFAULTS,
    commitment: {
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      check_in_min_lead_minutes: 100,
    },
  });
  assertEquals(payload.scheduled_rides_enabled, false);
  assertEquals(payload.check_in_min_lead_minutes, 100);
});

Deno.test("validation boundaries", () => {
  assert(
    validateScheduledCommitmentPolicy({
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      early_arrival_buffer_minutes: -1,
    }).length > 0,
  );
  assertEquals(
    validateScheduledCommitmentPolicy(SCHEDULED_COMMITMENT_POLICY_DEFAULTS),
    [],
  );
  assert(
    validateScheduledCommitmentPolicy({
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      min_gap_between_scheduled_minutes: 5,
      scheduled_turnaround_buffer_minutes: 10,
    }).some((i) => i.field === "min_gap_between_scheduled_minutes"),
  );
  assert(
    validateScheduledBookingPolicy({ max_advance_days: 0 }).length > 0,
  );
});

Deno.test("SA override parse/build + empty inherits global", () => {
  const payload = buildSaCommitmentOverridePayload({
    early_arrival_buffer_minutes: 18,
    check_in_min_lead_minutes: null,
  });
  assertEquals(payload, { early_arrival_buffer_minutes: 18 });

  const cleared = buildSaCommitmentOverridePayload({
    early_arrival_buffer_minutes: null,
  });
  assertEquals(cleared, null);

  const parsed = parseSaCommitmentOverride({
    scheduled_commitment_policy: { early_arrival_buffer_minutes: 18 },
  });
  assertEquals(parsed.early_arrival_buffer_minutes, 18);
  assertEquals(parsed.check_in_min_lead_minutes, undefined);

  const issues = validateSaCommitmentOverride(
    { min_gap_between_scheduled_minutes: 5 },
    {
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      scheduled_turnaround_buffer_minutes: 10,
    },
  );
  assert(issues.some((i) => i.field === "min_gap_between_scheduled_minutes"));
});

Deno.test("SA fallback and location override", () => {
  const sa = resolveScheduledCommitmentPolicy({
    global: { check_in_min_lead_minutes: 90, early_arrival_buffer_minutes: 10 },
    serviceArea: {
      scheduled_commitment_policy: { early_arrival_buffer_minutes: 18 },
    },
  });
  assertEquals(sa.early_arrival_buffer_minutes, 18);
  assertEquals(sa.check_in_min_lead_minutes, 90);
  assertEquals(sa._source, "service_area");

  const loc = resolveScheduledCommitmentPolicy({
    global: { pickup_access_allowance_minutes: 0 },
    locationAccessAllowanceMinutes: 20,
  });
  assertEquals(loc.pickup_access_allowance_minutes, 20);
  assertEquals(loc._access_allowance_source, "location");
});

Deno.test("no-preconfirmed urgent fallback vs confirmed dynamic separation", () => {
  assertEquals(shouldUseUrgentFallbackTrigger({ confirmedDriverId: null }), true);
  assertEquals(shouldUseUrgentFallbackTrigger({ confirmedDriverId: "drv-1" }), false);
});

Deno.test("stacking wording and protection + reminder links", () => {
  assertEquals(
    STACKING_SCHEDULED_COMMITMENT_LABEL,
    "Allow compatible stacking before scheduled commitments",
  );
  assert(STACKING_SCHEDULED_COMMITMENT_HELP.includes("full-queue feasibility"));
  assertEquals(
    stackingDoesNotBypassCommitmentProtection({
      allowAirportStacking: true,
      allowPickupWaitingStacking: true,
      allowStopWaitingStacking: true,
      allowScheduledStacking: true,
    }),
    true,
  );
  assertEquals(SCHEDULED_REMINDER_POLICY_LINKS.length, 9);
  assertEquals(tripSignalsIndicateAirport({ airportChargePence: 500 }), true);
  assertEquals(
    tripSignalsIndicateAirport({ zoneTypes: ["standard", "Airport"] }),
    true,
  );
  assertEquals(
    tripSignalsIndicateAirport({ airportChargePence: 0, zoneTypes: ["city"] }),
    false,
  );
});

Deno.test("dynamic timing from knobs + runtime ETA/workload", () => {
  const pickup = new Date("2030-06-01T12:00:00.000Z");
  const timing = computeDynamicScheduledTiming(
    {
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      early_arrival_buffer_minutes: 10,
      safety_buffer_minutes: 5,
      pickup_access_allowance_minutes: 15,
      check_in_min_lead_minutes: 90,
    },
    {
      scheduledPickupAt: pickup,
      travelEtaMinutes: 20,
      activeWorkloadMinutes: 30,
      pickupWaitingMinutes: 5,
      stopWaitingMinutes: 0,
    },
  );
  // 20+30+5+0+10+5+15 = 85 minutes before pickup
  assertEquals(timing.totalLeadMinutesBeforePickup, 85);
  assertEquals(timing.requiredArrivalLeadMinutes, 30);
  assertEquals(timing.leaveByAt, "2030-06-01T10:35:00.000Z");
  assertEquals(timing.checkInOpensAt, "2030-06-01T10:30:00.000Z");
  assertEquals(timing.startJourneyDueAt, timing.leaveByAt);
  assertEquals(resolveScheduledDispatchPath({ confirmedDriverId: "d1" }), "confirmed_driver_dynamic_policy");
  assertEquals(resolveScheduledDispatchPath({ confirmedDriverId: null }), "urgent_fallback");
});

Deno.test("no overlapping scheduled commitments + stacking feasibility", () => {
  const policy = {
    ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
    min_gap_between_scheduled_minutes: 60,
    scheduled_turnaround_buffer_minutes: 10,
    early_arrival_buffer_minutes: 10,
    safety_buffer_minutes: 0,
    pickup_access_allowance_minutes: 0,
  };

  const overlap = findOverlappingScheduledCommitments(
    [
      {
        id: "a",
        scheduledPickupAt: "2030-06-01T12:00:00.000Z",
        estimatedJobMinutes: 40,
      },
      {
        id: "b",
        scheduledPickupAt: "2030-06-01T12:30:00.000Z",
        estimatedJobMinutes: 20,
      },
    ],
    policy,
  );
  assert(overlap.length > 0);
  assertEquals(hasOverlappingScheduledCommitments(
    [
      {
        scheduledPickupAt: "2030-06-01T12:00:00.000Z",
        estimatedJobMinutes: 20,
      },
      {
        scheduledPickupAt: "2030-06-01T14:00:00.000Z",
        estimatedJobMinutes: 20,
      },
    ],
    policy,
  ), false);

  const blocked = evaluateScheduledStackingFeasibility({
    allowScheduledStacking: false,
    policy,
    queue: [
      { kind: "active", durationMinutes: 10 },
      {
        kind: "scheduled",
        id: "s1",
        durationMinutes: 30,
        scheduledPickupAt: "2030-06-01T15:00:00.000Z",
      },
    ],
    now: "2030-06-01T12:00:00.000Z",
  });
  assertEquals(blocked.reason, "stacked_scheduled_blocked");
  assertEquals(blocked.allowed, false);

  const delayed = evaluateScheduledStackingFeasibility({
    allowScheduledStacking: true,
    policy,
    queue: [
      { kind: "candidate", durationMinutes: 120 },
      {
        kind: "scheduled",
        id: "s1",
        durationMinutes: 30,
        scheduledPickupAt: "2030-06-01T13:00:00.000Z",
      },
    ],
    now: "2030-06-01T12:00:00.000Z",
  });
  assertEquals(delayed.allowed, false);
  assertEquals(delayed.reason, "scheduled_pickup_would_be_delayed");

  const ok = evaluateScheduledStackingFeasibility({
    allowScheduledStacking: true,
    policy,
    queue: [
      { kind: "candidate", durationMinutes: 20 },
      {
        kind: "scheduled",
        id: "s1",
        durationMinutes: 30,
        scheduledPickupAt: "2030-06-01T15:00:00.000Z",
      },
    ],
    now: "2030-06-01T12:00:00.000Z",
  });
  assertEquals(ok.allowed, true);
  assertEquals(ok.reason, "ok");

  const gated = gateStackedOfferAgainstScheduledCommitments({
    allowScheduledStacking: false,
    policy,
    activeRemainingMinutes: 10,
    candidateDurationMinutes: 20,
    scheduledCommitments: [
      {
        id: "s1",
        scheduledPickupAt: "2030-06-01T15:00:00.000Z",
        estimatedJobMinutes: 30,
      },
    ],
    now: "2030-06-01T12:00:00.000Z",
  });
  assertEquals(gated.allowed, false);
  assertEquals(gated.reason, "stacked_scheduled_blocked");
});
