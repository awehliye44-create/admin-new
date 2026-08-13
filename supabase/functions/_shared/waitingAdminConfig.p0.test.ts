/**
 * Pure unit tests for pickup waiting Admin SSOT + completed-interval charging.
 * Run: deno test --allow-read supabase/functions/_shared/waitingAdminConfig.p0.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAdminWaitingConfigSnapshot,
  computePickupWaitingChargePence,
  resolveFrozenOrLiveWaitingConfig,
  resolvePickupGraceSeconds,
  resolveWaitingChargeIntervalSeconds,
} from "./waitingAdminConfig.ts";

Deno.test("P0#2 free wait: fare minutes beat dispatch grace", () => {
  const g = resolvePickupGraceSeconds(
    { free_waiting_minutes: 3 },
    { pickup_waiting_grace_period_seconds: 300 },
  );
  assertEquals(g, { seconds: 180, source: "fare_pricing" });
});

Deno.test("P0#2 free wait: missing config fails closed to 0/unavailable", () => {
  const g = resolvePickupGraceSeconds(null, null);
  assertEquals(g.source, "unavailable");
  assertEquals(g.seconds, 0);
});

Deno.test("P0#2 vehicle fare rate + paid flag beat dispatch poison", () => {
  const snap = buildAdminWaitingConfigSnapshot(
    {
      free_waiting_minutes: 3,
      pickup_paid_waiting_enabled: true,
      waiting_per_minute_pence: 25,
    },
    {
      pickup_waiting_grace_period_seconds: 300,
      pickup_paid_waiting_enabled: false,
      pickup_paid_waiting_rate_pence_per_minute: 30,
      stop_waiting_charge_interval_seconds: 15,
    },
    null,
  );
  assertEquals(snap.free_pickup_waiting_seconds, 180);
  assertEquals(snap.pickup_paid_waiting_enabled, true);
  assertEquals(snap.pickup_paid_waiting_rate_pence_per_minute, 25);
  assertEquals(snap.waiting_charge_interval_seconds, 15);
  assertEquals(snap.waiting_charge_rounding, "completed_intervals");
  assert(snap.config_available);
});

Deno.test("P0#2 charge interval from SA dispatch (shared field)", () => {
  const i = resolveWaitingChargeIntervalSeconds(
    { stop_waiting_charge_interval_seconds: 15 },
    { stop_waiting_charge_interval_seconds: 10 },
  );
  assertEquals(i, { seconds: 15, source: "dispatch_settings" });
});

Deno.test("P0#2 free period charges zero", () => {
  const c = computePickupWaitingChargePence({
    paidSeconds: 0,
    ratePencePerMinute: 25,
    intervalSeconds: 15,
    maxMinutes: 15,
  });
  assertEquals(c.charge_pence, 0);
  assertEquals(c.intervals_charged, 0);
});

Deno.test("P0#2 first completed interval charges once (25p/min, 15s → 6p)", () => {
  // 25p/min * 15/60 = 6.25 → round 6p per interval
  const c = computePickupWaitingChargePence({
    paidSeconds: 15,
    ratePencePerMinute: 25,
    intervalSeconds: 15,
    maxMinutes: 15,
  });
  assertEquals(c.intervals_charged, 1);
  assertEquals(c.pence_per_interval, 6);
  assertEquals(c.charge_pence, 6);
});

Deno.test("P0#2 partial interval does not charge (completed intervals only)", () => {
  const c = computePickupWaitingChargePence({
    paidSeconds: 14,
    ratePencePerMinute: 25,
    intervalSeconds: 15,
    maxMinutes: 15,
  });
  assertEquals(c.intervals_charged, 0);
  assertEquals(c.charge_pence, 0);
});

Deno.test("P0#2 two intervals accumulate", () => {
  const c = computePickupWaitingChargePence({
    paidSeconds: 30,
    ratePencePerMinute: 25,
    intervalSeconds: 15,
    maxMinutes: 15,
  });
  assertEquals(c.intervals_charged, 2);
  assertEquals(c.charge_pence, 12);
});

Deno.test("P0#2 missing max minutes is uncapped (not invented 15)", () => {
  const c = computePickupWaitingChargePence({
    paidSeconds: 20 * 60,
    ratePencePerMinute: 25,
    intervalSeconds: 15,
    maxMinutes: 0,
  });
  assertEquals(c.intervals_charged, 80);
  assertEquals(c.charge_pence, 480);
});

Deno.test("P0#2 missing interval fails closed to 0", () => {
  const c = computePickupWaitingChargePence({
    paidSeconds: 60,
    ratePencePerMinute: 25,
    intervalSeconds: 0,
    maxMinutes: 15,
  });
  assertEquals(c.charge_pence, 0);
});

Deno.test("P0#2 frozen config wins over live Admin reload", () => {
  const live = buildAdminWaitingConfigSnapshot(
    { free_waiting_minutes: 5, pickup_paid_waiting_enabled: false, waiting_per_minute_pence: 30 },
    { stop_waiting_charge_interval_seconds: 10 },
    null,
  );
  const frozen = {
    free_pickup_waiting_seconds: 180,
    free_pickup_waiting_minutes: 3,
    pickup_grace_source: "fare_pricing",
    pickup_paid_waiting_enabled: true,
    pickup_paid_waiting_rate_pence_per_minute: 25,
    waiting_charge_interval_seconds: 15,
    waiting_charge_interval_source: "dispatch_settings",
    config_available: true,
  };
  const resolved = resolveFrozenOrLiveWaitingConfig(frozen, live);
  assertEquals(resolved.free_pickup_waiting_seconds, 180);
  assertEquals(resolved.pickup_paid_waiting_enabled, true);
  assertEquals(resolved.pickup_paid_waiting_rate_pence_per_minute, 25);
  assertEquals(resolved.waiting_charge_interval_seconds, 15);
});
