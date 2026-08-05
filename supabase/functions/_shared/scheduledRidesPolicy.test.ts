import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
  computeDynamicScheduledTiming,
  evaluateScheduledStackingFeasibility,
  gateStackedOfferAgainstScheduledCommitments,
  resolveScheduledCommitmentPolicy,
  resolveScheduledDispatchPath,
  shouldUseUrgentFallbackTrigger,
  tripSignalsIndicateAirport,
} from "./scheduledRidesPolicy.ts";

Deno.test("edge urgent fallback gate mirrors SSOT", () => {
  assertEquals(shouldUseUrgentFallbackTrigger({ confirmedDriverId: null }), true);
  assertEquals(shouldUseUrgentFallbackTrigger({ confirmedDriverId: "x" }), false);
  assertEquals(
    shouldUseUrgentFallbackTrigger({
      confirmedDriverId: null,
      enableScheduledToUrgentConversion: false,
    }),
    false,
  );
  assertEquals(
    resolveScheduledDispatchPath({ confirmedDriverId: "drv" }),
    "confirmed_driver_dynamic_policy",
  );
  assertEquals(
    resolveScheduledDispatchPath({ confirmedDriverId: null }),
    "urgent_fallback",
  );
});

Deno.test("edge re-exports resolve helper for runtime consumers", () => {
  const resolved = resolveScheduledCommitmentPolicy({
    global: { check_in_min_lead_minutes: 80 },
    serviceArea: {
      scheduled_commitment_policy: { early_arrival_buffer_minutes: 14 },
    },
    locationAccessAllowanceMinutes: 9,
  });
  assertEquals(resolved.check_in_min_lead_minutes, 80);
  assertEquals(resolved.early_arrival_buffer_minutes, 14);
  assertEquals(resolved.pickup_access_allowance_minutes, 9);
  assertEquals(resolved._access_allowance_source, "location");
});

Deno.test("edge re-exports dynamic timing + stacking feasibility", () => {
  const timing = computeDynamicScheduledTiming(
    SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
    {
      scheduledPickupAt: "2030-06-01T12:00:00.000Z",
      travelEtaMinutes: 15,
      activeWorkloadMinutes: 0,
    },
  );
  assertEquals(typeof timing.leaveByAt, "string");
  assertEquals(timing.startJourneyDueAt, timing.leaveByAt);

  const result = evaluateScheduledStackingFeasibility({
    allowScheduledStacking: true,
    policy: SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
    queue: [
      { kind: "candidate", durationMinutes: 10 },
      {
        kind: "scheduled",
        durationMinutes: 20,
        scheduledPickupAt: "2030-06-01T18:00:00.000Z",
      },
    ],
    now: "2030-06-01T12:00:00.000Z",
  });
  assertEquals(result.allowed, true);

  const gated = gateStackedOfferAgainstScheduledCommitments({
    allowScheduledStacking: true,
    policy: SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
    activeRemainingMinutes: 5,
    candidateDurationMinutes: 10,
    scheduledCommitments: [
      {
        scheduledPickupAt: "2030-06-01T18:00:00.000Z",
        estimatedJobMinutes: 20,
      },
    ],
    now: "2030-06-01T12:00:00.000Z",
  });
  assertEquals(gated.allowed, true);
});

Deno.test("edge re-exports airport stacking signal helper", () => {
  assertEquals(tripSignalsIndicateAirport({ airportChargePence: 1 }), true);
  assertEquals(tripSignalsIndicateAirport({ zoneTypes: ["airport"] }), true);
  assertEquals(tripSignalsIndicateAirport({ zoneTypes: ["town"] }), false);
});
