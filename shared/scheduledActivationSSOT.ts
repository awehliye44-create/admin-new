/**
 * Scheduled activation SSOT — Local vs Long + fixed T-minute activation.
 *
 * Classification uses estimated_duration_minutes only (never airport names,
 * postcodes, or straight-line distance).
 *
 * Activation time = scheduled_at − local|long activation minutes from Admin config.
 * No-preconfirmed fallback remains urgent_dispatch_trigger_minutes_before_pickup.
 */

export type ScheduledTripKind = "local" | "long";

export type ScheduledActivationConfig = {
  /** Duration minutes at/above this → LONG. Default 30. */
  longTripThresholdMinutes: number;
  /** Minutes before pickup to activate LOCAL trips. Default 11. */
  localActivationMinutesBeforePickup: number;
  /** Minutes before pickup to activate LONG trips. Default 30. */
  longActivationMinutesBeforePickup: number;
  /** Safety fallback when still no driver/preconfirm. Default 9. */
  urgentFallbackMinutesBeforePickup: number;
};

export const SCHEDULED_ACTIVATION_DEFAULTS: ScheduledActivationConfig = {
  longTripThresholdMinutes: 30,
  localActivationMinutesBeforePickup: 11,
  longActivationMinutesBeforePickup: 30,
  urgentFallbackMinutesBeforePickup: 9,
};

export const SCHEDULED_ACTIVATION_MAXIMA: ScheduledActivationConfig = {
  longTripThresholdMinutes: 24 * 60,
  localActivationMinutesBeforePickup: 24 * 60,
  longActivationMinutesBeforePickup: 24 * 60,
  urgentFallbackMinutesBeforePickup: 24 * 60,
};

export type ScheduledActivationDbRow = {
  long_trip_threshold_minutes?: number | null;
  local_activation_minutes_before_pickup?: number | null;
  long_activation_minutes_before_pickup?: number | null;
  urgent_dispatch_trigger_minutes_before_pickup?: number | null;
};

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveScheduledActivationConfig(
  row: ScheduledActivationDbRow | null | undefined,
): ScheduledActivationConfig {
  if (!row) return { ...SCHEDULED_ACTIVATION_DEFAULTS };
  return {
    longTripThresholdMinutes: parsePositiveInt(
      row.long_trip_threshold_minutes,
      SCHEDULED_ACTIVATION_DEFAULTS.longTripThresholdMinutes,
    ),
    localActivationMinutesBeforePickup: parsePositiveInt(
      row.local_activation_minutes_before_pickup,
      SCHEDULED_ACTIVATION_DEFAULTS.localActivationMinutesBeforePickup,
    ),
    longActivationMinutesBeforePickup: parsePositiveInt(
      row.long_activation_minutes_before_pickup,
      SCHEDULED_ACTIVATION_DEFAULTS.longActivationMinutesBeforePickup,
    ),
    urgentFallbackMinutesBeforePickup: parsePositiveInt(
      row.urgent_dispatch_trigger_minutes_before_pickup,
      SCHEDULED_ACTIVATION_DEFAULTS.urgentFallbackMinutesBeforePickup,
    ),
  };
}

/**
 * Canonical Local vs Long classification.
 * duration < threshold → LOCAL; duration >= threshold → LONG.
 * Missing/non-positive duration → LONG (safer earlier lead time) + callers should log.
 */
export function classifyScheduledTripKind(input: {
  estimatedDurationMinutes: number | null | undefined;
  longTripThresholdMinutes: number;
}): { kind: ScheduledTripKind; durationMinutes: number; usedFallbackDuration: boolean } {
  const threshold = Math.max(1, Math.floor(input.longTripThresholdMinutes));
  const raw = Number(input.estimatedDurationMinutes);
  const usedFallbackDuration = !Number.isFinite(raw) || raw <= 0;
  const durationMinutes = usedFallbackDuration ? threshold : Math.floor(raw);
  const kind: ScheduledTripKind = durationMinutes < threshold ? "local" : "long";
  return { kind, durationMinutes, usedFallbackDuration };
}

