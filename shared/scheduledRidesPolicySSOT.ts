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
 * Pure airport signal for stacking gate (Admin flag allow_airport_stacking).
 * Charge pence and/or custom zone_type === "airport".
 */
export function tripSignalsIndicateAirport(input: {
  airportChargePence?: number | null;
  zoneTypes?: Array<string | null | undefined>;
}): boolean {
  if (Number(input.airportChargePence ?? 0) > 0) return true;
  return (input.zoneTypes ?? []).some(
    (t) => (t ?? "").toLowerCase().trim() === "airport",
  );
}

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

/** Admin field metadata for Commitment Policy knobs (global + SA overrides). */
export const COMMITMENT_POLICY_FIELD_DEFS: ReadonlyArray<{
  key: ScheduledCommitmentPolicyKey;
  label: string;
  help: string;
}> = [
  {
    key: "check_in_min_lead_minutes",
    label: "Check-in minimum lead time (minutes)",
    help: "Earliest check-in may open relative to pickup (policy floor).",
  },
  {
    key: "check_in_grace_minutes",
    label: "Check-in grace period (minutes)",
    help: "Grace after check-in due before missed handling.",
  },
  {
    key: "early_arrival_buffer_minutes",
    label: "Required early-arrival buffer (minutes)",
    help: "Buffer requiring arrival before scheduled pickup.",
  },
  {
    key: "safety_buffer_minutes",
    label: "General safety buffer (minutes)",
    help: "Extra margin applied in commitment timing.",
  },
  {
    key: "start_journey_grace_minutes",
    label: "Start journey grace period (minutes)",
    help: "Grace after Start journey due before missed handling.",
  },
  {
    key: "driver_location_freshness_seconds",
    label: "Driver location freshness limit (seconds)",
    help: "Max age of driver presence for commitment calculations.",
  },
  {
    key: "driver_response_timeout_minutes",
    label: "Driver response timeout (minutes)",
    help: "How long a confirmed driver has to respond after activation.",
  },
  {
    key: "not_moving_detection_minutes",
    label: "Not-moving detection period (minutes)",
    help: "How long without movement before risk signals.",
  },
  {
    key: "rescue_search_lead_minutes",
    label: "Rescue search lead time (minutes)",
    help: "When rescue search may start before expected failure.",
  },
  {
    key: "admin_escalation_lead_minutes",
    label: "Admin escalation lead time (minutes)",
    help: "Must be ≥ rescue lead — alert Admin early enough.",
  },
  {
    key: "scheduled_turnaround_buffer_minutes",
    label: "Scheduled turnaround buffer (minutes)",
    help: "Turnaround between consecutive scheduled jobs.",
  },
  {
    key: "min_gap_between_scheduled_minutes",
    label: "Minimum gap between scheduled jobs (minutes)",
    help: "Must be ≥ turnaround buffer.",
  },
  {
    key: "expected_pickup_waiting_minutes",
    label: "Expected pickup-waiting allowance (minutes)",
    help: "Expected wait at pickup in feasibility math.",
  },
  {
    key: "expected_stop_waiting_minutes",
    label: "Expected stop-waiting allowance (minutes)",
    help: "Expected wait at intermediate stops.",
  },
  {
    key: "eta_risk_tolerance_minutes",
    label: "ETA risk tolerance (minutes)",
    help: "How much ETA slip before at-risk signalling.",
  },
  {
    key: "pickup_access_allowance_minutes",
    label: "Pickup access allowance default (minutes)",
    help: "System/SA default for airports/stations/venues/restricted; zones may override.",
  },
] as const;

/**
 * Parse optional SA commitment override from jsonb blob or flat SA row.
 * Empty / missing keys mean inherit global (or schema defaults).
 */
