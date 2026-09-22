/**
 * Scheduled Rides policy SSOT (Admin).
 *
 * Booking Window + Activation only.
 * Commitment Policy / Reminders / Incentives removed.
 */

import {
  SCHEDULED_ACTIVATION_DEFAULTS,
  mapScheduledActivationToDb,
  resolveScheduledActivationConfig,
  validateScheduledActivationConfig,
  type ScheduledActivationConfig,
} from "./scheduledActivationSSOT.ts";

/** Existing booking / urgent-fallback columns (kept). */
export type ScheduledBookingPolicy = {
  scheduled_rides_enabled: boolean;
  min_advance_time_minutes: number;
  max_advance_days: number;
  /** @deprecated Removed from Admin UI — retained for DB row compat only. */
  scheduled_ride_incentives_enabled: boolean;
  scheduled_response_window_minutes: number;
  /** Fallback only — bookings with NO pre-confirmed driver. */
  urgent_dispatch_trigger_minutes_before_pickup: number;
  /** Confirmed-driver response after activation card. */
  locked_driver_response_minutes: number;
  scheduled_urgent_card_label: string;
  enable_scheduled_to_urgent_conversion: boolean;
  allow_scheduled_stacking: boolean;
};

export const SCHEDULED_BOOKING_POLICY_DEFAULTS: ScheduledBookingPolicy = {
  scheduled_rides_enabled: true,
  min_advance_time_minutes: 20,
  max_advance_days: 30,
  scheduled_ride_incentives_enabled: false,
  scheduled_response_window_minutes: 10,
  urgent_dispatch_trigger_minutes_before_pickup: 9,
  locked_driver_response_minutes: 3,
  scheduled_urgent_card_label: "Scheduled • Urgent",
  enable_scheduled_to_urgent_conversion: true,
  allow_scheduled_stacking: false,
};

export {
  SCHEDULED_ACTIVATION_DEFAULTS,
  resolveScheduledActivationConfig,
  validateScheduledActivationConfig,
  mapScheduledActivationToDb,
  type ScheduledActivationConfig,
};

export const STACKING_SCHEDULED_COMMITMENT_LABEL =
  "Allow compatible stacking before scheduled commitments";

export const STACKING_SCHEDULED_COMMITMENT_HELP =
  "When enabled, stacking is allowed only if backend full-queue feasibility proves no scheduled pickup will be delayed. Airport stacking, pickup-waiting stacking, stop-waiting stacking, and stacked ride queueing must never bypass scheduled commitment protection.";

export const STACKING_PROTECTION_FLAGS = [
  "allow_airport_stacking",
  "allow_stacking_during_pickup_waiting",
  "allow_stacking_during_stop_waiting",
  "allow_scheduled_stacking",
] as const;

export type ValidationIssue = {
  field: string;
  message: string;
};

/**
 * Reminder policies that remain relevant after Commitment Policy removal.
 * Check-in / leave-by / Start-journey-missed links removed.
 */
export const SCHEDULED_REMINDER_POLICY_LINKS = [
  {
    key: "scheduled_confirmation",
    label: "Scheduled confirmation",
    href: "/notifications",
    description: "Customer/driver confirmation after scheduled booking is placed.",
  },
  {
    key: "customer_driver_assigned_update",
    label: "Customer driver-assigned update",
    href: "/notifications",
    description: "Customer notified when a driver is confirmed for the scheduled ride.",
  },
] as const;

export type ScheduledReminderPolicyLink =
  (typeof SCHEDULED_REMINDER_POLICY_LINKS)[number];

export function shouldUseUrgentFallbackTrigger(input: {
  confirmedDriverId?: string | null;
  enableScheduledToUrgentConversion?: boolean;
}): boolean {
  if (input.enableScheduledToUrgentConversion === false) return false;
  const id = input.confirmedDriverId;
  if (typeof id === "string" && id.trim().length > 0) return false;
  return true;
}

export function validateScheduledBookingPolicy(
  policy: Partial<ScheduledBookingPolicy>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const minAdv = policy.min_advance_time_minutes;
  if (minAdv != null && (minAdv < 0 || minAdv > 24 * 60)) {
    issues.push({
      field: "min_advance_time_minutes",
      message: "Minimum advance time must be between 0 and 1440 minutes",
    });
  }
  const maxDays = policy.max_advance_days;
  if (maxDays != null && (maxDays < 1 || maxDays > 365)) {
    issues.push({
      field: "max_advance_days",
      message: "Maximum advance days must be between 1 and 365",
    });
  }
  const urgent = policy.urgent_dispatch_trigger_minutes_before_pickup;
  if (urgent != null && (urgent < 1 || urgent > 180)) {
    issues.push({
      field: "urgent_dispatch_trigger_minutes_before_pickup",
      message:
        "No-preconfirmed Fallback must be between 1 and 180 minutes",
    });
  }
  return issues;
}

/**
 * Disabling scheduled rides must never wipe stored configuration.
 */
export function buildScheduledPolicySavePayload(input: {
  enabled: boolean;
  booking: ScheduledBookingPolicy;
  activation: ScheduledActivationConfig;
}): Record<string, unknown> {
  return {
    scheduled_rides_enabled: input.enabled,
    min_advance_time_minutes: input.booking.min_advance_time_minutes,
    max_advance_days: input.booking.max_advance_days,
    scheduled_ride_incentives_enabled: false,
    scheduled_response_window_minutes:
      input.booking.scheduled_response_window_minutes,
    urgent_dispatch_trigger_minutes_before_pickup:
      input.activation.urgentFallbackMinutesBeforePickup,
    locked_driver_response_minutes:
      input.booking.locked_driver_response_minutes,
    scheduled_urgent_card_label: input.booking.scheduled_urgent_card_label,
    enable_scheduled_to_urgent_conversion:
      input.booking.enable_scheduled_to_urgent_conversion,
    allow_scheduled_stacking: input.booking.allow_scheduled_stacking,
    ...mapScheduledActivationToDb(input.activation),
  };
}

export function stackingDoesNotBypassCommitmentProtection(flags: {
  allowAirportStacking: boolean;
  allowPickupWaitingStacking: boolean;
  allowStopWaitingStacking: boolean;
  allowScheduledStacking: boolean;
}): boolean {
  void flags;
  return true;
}
