import { describe, expect, it } from "vitest";
import {
  SCHEDULED_BOOKING_POLICY_DEFAULTS,
  SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
  SCHEDULED_REMINDER_POLICY_LINKS,
  STACKING_SCHEDULED_COMMITMENT_LABEL,
  STACKING_SCHEDULED_COMMITMENT_HELP,
  buildSaCommitmentOverridePayload,
  buildScheduledPolicySavePayload,
  computeDynamicScheduledTiming,
  evaluateScheduledStackingFeasibility,
  findOverlappingScheduledCommitments,
  hasOverlappingScheduledCommitments,
  mapCommitmentPolicyFromDb,
  mapCommitmentPolicyToDb,
  parseSaCommitmentOverride,
  resolveScheduledCommitmentPolicy,
  resolveScheduledDispatchPath,
  shouldUseUrgentFallbackTrigger,
  stackingDoesNotBypassCommitmentProtection,
  validateSaCommitmentOverride,
  validateScheduledBookingPolicy,
  validateScheduledCommitmentPolicy,
} from "../../../shared/scheduledRidesPolicySSOT";

describe("scheduledRidesPolicySSOT — read/save", () => {
  it("maps missing DB columns to defaults (backwards compatible)", () => {
    const policy = mapCommitmentPolicyFromDb({
      scheduled_rides_enabled: true,
      locked_driver_response_minutes: 4,
    });
    expect(policy.check_in_min_lead_minutes).toBe(
      SCHEDULED_COMMITMENT_POLICY_DEFAULTS.check_in_min_lead_minutes,
    );
    expect(policy.driver_response_timeout_minutes).toBe(4);
    expect(policy.pickup_access_allowance_minutes).toBe(0);
  });

  it("reads and saves all commitment policy values round-trip", () => {
    const custom = {
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      check_in_min_lead_minutes: 120,
      check_in_grace_minutes: 20,
      early_arrival_buffer_minutes: 12,
      safety_buffer_minutes: 8,
      start_journey_grace_minutes: 6,
      driver_location_freshness_seconds: 90,
      driver_response_timeout_minutes: 5,
      not_moving_detection_minutes: 4,
      rescue_search_lead_minutes: 30,
      admin_escalation_lead_minutes: 40,
      scheduled_turnaround_buffer_minutes: 12,
      min_gap_between_scheduled_minutes: 20,
      expected_pickup_waiting_minutes: 7,
      expected_stop_waiting_minutes: 9,
      eta_risk_tolerance_minutes: 6,
      pickup_access_allowance_minutes: 15,
    };
    const db = mapCommitmentPolicyToDb(custom);
    expect(db.locked_driver_response_minutes).toBe(5);
    const again = mapCommitmentPolicyFromDb(db);
    expect(again).toEqual(custom);
  });

  it("save payload keeps config when disabling scheduled rides", () => {
    const payload = buildScheduledPolicySavePayload({
      enabled: false,
      booking: SCHEDULED_BOOKING_POLICY_DEFAULTS,
      commitment: {
        ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
        check_in_min_lead_minutes: 100,
      },
    });
    expect(payload.scheduled_rides_enabled).toBe(false);
    expect(payload.check_in_min_lead_minutes).toBe(100);
    expect(payload.min_advance_time_minutes).toBe(
      SCHEDULED_BOOKING_POLICY_DEFAULTS.min_advance_time_minutes,
    );
  });
});