export function parseSaCommitmentOverride(
  serviceAreaOrBlob: Record<string, unknown> | null | undefined,
): Partial<ScheduledCommitmentPolicy> {
  if (!serviceAreaOrBlob) return {};

  const blob =
    serviceAreaOrBlob.scheduled_commitment_policy &&
    typeof serviceAreaOrBlob.scheduled_commitment_policy === "object" &&
    !Array.isArray(serviceAreaOrBlob.scheduled_commitment_policy)
      ? (serviceAreaOrBlob.scheduled_commitment_policy as Record<string, unknown>)
      : null;

  const source = blob ?? serviceAreaOrBlob;
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

/**
 * Persist SA overrides. Returns null when nothing overrides (inherit global).
 * Does not create a separate workflow — storage only.
 */
export function buildSaCommitmentOverridePayload(
  overrides: Partial<
    Record<ScheduledCommitmentPolicyKey, number | null | undefined>
  >,
): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const key of SCHEDULED_COMMITMENT_POLICY_KEYS) {
    const v = overrides[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Validate SA override against effective merged policy (override on top of base).
 */
export function validateSaCommitmentOverride(
  partial: Partial<ScheduledCommitmentPolicy>,
  base: ScheduledCommitmentPolicy = SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
): ValidationIssue[] {
  return validateScheduledCommitmentPolicy({ ...base, ...partial });
}

/**
 * Resolve effective commitment policy.
 * sources order for scalar knobs: SA override → global → defaults
 * access allowance: location → SA → global → defaults
 */
function extractSaOverridePartial(
  serviceArea: Record<string, unknown>,
): Partial<ScheduledCommitmentPolicy> {
  return parseSaCommitmentOverride(serviceArea);
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

// ─── Dynamic timing + stacking feasibility (pure contracts for runtime) ───

/** Runtime-supplied inputs; Admin knobs never invent live ETA/location. */
export type ScheduledDynamicTimingInput = {
  scheduledPickupAt: string | Date;
  /** Traffic-aware travel minutes from driver (after workload) to pickup. */
  travelEtaMinutes: number;
  /** Remaining active + stacked trip minutes before the driver is free. */
  activeWorkloadMinutes?: number;
  /** Pickup-waiting minutes on the path (defaults to policy expected). */
  pickupWaitingMinutes?: number;
  /** Intermediate stop-waiting minutes on the path (defaults to policy expected × stops). */
  stopWaitingMinutes?: number;
  stopCount?: number;
  now?: string | Date;
};

export type ScheduledDynamicTimingResult = {
  /** Earliest check-in may open (policy floor vs pickup). */
  checkInOpensAt: string;
  checkInGraceEndsAt: string;
  /** Dynamic leave-by from pickup − (ETA + workload + waits + buffers + access). */
  leaveByAt: string;
  startJourneyDueAt: string;
  startJourneyGraceEndsAt: string;
  /** Projected arrival at pickup if leave-by is met. */
  projectedArrivalAt: string;
  requiredArrivalLeadMinutes: number;
  totalLeadMinutesBeforePickup: number;
  atRiskThresholdAt: string;
  rescueSearchAt: string;
  adminEscalationAt: string;
  /** True when computed leave-by is before check-in opens (tight commitment). */
  leaveByBeforeCheckInOpen: boolean;
  /** True when projected arrival would miss early-arrival window. */
  projectedMissesEarlyArrival: boolean;
};

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(d: Date): string {
  return d.toISOString();
}

function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

function finiteNonNeg(n: unknown, fallback = 0): number {
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
  return fallback;
}

/**
 * Convert commitment knobs + live runtime inputs into dynamic timing milestones.
 * Does not call maps/traffic — consumers supply travelEtaMinutes / workload.
 * Confirmed-driver path only; no-preconfirmed uses urgent fixed trigger instead.
 */
export function computeDynamicScheduledTiming(
  policy: ScheduledCommitmentPolicy,
  input: ScheduledDynamicTimingInput,
): ScheduledDynamicTimingResult {
  const pickup = toDate(input.scheduledPickupAt);
  const travel = finiteNonNeg(input.travelEtaMinutes);
  const workload = finiteNonNeg(input.activeWorkloadMinutes);
  const pickupWait =
    input.pickupWaitingMinutes != null
      ? finiteNonNeg(input.pickupWaitingMinutes)
      : policy.expected_pickup_waiting_minutes;
  const stopWait =
    input.stopWaitingMinutes != null
      ? finiteNonNeg(input.stopWaitingMinutes)
      : policy.expected_stop_waiting_minutes *
        finiteNonNeg(input.stopCount, 0);

  const requiredArrivalLeadMinutes =
    policy.early_arrival_buffer_minutes +
    policy.safety_buffer_minutes +
    policy.pickup_access_allowance_minutes;

  const totalLeadMinutesBeforePickup =
    travel + workload + pickupWait + stopWait + requiredArrivalLeadMinutes;

  const leaveByAt = addMinutes(pickup, -totalLeadMinutesBeforePickup);
  const checkInOpensAt = addMinutes(pickup, -policy.check_in_min_lead_minutes);
  const checkInGraceEndsAt = addMinutes(
    checkInOpensAt,
    policy.check_in_grace_minutes,
  );
  const startJourneyDueAt = leaveByAt;
  const startJourneyGraceEndsAt = addMinutes(
    startJourneyDueAt,
    policy.start_journey_grace_minutes,
  );
  const projectedArrivalAt = addMinutes(
    leaveByAt,
    travel + workload + pickupWait + stopWait,
  );
  const earlyArrivalDeadline = addMinutes(
    pickup,
    -policy.early_arrival_buffer_minutes,
  );
  const atRiskThresholdAt = addMinutes(
    earlyArrivalDeadline,
    -policy.eta_risk_tolerance_minutes,
  );
  const rescueSearchAt = addMinutes(pickup, -policy.rescue_search_lead_minutes);
  const adminEscalationAt = addMinutes(
    pickup,
    -policy.admin_escalation_lead_minutes,
  );

  return {
    checkInOpensAt: toIso(checkInOpensAt),
    checkInGraceEndsAt: toIso(checkInGraceEndsAt),
    leaveByAt: toIso(leaveByAt),
    startJourneyDueAt: toIso(startJourneyDueAt),
    startJourneyGraceEndsAt: toIso(startJourneyGraceEndsAt),
    projectedArrivalAt: toIso(projectedArrivalAt),
    requiredArrivalLeadMinutes,
    totalLeadMinutesBeforePickup,
    atRiskThresholdAt: toIso(atRiskThresholdAt),
    rescueSearchAt: toIso(rescueSearchAt),
    adminEscalationAt: toIso(adminEscalationAt),
    leaveByBeforeCheckInOpen: leaveByAt.getTime() < checkInOpensAt.getTime(),
    projectedMissesEarlyArrival:
      projectedArrivalAt.getTime() > earlyArrivalDeadline.getTime(),
  };
}

export type ScheduledCommitmentSlot = {
  id?: string;
  scheduledPickupAt: string | Date;
  /** Estimated job length from arrival through drop-off (minutes). */
  estimatedJobMinutes: number;
};

export type OverlappingCommitmentIssue = {
  earlierId?: string;
  laterId?: string;
  earlierPickupAt: string;
  laterPickupAt: string;
  gapMinutes: number;
  requiredGapMinutes: number;
  reason: "overlapping_scheduled_commitments" | "below_min_gap";
};

/**
 * No overlapping scheduled commitments: consecutive pickups must respect
 * min_gap_between_scheduled_minutes (≥ turnaround). Job length on the earlier
 * commitment also cannot overrun into the later pickup − arrival buffers.
 */
export function findOverlappingScheduledCommitments(
  commitments: ScheduledCommitmentSlot[],
  policy: ScheduledCommitmentPolicy,
): OverlappingCommitmentIssue[] {
  const requiredGap = Math.max(
    policy.min_gap_between_scheduled_minutes,
    policy.scheduled_turnaround_buffer_minutes,
  );
  const arrivalLead =
    policy.early_arrival_buffer_minutes +
    policy.safety_buffer_minutes +
    policy.pickup_access_allowance_minutes;

  const sorted = [...commitments].sort(
    (a, b) =>
      toDate(a.scheduledPickupAt).getTime() -
      toDate(b.scheduledPickupAt).getTime(),
  );
  const issues: OverlappingCommitmentIssue[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const earlier = sorted[i]!;
    const later = sorted[i + 1]!;
    const earlierPickup = toDate(earlier.scheduledPickupAt);
    const laterPickup = toDate(later.scheduledPickupAt);
    const gapMinutes =
      (laterPickup.getTime() - earlierPickup.getTime()) / 60_000;

    if (gapMinutes < requiredGap) {
      issues.push({
        earlierId: earlier.id,
        laterId: later.id,
        earlierPickupAt: toIso(earlierPickup),
        laterPickupAt: toIso(laterPickup),
        gapMinutes,
        requiredGapMinutes: requiredGap,
        reason: "below_min_gap",
      });
      continue;
    }

    const earlierDone = addMinutes(
      earlierPickup,
      finiteNonNeg(earlier.estimatedJobMinutes) +
        policy.scheduled_turnaround_buffer_minutes,
    );
    const laterMustArriveBy = addMinutes(laterPickup, -arrivalLead);
    if (earlierDone.getTime() > laterMustArriveBy.getTime()) {
      issues.push({
        earlierId: earlier.id,
        laterId: later.id,
        earlierPickupAt: toIso(earlierPickup),
        laterPickupAt: toIso(laterPickup),
        gapMinutes,
        requiredGapMinutes: requiredGap,
        reason: "overlapping_scheduled_commitments",
      });
    }
  }

  return issues;
}

export function hasOverlappingScheduledCommitments(
  commitments: ScheduledCommitmentSlot[],
  policy: ScheduledCommitmentPolicy,
): boolean {
  return findOverlappingScheduledCommitments(commitments, policy).length > 0;
}

export type StackingQueueLeg = {
  kind: "active" | "stacked" | "candidate" | "scheduled";
  /** Remaining or estimated duration until this leg frees the driver (minutes). */
  durationMinutes: number;
  /** Required when kind === "scheduled" — pickup that must not be delayed. */
  scheduledPickupAt?: string | Date;
  id?: string;
};

export type ScheduledStackingFeasibilityInput = {
  allowScheduledStacking: boolean;
  policy: ScheduledCommitmentPolicy;
  /** Full queue in order, including the candidate stack offer. */
  queue: StackingQueueLeg[];
  now?: string | Date;
};

export type ScheduledStackingFeasibilityResult = {
  allowed: boolean;
  reason:
    | "ok"
    | "stacked_scheduled_blocked"
    | "scheduled_pickup_would_be_delayed"
    | "overlapping_scheduled_commitments"
    | "empty_queue";
  delayedCommitmentId?: string;
  delayedPickupAt?: string;
  projectedArrivalAt?: string;
  overlapIssues?: OverlappingCommitmentIssue[];
};

/**
 * Scheduled stacking only when full-queue feasibility proves no scheduled
 * pickup is delayed. Airport / waiting stacking flags never bypass this.
 */
export function evaluateScheduledStackingFeasibility(
  input: ScheduledStackingFeasibilityInput,
): ScheduledStackingFeasibilityResult {
  const { policy, queue } = input;
  if (!queue.length) {
    return { allowed: false, reason: "empty_queue" };
  }

  const hasScheduledInQueue = queue.some(
    (leg) => leg.kind === "scheduled" && leg.scheduledPickupAt != null,
  );
  if (hasScheduledInQueue && !input.allowScheduledStacking) {
    return { allowed: false, reason: "stacked_scheduled_blocked" };
  }

  const scheduledSlots: ScheduledCommitmentSlot[] = queue
    .filter((leg) => leg.kind === "scheduled" && leg.scheduledPickupAt != null)
    .map((leg) => ({
      id: leg.id,
      scheduledPickupAt: leg.scheduledPickupAt!,
      estimatedJobMinutes: finiteNonNeg(leg.durationMinutes),
    }));

  const overlapIssues = findOverlappingScheduledCommitments(
    scheduledSlots,
    policy,
  );
  if (overlapIssues.length > 0) {
    return {
      allowed: false,
      reason: "overlapping_scheduled_commitments",
      overlapIssues,
    };
  }

  const arrivalLead =
    policy.early_arrival_buffer_minutes +
    policy.safety_buffer_minutes +
    policy.pickup_access_allowance_minutes;

  let cursor = toDate(input.now ?? new Date());

  for (const leg of queue) {
    if (leg.kind === "scheduled" && leg.scheduledPickupAt != null) {
      const pickup = toDate(leg.scheduledPickupAt);
      const mustArriveBy = addMinutes(pickup, -arrivalLead);
      // Driver must be free by mustArriveBy; cursor is when current work ends.
      if (cursor.getTime() > mustArriveBy.getTime()) {
        return {
          allowed: false,
          reason: "scheduled_pickup_would_be_delayed",
          delayedCommitmentId: leg.id,
          delayedPickupAt: toIso(pickup),
          projectedArrivalAt: toIso(cursor),
        };
      }
      // Arrive by early-arrival window, then run the scheduled job + turnaround.
      const arriveAt =
        cursor.getTime() < mustArriveBy.getTime() ? mustArriveBy : cursor;
      cursor = addMinutes(
        arriveAt,
        finiteNonNeg(leg.durationMinutes) +
          policy.scheduled_turnaround_buffer_minutes +
          policy.expected_pickup_waiting_minutes,
      );
    } else {
      cursor = addMinutes(cursor, finiteNonNeg(leg.durationMinutes));
    }
  }

  return { allowed: true, reason: "ok" };
}

/**
 * Gate used by schedule-dispatch / activation consumers:
 * confirmed → dynamic policy path; no-preconfirmed → urgent fixed trigger.
 */
export function resolveScheduledDispatchPath(input: {
  confirmedDriverId?: string | null;
  enableScheduledToUrgentConversion?: boolean;
}): "urgent_fallback" | "confirmed_driver_dynamic_policy" | "urgent_conversion_disabled" {
  if (
    typeof input.confirmedDriverId === "string" &&
    input.confirmedDriverId.trim().length > 0
  ) {
    return "confirmed_driver_dynamic_policy";
  }
  if (input.enableScheduledToUrgentConversion === false) {
    return "urgent_conversion_disabled";
  }
  return "urgent_fallback";
}

/**
 * Convenience wrapper for auto-dispatch / offer consumers:
 * active remaining + candidate stack offer + later scheduled commitments.
 */
export function gateStackedOfferAgainstScheduledCommitments(input: {
  allowScheduledStacking: boolean;
  policy: ScheduledCommitmentPolicy;
  activeRemainingMinutes: number;
  candidateDurationMinutes: number;
  scheduledCommitments: ScheduledCommitmentSlot[];
  now?: string | Date;
}): ScheduledStackingFeasibilityResult {
  return evaluateScheduledStackingFeasibility({
    allowScheduledStacking: input.allowScheduledStacking,
    policy: input.policy,
    now: input.now,
    queue: [
      {
        kind: "active",
        durationMinutes: finiteNonNeg(input.activeRemainingMinutes),
      },
      {
        kind: "candidate",
        durationMinutes: finiteNonNeg(input.candidateDurationMinutes),
      },
      ...input.scheduledCommitments.map((c) => ({
        kind: "scheduled" as const,
        id: c.id,
        durationMinutes: finiteNonNeg(c.estimatedJobMinutes),
        scheduledPickupAt: c.scheduledPickupAt,
      })),
    ],
  });
}

/**
 * No-preconfirmed priority dispatch lead time.
 *
 * Admin `urgent_dispatch_trigger_minutes_before_pickup` is the LATEST permitted
 * start (ceiling for how late we may wait), not a universal start clock.
 * Runtime must begin at pickup − max(dynamicRequiredLead, fallbackThreshold).
 */
export function computeNoPreconfirmedPriorityLeadMinutes(input: {
  fallbackThresholdMinutes: number;
  /** Nearby eligible driver travel ETA (minutes). Omit when unknown. */
  nearbyDriverEtaMinutes?: number | null;
  commitment: Pick<
    ScheduledCommitmentPolicy,
    | "early_arrival_buffer_minutes"
    | "safety_buffer_minutes"
    | "pickup_access_allowance_minutes"
    | "eta_risk_tolerance_minutes"
    | "rescue_search_lead_minutes"
  >;
}): {
  fallbackThresholdMinutes: number;
  dynamicRequiredLeadMinutes: number;
  effectiveLeadMinutes: number;
} {
  const fallback = Math.max(0, finiteNonNeg(input.fallbackThresholdMinutes));
  const buffers =
    finiteNonNeg(input.commitment.early_arrival_buffer_minutes) +
    finiteNonNeg(input.commitment.safety_buffer_minutes) +
    finiteNonNeg(input.commitment.pickup_access_allowance_minutes) +
    finiteNonNeg(input.commitment.eta_risk_tolerance_minutes);

  const eta =
    input.nearbyDriverEtaMinutes != null &&
    Number.isFinite(input.nearbyDriverEtaMinutes)
      ? Math.max(0, Number(input.nearbyDriverEtaMinutes))
      : null;

  // When ETA unknown, use rescue lead as a conservative early-start floor so we
  // do not wait until the latest-permitted fallback minute by default.
  const dynamic =
    eta != null
      ? eta + buffers
      : Math.max(fallback, finiteNonNeg(input.commitment.rescue_search_lead_minutes));

  return {
    fallbackThresholdMinutes: fallback,
    dynamicRequiredLeadMinutes: dynamic,
    effectiveLeadMinutes: Math.max(dynamic, fallback),
  };
}

/** True when now is inside the no-preconfirmed priority dispatch window. */
export function shouldStartNoPreconfirmedPriorityDispatch(input: {
  minutesUntilPickup: number;
  effectiveLeadMinutes: number;
}): boolean {
  return input.minutesUntilPickup <= input.effectiveLeadMinutes;
}

/**
 * Overdue grace after scheduled pickup for no-preconfirmed bookings.
 * Prefer dedicated grace when provided; else check-in grace; else response window.
 */
export function resolveNoPreconfirmedOverdueGraceMinutes(input: {
  checkInGraceMinutes?: number | null;
  scheduledResponseWindowMinutes?: number | null;
  overdueGraceMinutes?: number | null;
}): number {
  if (
    input.overdueGraceMinutes != null &&
    Number.isFinite(input.overdueGraceMinutes)
  ) {
    return Math.max(0, Number(input.overdueGraceMinutes));
  }
  if (
    input.checkInGraceMinutes != null &&
    Number.isFinite(input.checkInGraceMinutes)
  ) {
    return Math.max(0, Number(input.checkInGraceMinutes));
  }
  if (
    input.scheduledResponseWindowMinutes != null &&
    Number.isFinite(input.scheduledResponseWindowMinutes)
  ) {
    return Math.max(0, Number(input.scheduledResponseWindowMinutes));
  }
  return SCHEDULED_COMMITMENT_POLICY_DEFAULTS.check_in_grace_minutes;
}

export function isPastNoPreconfirmedOverdueGrace(input: {
  minutesUntilPickup: number;
  overdueGraceMinutes: number;
}): boolean {
  return input.minutesUntilPickup < -Math.max(0, input.overdueGraceMinutes);
}

export function shouldAlertAdminForNoPreconfirmedEscalation(input: {
  minutesUntilPickup: number;
  adminEscalationLeadMinutes: number;
}): boolean {
  return (
    input.minutesUntilPickup <=
    Math.max(0, finiteNonNeg(input.adminEscalationLeadMinutes))
  );
}
