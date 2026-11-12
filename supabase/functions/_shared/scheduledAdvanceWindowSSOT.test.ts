import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SCHEDULED_ADVANCE_WINDOW_DEFAULTS,
  SCHEDULED_PAYMENT_COMPLETION_BOUND_MS,
  evaluateScheduledAdvanceWindow,
  evaluateScheduledAdvanceWindowForFinalisation,
  maxAdvanceElapsedMs,
  computeRequiredCaptureCoverageUntilMs,
  resolveScheduledAdvanceWindowPolicy,
} from "./scheduledAdvanceWindowSSOT.ts";

Deno.test("max advance is exactly 120 elapsed hours for 5 days", () => {
  assertEquals(maxAdvanceElapsedMs(5), 120 * 60 * 60 * 1000);
  assertEquals(SCHEDULED_ADVANCE_WINDOW_DEFAULTS.maxAdvanceDays, 5);
});

Deno.test("exactly 120-hour boundary is accepted; +1ms rejected", () => {
  const nowMs = Date.parse("2026-03-28T12:00:00.000Z");
  const policy = { ...SCHEDULED_ADVANCE_WINDOW_DEFAULTS };
  const at120 = new Date(nowMs + 120 * 60 * 60 * 1000).toISOString();
  const ok = evaluateScheduledAdvanceWindow({
    scheduledAtIso: at120,
    nowMs,
    policy,
  });
  assertEquals(ok.ok, true);

  const past120 = new Date(nowMs + 120 * 60 * 60 * 1000 + 1).toISOString();
  const far = evaluateScheduledAdvanceWindow({
    scheduledAtIso: past120,
    nowMs,
    policy,
  });
  assertEquals(far.ok, false);
  if (!far.ok) assertEquals(far.code, "TOO_FAR");
});

Deno.test("DST transition cannot extend the 120h UTC window", () => {
  // UK spring forward 2026-03-29 01:00 → 02:00 local; window is still UTC elapsed.
  const nowMs = Date.parse("2026-03-28T00:30:00.000Z");
  const policy = { ...SCHEDULED_ADVANCE_WINDOW_DEFAULTS, minAdvanceMinutes: 20 };
  const at120 = new Date(nowMs + 120 * 60 * 60 * 1000).toISOString();
  const ok = evaluateScheduledAdvanceWindow({ scheduledAtIso: at120, nowMs, policy });
  assert(ok.ok);
  const past = new Date(nowMs + 120 * 60 * 60 * 1000 + 1000).toISOString();
  const far = evaluateScheduledAdvanceWindow({ scheduledAtIso: past, nowMs, policy });
  assertEquals(far.ok, false);
});

Deno.test("min advance 20 minutes is enforced", () => {
  const nowMs = Date.parse("2026-06-01T10:00:00.000Z");
  const policy = { ...SCHEDULED_ADVANCE_WINDOW_DEFAULTS };
  const tooSoon = new Date(nowMs + 19 * 60 * 1000).toISOString();
  const r = evaluateScheduledAdvanceWindow({ scheduledAtIso: tooSoon, nowMs, policy });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "TOO_SOON");

  const okAt = new Date(nowMs + 20 * 60 * 1000).toISOString();
  assertEquals(
    evaluateScheduledAdvanceWindow({ scheduledAtIso: okAt, nowMs, policy }).ok,
    true,
  );
});

Deno.test("grandfather skips TOO_FAR but still blocks TOO_SOON", () => {
  const nowMs = Date.parse("2026-06-01T10:00:00.000Z");
  const policy = { ...SCHEDULED_ADVANCE_WINDOW_DEFAULTS };
  const far = new Date(nowMs + 200 * 60 * 60 * 1000).toISOString();
  const g = evaluateScheduledAdvanceWindow({
    scheduledAtIso: far,
    nowMs,
    policy,
    grandfatherMaxAdvance: true,
  });
  assertEquals(g.ok, true);

  const soon = new Date(nowMs + 5 * 60 * 1000).toISOString();
  const s = evaluateScheduledAdvanceWindow({
    scheduledAtIso: soon,
    nowMs,
    policy,
    grandfatherMaxAdvance: true,
  });
  assertEquals(s.ok, false);
});

Deno.test("required coverage horizon = pickup + duration + 360m", () => {
  const pickup = "2026-06-01T12:00:00.000Z";
  const until = computeRequiredCaptureCoverageUntilMs({
    scheduledAtIso: pickup,
    estimatedDurationMinutes: 45,
  });
  assertEquals(until, Date.parse(pickup) + (45 + 360) * 60_000);
});

Deno.test("resolve policy falls back to Phase 1 defaults", () => {
  const p = resolveScheduledAdvanceWindowPolicy({
    scheduled_rides_enabled: true,
    min_advance_time_minutes: null,
    max_advance_days: null,
  });
  assertEquals(p.maxAdvanceDays, 5);
  assertEquals(p.minAdvanceMinutes, 20);
});

Deno.test("Scenario D: validated attempt survives Apple Pay latency past wall-clock 20m", () => {
  const validatedAtMs = Date.parse("2026-11-12T20:04:49.000Z");
  const scheduledAt = "2026-11-12T20:25:00.000Z"; // 20m 11s after validated
  const finalizeNowMs = Date.parse("2026-11-12T20:05:05.000Z"); // past wall-clock 20m boundary
  const policy = { ...SCHEDULED_ADVANCE_WINDOW_DEFAULTS };
  const wall = evaluateScheduledAdvanceWindow({
    scheduledAtIso: scheduledAt,
    nowMs: finalizeNowMs,
    policy,
  });
  assertEquals(wall.ok, false);

  const final = evaluateScheduledAdvanceWindowForFinalisation({
    scheduledAtIso: scheduledAt,
    nowMs: finalizeNowMs,
    policy,
    validatedAtIso: new Date(validatedAtMs).toISOString(),
    validatedScheduledAtIso: scheduledAt,
    paymentCompletionBoundMs: SCHEDULED_PAYMENT_COMPLETION_BOUND_MS,
  });
  assertEquals(final.ok, true);
});

Deno.test("Scenario E: stale or mismatched attempt fails closed", () => {
  const policy = { ...SCHEDULED_ADVANCE_WINDOW_DEFAULTS };
  const scheduledAt = "2026-11-12T20:25:00.000Z";
  const validatedAtMs = Date.parse("2026-11-12T20:04:49.000Z");
  const staleNow = validatedAtMs + SCHEDULED_PAYMENT_COMPLETION_BOUND_MS + 1;
  const stale = evaluateScheduledAdvanceWindowForFinalisation({
    scheduledAtIso: scheduledAt,
    nowMs: staleNow,
    policy,
    validatedAtIso: new Date(validatedAtMs).toISOString(),
    validatedScheduledAtIso: scheduledAt,
  });
  assertEquals(stale.ok, false);
  if (!stale.ok) assertEquals(stale.code, "STALE_PAYMENT_ATTEMPT");

  const mismatched = evaluateScheduledAdvanceWindowForFinalisation({
    scheduledAtIso: "2026-11-12T21:00:00.000Z",
    nowMs: validatedAtMs + 60_000,
    policy,
    validatedAtIso: new Date(validatedAtMs).toISOString(),
    validatedScheduledAtIso: scheduledAt,
  });
  assertEquals(mismatched.ok, false);
});