describe("scheduledRidesPolicySSOT — validation", () => {
  it("rejects negative and over-maxima values", () => {
    const issues = validateScheduledCommitmentPolicy({
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      early_arrival_buffer_minutes: -1,
      check_in_min_lead_minutes: 99_999,
    });
    expect(issues.some((i) => i.field === "early_arrival_buffer_minutes")).toBe(
      true,
    );
    expect(issues.some((i) => i.field === "check_in_min_lead_minutes")).toBe(
      true,
    );
  });

  it("requires min gap ≥ turnaround and admin escalation ≥ rescue", () => {
    const issues = validateScheduledCommitmentPolicy({
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      scheduled_turnaround_buffer_minutes: 20,
      min_gap_between_scheduled_minutes: 10,
      rescue_search_lead_minutes: 30,
      admin_escalation_lead_minutes: 20,
      check_in_min_lead_minutes: 90,
    });
    expect(
      issues.some((i) => i.field === "min_gap_between_scheduled_minutes"),
    ).toBe(true);
    expect(
      issues.some((i) => i.field === "admin_escalation_lead_minutes"),
    ).toBe(true);
  });

  it("rejects rescue lead after check-in lead (before expected failure)", () => {
    const issues = validateScheduledCommitmentPolicy({
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      check_in_min_lead_minutes: 15,
      rescue_search_lead_minutes: 20,
      admin_escalation_lead_minutes: 25,
      min_gap_between_scheduled_minutes: 15,
      scheduled_turnaround_buffer_minutes: 10,
    });
    expect(issues.some((i) => i.field === "rescue_search_lead_minutes")).toBe(
      true,
    );
  });

  it("accepts a coherent default policy", () => {
    expect(
      validateScheduledCommitmentPolicy(SCHEDULED_COMMITMENT_POLICY_DEFAULTS),
    ).toEqual([]);
  });

  it("validates booking window boundaries", () => {
    expect(
      validateScheduledBookingPolicy({ max_advance_days: 0 }).length,
    ).toBeGreaterThan(0);
    expect(
      validateScheduledBookingPolicy({
        urgent_dispatch_trigger_minutes_before_pickup: -2,
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("scheduledRidesPolicySSOT — SA fallback + location override", () => {
  it("falls back to global then schema defaults", () => {
    const fromGlobal = resolveScheduledCommitmentPolicy({
      global: { check_in_min_lead_minutes: 75 },
    });
    expect(fromGlobal.check_in_min_lead_minutes).toBe(75);
    expect(fromGlobal._source).toBe("global");

    const fromDefaults = resolveScheduledCommitmentPolicy({});
    expect(fromDefaults.check_in_min_lead_minutes).toBe(
      SCHEDULED_COMMITMENT_POLICY_DEFAULTS.check_in_min_lead_minutes,
    );
    expect(fromDefaults._source).toBe("schema_defaults");
  });

  it("applies optional SA jsonb override over global", () => {
    const resolved = resolveScheduledCommitmentPolicy({
      global: {
        check_in_min_lead_minutes: 90,
        early_arrival_buffer_minutes: 10,
      },
      serviceArea: {
        scheduled_commitment_policy: {
          early_arrival_buffer_minutes: 18,
        },
      },
    });
    expect(resolved.early_arrival_buffer_minutes).toBe(18);
    expect(resolved.check_in_min_lead_minutes).toBe(90);
    expect(resolved._source).toBe("service_area");
  });

  it("applies optional location access override without separate workflow", () => {
    const resolved = resolveScheduledCommitmentPolicy({
      global: { pickup_access_allowance_minutes: 0 },
      serviceArea: {
        scheduled_commitment_policy: { pickup_access_allowance_minutes: 5 },
      },
      locationAccessAllowanceMinutes: 20,
    });
    expect(resolved.pickup_access_allowance_minutes).toBe(20);
    expect(resolved._access_allowance_source).toBe("location");
    expect(resolved._source).toBe("location_override");
  });

  it("builds/parses SA override payload; empty clears to inherit", () => {
    expect(
      buildSaCommitmentOverridePayload({
        early_arrival_buffer_minutes: 18,
        check_in_min_lead_minutes: null,
      }),
    ).toEqual({ early_arrival_buffer_minutes: 18 });
    expect(
      buildSaCommitmentOverridePayload({ early_arrival_buffer_minutes: null }),
    ).toBeNull();
    expect(
      parseSaCommitmentOverride({
        scheduled_commitment_policy: { early_arrival_buffer_minutes: 18 },
      }).early_arrival_buffer_minutes,
    ).toBe(18);
    expect(
      validateSaCommitmentOverride(
        { min_gap_between_scheduled_minutes: 5 },
        {
          ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
          scheduled_turnaround_buffer_minutes: 10,
        },
      ).some((i) => i.field === "min_gap_between_scheduled_minutes"),
    ).toBe(true);
  });
});

describe("scheduledRidesPolicySSOT — urgent fallback vs confirmed dynamic", () => {
  it("uses urgent fixed trigger only when no pre-confirmed driver", () => {
    expect(
      shouldUseUrgentFallbackTrigger({ confirmedDriverId: null }),
    ).toBe(true);
    expect(
      shouldUseUrgentFallbackTrigger({ confirmedDriverId: undefined }),
    ).toBe(true);
    expect(
      shouldUseUrgentFallbackTrigger({ confirmedDriverId: "drv-1" }),
    ).toBe(false);
    expect(
      shouldUseUrgentFallbackTrigger({
        confirmedDriverId: null,
        enableScheduledToUrgentConversion: false,
      }),
    ).toBe(false);
  });
});

describe("scheduledRidesPolicySSOT — stacking wording / protection", () => {
  it("uses required stacking label and protection help", () => {
    expect(STACKING_SCHEDULED_COMMITMENT_LABEL).toBe(
      "Allow compatible stacking before scheduled commitments",
    );
    expect(STACKING_SCHEDULED_COMMITMENT_HELP).toMatch(/full-queue feasibility/i);
    expect(STACKING_SCHEDULED_COMMITMENT_HELP).toMatch(/never bypass/i);
  });

  it("documents that stacking flags never bypass commitment protection", () => {
    expect(
      stackingDoesNotBypassCommitmentProtection({
        allowAirportStacking: true,
        allowPickupWaitingStacking: true,
        allowStopWaitingStacking: true,
        allowScheduledStacking: true,
      }),
    ).toBe(true);
  });

  it("lists reminder policy links without duplicating notification SSOT", () => {
    expect(SCHEDULED_REMINDER_POLICY_LINKS.length).toBe(9);
    for (const link of SCHEDULED_REMINDER_POLICY_LINKS) {
      expect(link.href).toBe("/notifications");
    }
  });
});

describe("scheduledRidesPolicySSOT — dynamic timing + stacking feasibility", () => {
  it("computes leave-by from pickup, ETA, workload, waits, and buffers", () => {
    const timing = computeDynamicScheduledTiming(
      {
        ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
        early_arrival_buffer_minutes: 10,
        safety_buffer_minutes: 5,
        pickup_access_allowance_minutes: 15,
        check_in_min_lead_minutes: 90,
      },
      {
        scheduledPickupAt: "2030-06-01T12:00:00.000Z",
        travelEtaMinutes: 20,
        activeWorkloadMinutes: 30,
        pickupWaitingMinutes: 5,
        stopWaitingMinutes: 0,
      },
    );
    expect(timing.totalLeadMinutesBeforePickup).toBe(85);
    expect(timing.leaveByAt).toBe("2030-06-01T10:35:00.000Z");
    expect(timing.startJourneyDueAt).toBe(timing.leaveByAt);
    expect(resolveScheduledDispatchPath({ confirmedDriverId: "d1" })).toBe(
      "confirmed_driver_dynamic_policy",
    );
    expect(resolveScheduledDispatchPath({ confirmedDriverId: null })).toBe(
      "urgent_fallback",
    );
  });

  it("blocks stacking when flag off or queue would delay scheduled pickup", () => {
    const policy = {
      ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
      min_gap_between_scheduled_minutes: 60,
      scheduled_turnaround_buffer_minutes: 10,
      early_arrival_buffer_minutes: 10,
      safety_buffer_minutes: 0,
      pickup_access_allowance_minutes: 0,
    };
    expect(
      findOverlappingScheduledCommitments(
        [
          {
            scheduledPickupAt: "2030-06-01T12:00:00.000Z",
            estimatedJobMinutes: 40,
          },
          {
            scheduledPickupAt: "2030-06-01T12:30:00.000Z",
            estimatedJobMinutes: 20,
          },
        ],
        policy,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      hasOverlappingScheduledCommitments(
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
      ),
    ).toBe(false);

    expect(
      evaluateScheduledStackingFeasibility({
        allowScheduledStacking: false,
        policy,
        queue: [
          { kind: "active", durationMinutes: 10 },
          {
            kind: "scheduled",
            durationMinutes: 30,
            scheduledPickupAt: "2030-06-01T15:00:00.000Z",
          },
        ],
        now: "2030-06-01T12:00:00.000Z",
      }).reason,
    ).toBe("stacked_scheduled_blocked");

    expect(
      evaluateScheduledStackingFeasibility({
        allowScheduledStacking: true,
        policy,
        queue: [
          { kind: "candidate", durationMinutes: 120 },
          {
            kind: "scheduled",
            durationMinutes: 30,
            scheduledPickupAt: "2030-06-01T13:00:00.000Z",
          },
        ],
        now: "2030-06-01T12:00:00.000Z",
      }).reason,
    ).toBe("scheduled_pickup_would_be_delayed");

    expect(
      evaluateScheduledStackingFeasibility({
        allowScheduledStacking: true,
        policy,
        queue: [
          { kind: "candidate", durationMinutes: 20 },
          {
            kind: "scheduled",
            durationMinutes: 30,
            scheduledPickupAt: "2030-06-01T15:00:00.000Z",
          },
        ],
        now: "2030-06-01T12:00:00.000Z",
      }).allowed,
    ).toBe(true);
  });
});
