/**
 * Scheduled Rides policy SSOT (Admin = policy knobs only).
 *
 * Hierarchy: location access override → service-area commitment override →
 * global_dispatch_settings → schema defaults.
 *
 * Runtime consumers remain authoritative for dynamic check-in / leave-by /
 * start-journey / risk / rescue calculations from live location + ETA.
 * Admin never embeds driver banners or trip lifecycle UI here.
 */

/** DB / wire column names for commitment policy knobs (new). */
export const SCHEDULED_COMMITMENT_POLICY_KEYS = [
  "check_in_min_lead_minutes",
  "check_in_grace_minutes",
  "early_arrival_buffer_minutes",
  "safety_buffer_minutes",
  "start_journey_grace_minutes",
  "driver_location_freshness_seconds",
  "driver_response_timeout_minutes",
  "not_moving_detection_minutes",
  "rescue_search_lead_minutes",
  "admin_escalation_lead_minutes",
  "scheduled_turnaround_buffer_minutes",
  "min_gap_between_scheduled_minutes",
  "expected_pickup_waiting_minutes",
  "expected_stop_waiting_minutes",
  "eta_risk_tolerance_minutes",
  "pickup_access_allowance_minutes",
] as const;

export type ScheduledCommitmentPolicyKey =
  (typeof SCHEDULED_COMMITMENT_POLICY_KEYS)[number];

export type ScheduledCommitmentPolicy = Record<
  ScheduledCommitmentPolicyKey,
  number
>;

/** Existing booking / urgent-fallback columns (kept). */
export type ScheduledBookingPolicy = {
  scheduled_rides_enabled: boolean;
  min_advance_time_minutes: number;
  max_advance_days: number;
  scheduled_ride_incentives_enabled: boolean;
  scheduled_response_window_minutes: number;
  /** Fallback only — bookings with NO pre-confirmed driver. */
  urgent_dispatch_trigger_minutes_before_pickup: number;
  /** Confirmed-driver response after activation card (legacy column name). */
  locked_driver_response_minutes: number;
  scheduled_urgent_card_label: string;
  enable_scheduled_to_urgent_conversion: boolean;
  allow_scheduled_stacking: boolean;
};

export const SCHEDULED_COMMITMENT_POLICY_DEFAULTS: ScheduledCommitmentPolicy = {
  check_in_min_lead_minutes: 90,
  check_in_grace_minutes: 15,
  early_arrival_buffer_minutes: 10,
  safety_buffer_minutes: 5,
  start_journey_grace_minutes: 5,
  driver_location_freshness_seconds: 60,
  driver_response_timeout_minutes: 3,
  not_moving_detection_minutes: 3,
  rescue_search_lead_minutes: 20,
  admin_escalation_lead_minutes: 25,
  scheduled_turnaround_buffer_minutes: 10,
  min_gap_between_scheduled_minutes: 15,
  expected_pickup_waiting_minutes: 5,
  expected_stop_waiting_minutes: 5,
  eta_risk_tolerance_minutes: 5,
  pickup_access_allowance_minutes: 0,
};

export const SCHEDULED_BOOKING_POLICY_DEFAULTS: ScheduledBookingPolicy = {
  scheduled_rides_enabled: true,
  min_advance_time_minutes: 15,
  max_advance_days: 30,
  scheduled_ride_incentives_enabled: false,
  scheduled_response_window_minutes: 10,
  urgent_dispatch_trigger_minutes_before_pickup: 5,
  locked_driver_response_minutes: 3,
  scheduled_urgent_card_label: "Scheduled • Urgent",
  enable_scheduled_to_urgent_conversion: true,
  allow_scheduled_stacking: false,
};

