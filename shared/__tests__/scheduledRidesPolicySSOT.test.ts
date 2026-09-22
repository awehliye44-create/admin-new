/**
 * Scheduled rides policy — Booking Window + Activation (Commitment removed).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SCHEDULED_ACTIVATION_DEFAULTS,
  SCHEDULED_BOOKING_POLICY_DEFAULTS,
  buildScheduledPolicySavePayload,
  shouldUseUrgentFallbackTrigger,
  validateScheduledBookingPolicy,
  validateScheduledActivationConfig,
} from "../scheduledRidesPolicySSOT.ts";

Deno.test("booking defaults: min advance 20, max days 30, fallback 9", () => {
  assertEquals(SCHEDULED_BOOKING_POLICY_DEFAULTS.min_advance_time_minutes, 20);
  assertEquals(SCHEDULED_BOOKING_POLICY_DEFAULTS.max_advance_days, 30);
  assertEquals(
    SCHEDULED_BOOKING_POLICY_DEFAULTS.urgent_dispatch_trigger_minutes_before_pickup,
    9,
  );
});

Deno.test("activation defaults: 30 / 11 / 30 / 9", () => {
  assertEquals(SCHEDULED_ACTIVATION_DEFAULTS.longTripThresholdMinutes, 30);
  assertEquals(SCHEDULED_ACTIVATION_DEFAULTS.localActivationMinutesBeforePickup, 11);
  assertEquals(SCHEDULED_ACTIVATION_DEFAULTS.longActivationMinutesBeforePickup, 30);
  assertEquals(SCHEDULED_ACTIVATION_DEFAULTS.urgentFallbackMinutesBeforePickup, 9);
});

Deno.test("save payload writes activation columns and forces incentives off", () => {
  const payload = buildScheduledPolicySavePayload({
    enabled: true,
    booking: { ...SCHEDULED_BOOKING_POLICY_DEFAULTS },
    activation: {
      longTripThresholdMinutes: 45,
      localActivationMinutesBeforePickup: 15,
      longActivationMinutesBeforePickup: 40,
      urgentFallbackMinutesBeforePickup: 12,
    },
  });
  assertEquals(payload.long_trip_threshold_minutes, 45);
  assertEquals(payload.local_activation_minutes_before_pickup, 15);
  assertEquals(payload.long_activation_minutes_before_pickup, 40);
  assertEquals(payload.urgent_dispatch_trigger_minutes_before_pickup, 12);
  assertEquals(payload.scheduled_ride_incentives_enabled, false);
});

Deno.test("urgent fallback never runs with confirmed driver", () => {
  assertEquals(
    shouldUseUrgentFallbackTrigger({
      confirmedDriverId: "drv-1",
      enableScheduledToUrgentConversion: true,
    }),
    false,
  );
  assertEquals(
    shouldUseUrgentFallbackTrigger({
      confirmedDriverId: null,
      enableScheduledToUrgentConversion: true,
    }),
    true,
  );
});

Deno.test("validation rejects invalid activation", () => {
  const issues = validateScheduledActivationConfig({
    longTripThresholdMinutes: 0,
    localActivationMinutesBeforePickup: 11,
    longActivationMinutesBeforePickup: 30,
    urgentFallbackMinutesBeforePickup: 9,
  });
  assertEquals(issues.some((i) => i.field === "longTripThresholdMinutes"), true);
});

Deno.test("booking validation still gates advance window", () => {
  const issues = validateScheduledBookingPolicy({
    min_advance_time_minutes: -1,
    max_advance_days: 30,
  });
  assertEquals(issues.some((i) => i.field === "min_advance_time_minutes"), true);
});