export function activationMinutesForKind(
  kind: ScheduledTripKind,
  config: Pick<
    ScheduledActivationConfig,
    "localActivationMinutesBeforePickup" | "longActivationMinutesBeforePickup"
  >,
): number {
  return kind === "local"
    ? Math.max(1, Math.floor(config.localActivationMinutesBeforePickup))
    : Math.max(1, Math.floor(config.longActivationMinutesBeforePickup));
}

export function computeScheduledActivationAtMs(input: {
  scheduledAtMs: number;
  estimatedDurationMinutes: number | null | undefined;
  config: ScheduledActivationConfig;
}): {
  kind: ScheduledTripKind;
  activationAtMs: number;
  activationMinutes: number;
  durationMinutes: number;
  usedFallbackDuration: boolean;
} {
  const classified = classifyScheduledTripKind({
    estimatedDurationMinutes: input.estimatedDurationMinutes,
    longTripThresholdMinutes: input.config.longTripThresholdMinutes,
  });
  const activationMinutes = activationMinutesForKind(classified.kind, input.config);
  return {
    kind: classified.kind,
    activationAtMs: input.scheduledAtMs - activationMinutes * 60_000,
    activationMinutes,
    durationMinutes: classified.durationMinutes,
    usedFallbackDuration: classified.usedFallbackDuration,
  };
}

export function isScheduledActivationDue(input: {
  scheduledAt: string;
  estimatedDurationMinutes: number | null | undefined;
  config: ScheduledActivationConfig;
  nowMs: number;
}): {
  due: boolean;
  kind: ScheduledTripKind;
  activationAtMs: number;
  pickupMs: number;
  pastPickup: boolean;
  usedFallbackDuration: boolean;
} {
  const pickupMs = Date.parse(input.scheduledAt);
  if (!Number.isFinite(pickupMs)) {
    return {
      due: false,
      kind: "local",
      activationAtMs: NaN,
      pickupMs: NaN,
      pastPickup: false,
      usedFallbackDuration: true,
    };
  }
  const computed = computeScheduledActivationAtMs({
    scheduledAtMs: pickupMs,
    estimatedDurationMinutes: input.estimatedDurationMinutes,
    config: input.config,
  });
  const pastPickup = input.nowMs > pickupMs;
  const due = input.nowMs >= computed.activationAtMs || pastPickup;
  return {
    due,
    kind: computed.kind,
    activationAtMs: computed.activationAtMs,
    pickupMs,
    pastPickup,
    usedFallbackDuration: computed.usedFallbackDuration,
  };
}

/** Lookahead window for cron scan = max(local, long) activation + buffer. */
export function scheduledActivationLookaheadMs(
  config: Pick<
    ScheduledActivationConfig,
    "localActivationMinutesBeforePickup" | "longActivationMinutesBeforePickup"
  >,
  bufferMinutes = 15,
): number {
  const maxAct = Math.max(
    config.localActivationMinutesBeforePickup,
    config.longActivationMinutesBeforePickup,
  );
  return (Math.max(1, maxAct) + Math.max(0, bufferMinutes)) * 60_000;
}

export function mapScheduledActivationToDb(
  config: ScheduledActivationConfig,
): Record<string, number> {
  return {
    long_trip_threshold_minutes: config.longTripThresholdMinutes,
    local_activation_minutes_before_pickup: config.localActivationMinutesBeforePickup,
    long_activation_minutes_before_pickup: config.longActivationMinutesBeforePickup,
    urgent_dispatch_trigger_minutes_before_pickup:
      config.urgentFallbackMinutesBeforePickup,
  };
}

export function validateScheduledActivationConfig(
  config: ScheduledActivationConfig,
): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  const check = (field: keyof ScheduledActivationConfig, label: string) => {
    const v = config[field];
    const max = SCHEDULED_ACTIVATION_MAXIMA[field];
    if (!Number.isFinite(v) || v < 1) {
      issues.push({ field, message: `${label} must be at least 1` });
    } else if (v > max) {
      issues.push({ field, message: `${label} must be ≤ ${max}` });
    }
  };
  check("longTripThresholdMinutes", "Long Trip Threshold");
  check("localActivationMinutesBeforePickup", "Local Scheduled Activation");
  check("longActivationMinutesBeforePickup", "Long Scheduled Activation");
  check("urgentFallbackMinutesBeforePickup", "No-preconfirmed Fallback");
  return issues;
}
