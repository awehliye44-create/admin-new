/**
 * Local vs Long scheduled activation SSOT — boundary + config certification.
 */
import {
  classifyScheduledTripKind,
  computeScheduledActivationAtMs,
  isScheduledActivationDue,
  resolveScheduledActivationConfig,
  SCHEDULED_ACTIVATION_DEFAULTS,
} from "../../functions/_shared/scheduledActivationSSOT.ts";

Deno.test("classify: duration < threshold → LOCAL; >= → LONG (threshold=30)", () => {
  const threshold = 30;
  const cases: Array<[number, "local" | "long"]> = [
    [18, "local"],
    [29, "local"],
    [30, "long"],
    [40, "long"],
    [70, "long"],
    [105, "long"],
  ];
  for (const [duration, expected] of cases) {
    const { kind } = classifyScheduledTripKind({
      estimatedDurationMinutes: duration,
      longTripThresholdMinutes: threshold,
    });
    if (kind !== expected) {
      throw new Error(`${duration} min → expected ${expected}, got ${kind}`);
    }
  }
});

Deno.test("activation: pickup 14:00 LOCAL→13:49 LONG→13:30 (defaults)", () => {
  const pickup = Date.parse("2026-09-22T14:00:00.000Z");
  const cfg = resolveScheduledActivationConfig(null);

  const local = computeScheduledActivationAtMs({
    scheduledAtMs: pickup,
    estimatedDurationMinutes: 18,
    config: cfg,
  });
  if (local.kind !== "local") throw new Error("18m should be LOCAL");
  if (local.activationAtMs !== Date.parse("2026-09-22T13:49:00.000Z")) {
    throw new Error(`LOCAL activation ${new Date(local.activationAtMs).toISOString()}`);
  }

  const long = computeScheduledActivationAtMs({
    scheduledAtMs: pickup,
    estimatedDurationMinutes: 70,
    config: cfg,
  });
  if (long.kind !== "long") throw new Error("70m should be LONG");
  if (long.activationAtMs !== Date.parse("2026-09-22T13:30:00.000Z")) {
    throw new Error(`LONG activation ${new Date(long.activationAtMs).toISOString()}`);
  }
});

Deno.test("config change: threshold 30→45 makes 40m LOCAL without code change", () => {
  const cfg = resolveScheduledActivationConfig({
    long_trip_threshold_minutes: 45,
    local_activation_minutes_before_pickup: 11,
    long_activation_minutes_before_pickup: 30,
    urgent_dispatch_trigger_minutes_before_pickup: 9,
  });
  const { kind } = classifyScheduledTripKind({
    estimatedDurationMinutes: 40,
    longTripThresholdMinutes: cfg.longTripThresholdMinutes,
  });
  if (kind !== "local") throw new Error("40m with threshold 45 must be LOCAL");
});

Deno.test("config change: Local 11→15 and Long 30→45 move activation", () => {
  const pickup = Date.parse("2026-09-22T14:00:00.000Z");
  const cfg = resolveScheduledActivationConfig({
    long_trip_threshold_minutes: 30,
    local_activation_minutes_before_pickup: 15,
    long_activation_minutes_before_pickup: 45,
    urgent_dispatch_trigger_minutes_before_pickup: 9,
  });
  const local = computeScheduledActivationAtMs({
    scheduledAtMs: pickup,
    estimatedDurationMinutes: 18,
    config: cfg,
  });
  if (local.activationAtMs !== Date.parse("2026-09-22T13:45:00.000Z")) {
    throw new Error(`expected 13:45 got ${new Date(local.activationAtMs).toISOString()}`);
  }
  const long = computeScheduledActivationAtMs({
    scheduledAtMs: pickup,
    estimatedDurationMinutes: 70,
    config: cfg,
  });
  if (long.activationAtMs !== Date.parse("2026-09-22T13:15:00.000Z")) {
    throw new Error(`expected 13:15 got ${new Date(long.activationAtMs).toISOString()}`);
  }
});

Deno.test("isScheduledActivationDue respects now vs T-minute", () => {
  const cfg = { ...SCHEDULED_ACTIVATION_DEFAULTS };
  const before = isScheduledActivationDue({
    scheduledAt: "2026-09-22T14:00:00.000Z",
    estimatedDurationMinutes: 18,
    config: cfg,
    nowMs: Date.parse("2026-09-22T13:48:00.000Z"),
  });
  if (before.due) throw new Error("13:48 should not be due for LOCAL T−11");
  const at = isScheduledActivationDue({
    scheduledAt: "2026-09-22T14:00:00.000Z",
    estimatedDurationMinutes: 18,
    config: cfg,
    nowMs: Date.parse("2026-09-22T13:49:00.000Z"),
  });
  if (!at.due) throw new Error("13:49 must be due for LOCAL T−11");
});

Deno.test("defaults match product lock 30/11/30/9", () => {
  const d = SCHEDULED_ACTIVATION_DEFAULTS;
  if (d.longTripThresholdMinutes !== 30) throw new Error("threshold default");
  if (d.localActivationMinutesBeforePickup !== 11) throw new Error("local default");
  if (d.longActivationMinutesBeforePickup !== 30) throw new Error("long default");
  if (d.urgentFallbackMinutesBeforePickup !== 9) throw new Error("fallback default");
});
