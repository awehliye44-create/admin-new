/**
 * Scheduled booking advance window SSOT.
 *
 * Max advance is max_advance_days × 24 elapsed hours in UTC (not calendar end-of-day).
 * Phase 1: max_advance_days = 5 → exactly 120 elapsed hours.
 */

export const SCHEDULED_ADVANCE_HOURS_PER_DAY = 24;

export const SCHEDULED_CAPTURE_COVERAGE_SAFETY_MARGIN_MINUTES = 360;

export type ScheduledAdvanceWindowPolicy = {
  scheduledRidesEnabled: boolean;
  minAdvanceMinutes: number;
  maxAdvanceDays: number;
};

export const SCHEDULED_ADVANCE_WINDOW_DEFAULTS: ScheduledAdvanceWindowPolicy = {
  scheduledRidesEnabled: true,
  minAdvanceMinutes: 20,
  maxAdvanceDays: 5,
};

export type ScheduledAdvanceWindowIssueCode =
  | "DISABLED"
  | "INVALID_SCHEDULED_AT"
  | "TOO_SOON"
  | "TOO_FAR";

export type ScheduledAdvanceWindowResult =
  | { ok: true; minAdvanceMinutes: number; maxAdvanceDays: number; maxAdvanceMs: number }
  | {
      ok: false;
      code: ScheduledAdvanceWindowIssueCode;
      reason: string;
      minAdvanceMinutes: number;
      maxAdvanceDays: number;
    };

export function maxAdvanceElapsedMs(maxAdvanceDays: number): number {
  const days = Math.max(0, Math.floor(Number(maxAdvanceDays) || 0));
  return days * SCHEDULED_ADVANCE_HOURS_PER_DAY * 60 * 60 * 1000;
}

export function resolveScheduledAdvanceWindowPolicy(
  row: {
    scheduled_rides_enabled?: boolean | null;
    min_advance_time_minutes?: number | null;
    max_advance_days?: number | null;
  } | null | undefined,
): ScheduledAdvanceWindowPolicy {
  if (!row) return { ...SCHEDULED_ADVANCE_WINDOW_DEFAULTS };
  const minRaw =
    row.min_advance_time_minutes == null
      ? NaN
      : Number(row.min_advance_time_minutes);
  const maxRaw =
    row.max_advance_days == null
      ? NaN
      : Number(row.max_advance_days);
  return {
    scheduledRidesEnabled: row.scheduled_rides_enabled !== false,
    minAdvanceMinutes:
      Number.isFinite(minRaw) && minRaw >= 0
        ? Math.floor(minRaw)
        : SCHEDULED_ADVANCE_WINDOW_DEFAULTS.minAdvanceMinutes,
    maxAdvanceDays:
      Number.isFinite(maxRaw) && maxRaw >= 1
        ? Math.floor(maxRaw)
        : SCHEDULED_ADVANCE_WINDOW_DEFAULTS.maxAdvanceDays,
  };
}

/**
 * UTC elapsed-time window: now + minMinutes ≤ scheduledAt ≤ now + maxDays×24h.
 * Uses absolute timestamps only (DST cannot stretch the 120h cap).
 */
export function evaluateScheduledAdvanceWindow(input: {
  scheduledAtIso: string;
  nowMs?: number;
  policy: ScheduledAdvanceWindowPolicy;
  /**
   * When true, skip TOO_FAR (grandfather existing bookings / modifications that
   * only shorten lead time). Callers must still enforce TOO_SOON / DISABLED.
   */
  grandfatherMaxAdvance?: boolean;
}): ScheduledAdvanceWindowResult {
  const nowMs = input.nowMs ?? Date.now();
  const { policy } = input;
  const minAdvanceMinutes = policy.minAdvanceMinutes;
  const maxAdvanceDays = policy.maxAdvanceDays;
  const maxAdvanceMs = maxAdvanceElapsedMs(maxAdvanceDays);

  if (!policy.scheduledRidesEnabled) {
    return {
      ok: false,
      code: "DISABLED",
      reason: "Scheduled rides are not available.",
      minAdvanceMinutes,
      maxAdvanceDays,
    };
  }

  const pickupMs = Date.parse(String(input.scheduledAtIso ?? ""));
  if (!Number.isFinite(pickupMs)) {
    return {
      ok: false,
      code: "INVALID_SCHEDULED_AT",
      reason: "Pickup time is invalid.",
      minAdvanceMinutes,
      maxAdvanceDays,
    };
  }

  const minMs = nowMs + Math.max(0, minAdvanceMinutes) * 60_000;
  if (pickupMs < minMs) {
    return {
      ok: false,
      code: "TOO_SOON",
      reason: `Pickup must be at least ${minAdvanceMinutes} minutes from now.`,
      minAdvanceMinutes,
      maxAdvanceDays,
    };
  }

  if (!input.grandfatherMaxAdvance) {
    const maxMs = nowMs + maxAdvanceMs;
    if (pickupMs > maxMs) {
      const hours = Math.floor(maxAdvanceMs / 3_600_000);
      return {
        ok: false,
        code: "TOO_FAR",
        reason: `Pickup cannot be more than ${hours} hours (${maxAdvanceDays} days) from now.`,
        minAdvanceMinutes,
        maxAdvanceDays,
      };
    }
  }

  return { ok: true, minAdvanceMinutes, maxAdvanceDays, maxAdvanceMs };
}

/** Expected journey completion + safety margin (ms). */
export function computeRequiredCaptureCoverageUntilMs(input: {
  scheduledAtIso: string;
  estimatedDurationMinutes: number | null | undefined;
  safetyMarginMinutes?: number;
}): number | null {
  const pickupMs = Date.parse(String(input.scheduledAtIso ?? ""));
  if (!Number.isFinite(pickupMs)) return null;
  const duration = Number(input.estimatedDurationMinutes);
  const durationMinutes =
    Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 30;
  const margin =
    input.safetyMarginMinutes ?? SCHEDULED_CAPTURE_COVERAGE_SAFETY_MARGIN_MINUTES;
  return pickupMs + (durationMinutes + Math.max(0, margin)) * 60_000;
}
