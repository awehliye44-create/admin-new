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
  buildScheduledPolicySavePayload,
  mapCommitmentPolicyFromDb,
  mapCommitmentPolicyToDb,
  resolveScheduledCommitmentPolicy,
  shouldUseUrgentFallbackTrigger,
  stackingDoesNotBypassCommitmentProtection,
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
});
