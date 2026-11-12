/**
 * Scheduled booking advance window SSOT.
 *
 * Max advance is max_advance_days × 24 elapsed hours in UTC (not calendar end-of-day).
 * Phase 1: max_advance_days = 5 → exactly 120 elapsed hours.
 */

export const SCHEDULED_ADVANCE_HOURS_PER_DAY = 24;

export const SCHEDULED_CAPTURE_COVERAGE_SAFETY_MARGIN_MINUTES = 360;

/**
 * Bounded payment-completion slack: if advance window passed at preauth,
 * finalisation may re-check against the validated attempt clock while
 * (now − validated_at) ≤ this bound AND pickup remains operationally feasible.
 * Does not weaken the 20-minute / 5-day policy at intent creation.
 */
export const SCHEDULED_PAYMENT_COMPLETION_BOUND_MS = 10 * 60_000;

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
  | "TOO_FAR"
  | "STALE_PAYMENT_ATTEMPT"
  | "PICKUP_NO_LONGER_FEASIBLE";

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

function normaliseIsoOrNull(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Same pickup identity check — ignores trailing Z / ms formatting noise.
 */
export function scheduledAtMatchesValidated(
  requestedIso: string,
  validatedIso: string | null | undefined,
): boolean {
  const a = normaliseIsoOrNull(requestedIso);
  const b = normaliseIsoOrNull(validatedIso);
  if (!a || !b) return false;
  return Date.parse(a) === Date.parse(b);
}

export type AdvanceWindowFinalisationClock =
  | {
    ok: true;
    nowMsForAdvanceCheck: number;
    usedValidatedAttemptClock: boolean;
    reason: string;
  }
  | {
    ok: false;
    code: "TOO_SOON" | "INVALID_SCHEDULED_AT" | "STALE_PAYMENT_ATTEMPT" | "PICKUP_NO_LONGER_FEASIBLE";
    reason: string;
  };

/**
 * Choose the clock for post-auth advance re-check.
 * - Validated at preauth + same immutable scheduled_at + within payment bound
 *   → re-evaluate against validated_at (Apple Pay latency must not auto-TOO_SOON).
 * - Still requires pickup strictly after wall-clock now (operational feasibility).
 * - Stale / changed / missing validation → wall-clock now (fail closed).
 */
export function resolveAdvanceWindowClockForFinalisation(input: {
  scheduledAtIso: string;
  nowMs?: number;
  validatedAtIso?: string | null;
  validatedScheduledAtIso?: string | null;
  paymentCompletionBoundMs?: number;
}): AdvanceWindowFinalisationClock {
  const nowMs = input.nowMs ?? Date.now();
  const pickupMs = Date.parse(String(input.scheduledAtIso ?? ""));
  if (!Number.isFinite(pickupMs)) {
    return {
      ok: false,
      code: "INVALID_SCHEDULED_AT",
      reason: "Pickup time is invalid.",
    };
  }
  if (pickupMs <= nowMs) {
    return {
      ok: false,
      code: "PICKUP_NO_LONGER_FEASIBLE",
      reason: "Pickup time is no longer feasible.",
    };
  }

  const bound = Math.max(
    0,
    input.paymentCompletionBoundMs ?? SCHEDULED_PAYMENT_COMPLETION_BOUND_MS,
  );
  const validatedAtMs = input.validatedAtIso
    ? Date.parse(String(input.validatedAtIso))
    : NaN;
  const hasValidation =
    Number.isFinite(validatedAtMs) &&
    Boolean(normaliseIsoOrNull(input.validatedScheduledAtIso));
  const matches = scheduledAtMatchesValidated(
    input.scheduledAtIso,
    input.validatedScheduledAtIso,
  );

  // Replay / changed pickup after preauth — never bypass with wall-clock.
  if (hasValidation && !matches) {
    return {
      ok: false,
      code: "STALE_PAYMENT_ATTEMPT",
      reason: "Pickup time no longer matches the validated payment attempt.",
    };
  }

  if (
    matches &&
    Number.isFinite(validatedAtMs) &&
    nowMs >= validatedAtMs &&
    nowMs - validatedAtMs <= bound
  ) {
    return {
      ok: true,
      nowMsForAdvanceCheck: validatedAtMs,
      usedValidatedAttemptClock: true,
      reason: "validated_payment_attempt_clock",
    };
  }

  if (matches && Number.isFinite(validatedAtMs) && nowMs - validatedAtMs > bound) {
    return {
      ok: false,
      code: "STALE_PAYMENT_ATTEMPT",
      reason: "Payment attempt exceeded the bounded completion window.",
    };
  }

  return {
    ok: true,
    nowMsForAdvanceCheck: nowMs,
    usedValidatedAttemptClock: false,
    reason: "wall_clock",
  };
}

/**
 * Full finalisation advance check (preauth-validated clock + policy).
 */
export function evaluateScheduledAdvanceWindowForFinalisation(input: {
  scheduledAtIso: string;
  nowMs?: number;
  policy: ScheduledAdvanceWindowPolicy;
  validatedAtIso?: string | null;
  validatedScheduledAtIso?: string | null;
  paymentCompletionBoundMs?: number;
  grandfatherMaxAdvance?: boolean;
}): ScheduledAdvanceWindowResult {
  const clock = resolveAdvanceWindowClockForFinalisation({
    scheduledAtIso: input.scheduledAtIso,
    nowMs: input.nowMs,
    validatedAtIso: input.validatedAtIso,
    validatedScheduledAtIso: input.validatedScheduledAtIso,
    paymentCompletionBoundMs: input.paymentCompletionBoundMs,
  });
  if (!clock.ok) {
    return {
      ok: false,
      code: clock.code,
      reason: clock.reason,
      minAdvanceMinutes: input.policy.minAdvanceMinutes,
      maxAdvanceDays: input.policy.maxAdvanceDays,
    };
  }
  return evaluateScheduledAdvanceWindow({
    scheduledAtIso: input.scheduledAtIso,
    nowMs: clock.nowMsForAdvanceCheck,
    policy: input.policy,
    grandfatherMaxAdvance: input.grandfatherMaxAdvance,
  });
}