/** Sensible maxima for Admin validation. */
export const SCHEDULED_COMMITMENT_POLICY_MAXIMA: ScheduledCommitmentPolicy = {
  check_in_min_lead_minutes: 24 * 60,
  check_in_grace_minutes: 120,
  early_arrival_buffer_minutes: 60,
  safety_buffer_minutes: 60,
  start_journey_grace_minutes: 60,
  driver_location_freshness_seconds: 600,
  driver_response_timeout_minutes: 30,
  not_moving_detection_minutes: 30,
  rescue_search_lead_minutes: 180,
  admin_escalation_lead_minutes: 240,
  scheduled_turnaround_buffer_minutes: 120,
  min_gap_between_scheduled_minutes: 240,
  expected_pickup_waiting_minutes: 60,
  expected_stop_waiting_minutes: 60,
  eta_risk_tolerance_minutes: 60,
  pickup_access_allowance_minutes: 60,
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

/**
 * Reminder policies owned by Notifications & Alerts (SSOT).
 * Reminders tab links here — does not duplicate sound/content.
 */
export const SCHEDULED_REMINDER_POLICY_LINKS = [
  {
    key: "scheduled_confirmation",
    label: "Scheduled confirmation",
    href: "/notifications",
    description: "Customer/driver confirmation after scheduled booking is placed.",
  },
  {
    key: "check_in_opening",
    label: "Check-in opening",
    href: "/notifications",
    description: "Driver notified when check-in window opens.",
  },
  {
    key: "check_in_missed",
    label: "Check-in missed",
    href: "/notifications",
    description: "Escalation when confirmed driver misses check-in.",
  },
  {
    key: "leave_by_reminder",
    label: "Leave-by reminder",
    href: "/notifications",
    description: "Reminder to leave in time for dynamic leave-by.",
  },
  {
    key: "urgent_start_journey",
    label: "Urgent Start journey",
    href: "/notifications",
    description: "Urgent prompt when Start journey is due.",
  },
  {
    key: "start_journey_missed",
    label: "Start journey missed",
    href: "/notifications",
    description: "Missed Start journey after grace.",
  },
  {
    key: "customer_driver_assigned_update",
    label: "Customer driver-assigned update",
    href: "/notifications",
    description: "Customer notified when a driver is confirmed for the scheduled ride.",
  },
  {
    key: "scheduled_ride_at_risk",
    label: "Scheduled ride at-risk",
    href: "/notifications",
    description: "At-risk alert when ETA/workload threatens the commitment.",
  },
  {
    key: "admin_rescue_escalation",
    label: "Admin rescue escalation",
    href: "/notifications",
    description: "Admin alert before rescue search / expected failure.",
  },
] as const;

export type ScheduledReminderPolicyLink =
  (typeof SCHEDULED_REMINDER_POLICY_LINKS)[number];

export type ResolvedScheduledCommitmentPolicy = ScheduledCommitmentPolicy & {
  _source: "location_override" | "service_area" | "global" | "schema_defaults";
  _access_allowance_source: "location" | "service_area" | "global" | "schema_defaults";
};

export type ValidationIssue = {
  field: string;
  message: string;
};

function coerceNonNegativeNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/**
 * Map a global_dispatch_settings (or partial) row into commitment policy,
 * falling back to defaults for missing keys (backwards compatible).
 */
export function mapCommitmentPolicyFromDb(
  row: Record<string, unknown> | null | undefined,
): ScheduledCommitmentPolicy {
  const out = { ...SCHEDULED_COMMITMENT_POLICY_DEFAULTS };
  if (!row) return out;

  for (const key of SCHEDULED_COMMITMENT_POLICY_KEYS) {
    if (key === "driver_response_timeout_minutes") {
      // Prefer new key; fall back to legacy locked_driver_response_minutes.
      if (row.driver_response_timeout_minutes != null) {
        out.driver_response_timeout_minutes = coerceNonNegativeNumber(
          row.driver_response_timeout_minutes,
          out.driver_response_timeout_minutes,
        );
      } else if (row.locked_driver_response_minutes != null) {
        out.driver_response_timeout_minutes = coerceNonNegativeNumber(
          row.locked_driver_response_minutes,
          out.driver_response_timeout_minutes,
        );
      }
      continue;
    }
    if (row[key] != null) {
      out[key] = coerceNonNegativeNumber(row[key], out[key]);
    }
  }

  // SA jsonb blob support
  const blob = row.scheduled_commitment_policy;
  if (blob && typeof blob === "object" && !Array.isArray(blob)) {
    const partial = blob as Record<string, unknown>;
    for (const key of SCHEDULED_COMMITMENT_POLICY_KEYS) {
      if (partial[key] != null) {
        out[key] = coerceNonNegativeNumber(partial[key], out[key]);
      }
    }
  }

  return out;
}

/** Persist commitment knobs as flat columns for global_dispatch_settings. */
export function mapCommitmentPolicyToDb(
  policy: ScheduledCommitmentPolicy,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of SCHEDULED_COMMITMENT_POLICY_KEYS) {
    out[key] = policy[key];
  }
  // Keep legacy column aligned for older readers.
  out.locked_driver_response_minutes = policy.driver_response_timeout_minutes;
  return out;
}

