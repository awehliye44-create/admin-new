import { describe, expect, it } from "vitest";
import {
  SCHEDULED_ACTIVATION_DEFAULTS,
  SCHEDULED_BOOKING_POLICY_DEFAULTS,
  buildScheduledPolicySavePayload,
  shouldUseUrgentFallbackTrigger,
  validateScheduledActivationConfig,
  validateScheduledBookingPolicy,
} from "../../../shared/scheduledRidesPolicySSOT";
import {
  classifyScheduledTripKind,
  computeScheduledActivationAtMs,
} from "../../../shared/scheduledActivationSSOT";

describe("scheduledActivationSSOT — Local/Long boundaries", () => {
  it("classifies <30 LOCAL and >=30 LONG", () => {
    expect(
      classifyScheduledTripKind({
        estimatedDurationMinutes: 29,
        longTripThresholdMinutes: 30,
      }).kind,
    ).toBe("local");
    expect(
      classifyScheduledTripKind({
        estimatedDurationMinutes: 30,
        longTripThresholdMinutes: 30,
      }).kind,
    ).toBe("long");
  });

  it("computes 14:00 LOCAL→13:49 and LONG→13:30", () => {
    const pickup = Date.parse("2026-09-22T14:00:00.000Z");
    const local = computeScheduledActivationAtMs({
      scheduledAtMs: pickup,
      estimatedDurationMinutes: 18,
      config: SCHEDULED_ACTIVATION_DEFAULTS,
    });
    expect(local.activationAtMs).toBe(Date.parse("2026-09-22T13:49:00.000Z"));
    const long = computeScheduledActivationAtMs({
      scheduledAtMs: pickup,
      estimatedDurationMinutes: 70,
      config: SCHEDULED_ACTIVATION_DEFAULTS,
    });
    expect(long.activationAtMs).toBe(Date.parse("2026-09-22T13:30:00.000Z"));
  });
});

describe("scheduledRidesPolicySSOT — booking + activation", () => {
  it("keeps booking window defaults", () => {
    expect(SCHEDULED_BOOKING_POLICY_DEFAULTS.min_advance_time_minutes).toBe(20);
    expect(SCHEDULED_BOOKING_POLICY_DEFAULTS.max_advance_days).toBe(30);
  });

  it("save payload includes activation and disables incentives", () => {
    const payload = buildScheduledPolicySavePayload({
      enabled: true,
      booking: { ...SCHEDULED_BOOKING_POLICY_DEFAULTS },
      activation: { ...SCHEDULED_ACTIVATION_DEFAULTS },
    });
    expect(payload.local_activation_minutes_before_pickup).toBe(11);
    expect(payload.scheduled_ride_incentives_enabled).toBe(false);
  });

  it("urgent fallback skips confirmed drivers", () => {
    expect(
      shouldUseUrgentFallbackTrigger({
        confirmedDriverId: "x",
        enableScheduledToUrgentConversion: true,
      }),
    ).toBe(false);
  });

  it("validates activation and booking", () => {
    expect(
      validateScheduledActivationConfig({
        ...SCHEDULED_ACTIVATION_DEFAULTS,
        localActivationMinutesBeforePickup: 0,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateScheduledBookingPolicy({ max_advance_days: 0 }).some(
        (i) => i.field === "max_advance_days",
      ),
    ).toBe(true);
  });
});