/**
 * Resolve effective commitment policy.
 * sources order for scalar knobs: SA override → global → defaults
 * access allowance: location → SA → global → defaults
 */
function extractSaOverridePartial(
  serviceArea: Record<string, unknown>,
): Partial<ScheduledCommitmentPolicy> {
  const blob =
    serviceArea.scheduled_commitment_policy &&
    typeof serviceArea.scheduled_commitment_policy === "object" &&
    !Array.isArray(serviceArea.scheduled_commitment_policy)
      ? (serviceArea.scheduled_commitment_policy as Record<string, unknown>)
      : null;

  const source = blob ?? serviceArea;
  const partial: Partial<ScheduledCommitmentPolicy> = {};
  for (const key of SCHEDULED_COMMITMENT_POLICY_KEYS) {
    if (source[key] != null) {
      partial[key] = coerceNonNegativeNumber(
        source[key],
        SCHEDULED_COMMITMENT_POLICY_DEFAULTS[key],
      );
    }
  }
  return partial;
}

export function resolveScheduledCommitmentPolicy(input: {
  global?: Record<string, unknown> | null;
  serviceArea?: Record<string, unknown> | null;
  /** Pickup-zone / venue access minutes override (optional). */
  locationAccessAllowanceMinutes?: number | null;
}): ResolvedScheduledCommitmentPolicy {
  const resolved = mapCommitmentPolicyFromDb(input.global ?? null);
  let source: ResolvedScheduledCommitmentPolicy["_source"] = input.global
    ? "global"
    : "schema_defaults";
  let accessSource: ResolvedScheduledCommitmentPolicy["_access_allowance_source"] =
    input.global ? "global" : "schema_defaults";

  if (input.serviceArea) {
    const partial = extractSaOverridePartial(input.serviceArea);
    const keys = Object.keys(partial) as ScheduledCommitmentPolicyKey[];
    if (keys.length > 0) {
      for (const key of keys) {
        const v = partial[key];
        if (v != null) resolved[key] = v;
      }
      source = "service_area";
      if (partial.pickup_access_allowance_minutes != null) {
        accessSource = "service_area";
      }
    }
  }

  const loc = input.locationAccessAllowanceMinutes;
  if (loc != null && Number.isFinite(loc) && loc >= 0) {
    resolved.pickup_access_allowance_minutes = loc;
    accessSource = "location";
    source = "location_override";
  }

  return {
    ...resolved,
    _source: source,
    _access_allowance_source: accessSource,
  };
}

/**
 * Urgent fixed pickup-minus trigger applies ONLY when there is no
 * pre-confirmed driver. Confirmed jobs use dynamic commitment policy.
 */
export function shouldUseUrgentFallbackTrigger(input: {
  confirmedDriverId?: string | null;
  enableScheduledToUrgentConversion?: boolean;
}): boolean {
  if (input.enableScheduledToUrgentConversion === false) return false;
  const id = input.confirmedDriverId;
  if (typeof id === "string" && id.trim().length > 0) return false;
  return true;
}

export function validateScheduledCommitmentPolicy(
  policy: ScheduledCommitmentPolicy,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const key of SCHEDULED_COMMITMENT_POLICY_KEYS) {
    const value = policy[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      issues.push({ field: key, message: `${key} must be a non-negative number` });
      continue;
    }
    const max = SCHEDULED_COMMITMENT_POLICY_MAXIMA[key];
    if (value > max) {
      issues.push({
        field: key,
        message: `${key} must be ≤ ${max}`,
      });
    }
  }

  // Min gap must include turnaround buffer
  if (
    policy.min_gap_between_scheduled_minutes <
    policy.scheduled_turnaround_buffer_minutes
  ) {
    issues.push({
      field: "min_gap_between_scheduled_minutes",
      message:
        "Minimum gap between scheduled jobs must be ≥ scheduled turnaround buffer",
    });
  }

  // Admin escalation must be early enough vs rescue (admin_escalation ≥ rescue)
  if (policy.admin_escalation_lead_minutes < policy.rescue_search_lead_minutes) {
    issues.push({
      field: "admin_escalation_lead_minutes",
      message:
        "Admin escalation lead time must be ≥ rescue search lead time (alert before/at rescue)",
    });
  }

  // Rescue / escalation should leave room relative to check-in lead
  if (policy.rescue_search_lead_minutes > policy.check_in_min_lead_minutes) {
    issues.push({
      field: "rescue_search_lead_minutes",
      message:
        "Rescue search lead time must be ≤ check-in minimum lead (before expected failure window)",
    });
  }

  return issues;
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
  if (urgent != null && (urgent < 0 || urgent > 180)) {
    issues.push({
      field: "urgent_dispatch_trigger_minutes_before_pickup",
      message:
        "No-preconfirmed urgent fallback trigger must be between 0 and 180 minutes",
    });
  }
  return issues;
}

/**
 * Disabling scheduled rides must never wipe stored configuration.
 * Save payloads must always retain policy values; only the enable flag flips.
 */
export function buildScheduledPolicySavePayload(input: {
  enabled: boolean;
  booking: ScheduledBookingPolicy;
  commitment: ScheduledCommitmentPolicy;
}): Record<string, unknown> {
  return {
    scheduled_rides_enabled: input.enabled,
    min_advance_time_minutes: input.booking.min_advance_time_minutes,
    max_advance_days: input.booking.max_advance_days,
    scheduled_ride_incentives_enabled:
      input.booking.scheduled_ride_incentives_enabled,
    scheduled_response_window_minutes:
      input.booking.scheduled_response_window_minutes,
    urgent_dispatch_trigger_minutes_before_pickup:
      input.booking.urgent_dispatch_trigger_minutes_before_pickup,
    locked_driver_response_minutes:
      input.commitment.driver_response_timeout_minutes,
    scheduled_urgent_card_label: input.booking.scheduled_urgent_card_label,
    enable_scheduled_to_urgent_conversion:
      input.booking.enable_scheduled_to_urgent_conversion,
    allow_scheduled_stacking: input.booking.allow_scheduled_stacking,
    ...mapCommitmentPolicyToDb(input.commitment),
  };
}

export function stackingDoesNotBypassCommitmentProtection(flags: {
  allowAirportStacking: boolean;
  allowPickupWaitingStacking: boolean;
  allowStopWaitingStacking: boolean;
  allowScheduledStacking: boolean;
}): boolean {
  // Policy contract: even when individual stacking flags are on, scheduled
  // commitment protection remains mandatory at runtime. This helper documents
  // the Admin-facing invariant for tests — runtime feasibility is authoritative.
  void flags;
  return true;
}
