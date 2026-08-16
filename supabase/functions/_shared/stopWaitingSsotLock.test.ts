/**
 * Lock: stop waiting SSOT — stop_waiting_settings first for grace/rate/interval;
 * enable_stop_waiting_charge from dispatch_settings only (never pickup flags).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAdminWaitingConfigSnapshot,
  resolveStopGraceSeconds,
  resolveWaitingChargeIntervalSeconds,
} from "./waitingAdminConfig.ts";

Deno.test("stop grace prefers stop_waiting_settings over dispatch and fare", () => {
  const g = resolveStopGraceSeconds(
    { stop_waiting_grace_period_minutes: 3 },
    { stop_waiting_grace_period_seconds: 180 },
    { stop_waiting_grace_period_seconds: 60 },
  );
  assertEquals(g, { seconds: 60, source: "stop_waiting_settings" });
});

Deno.test("stop interval prefers stop_waiting_settings over dispatch", () => {
  const i = resolveWaitingChargeIntervalSeconds(
    { stop_waiting_charge_interval_seconds: 30 },
    { stop_waiting_charge_interval_seconds: 15 },
  );
  assertEquals(i, { seconds: 15, source: "stop_waiting_settings" });
});

Deno.test("stop rate prefers stop_waiting_settings; enable never from recalculate_on_waiting", () => {
  const snap = buildAdminWaitingConfigSnapshot(
    {
      free_waiting_minutes: 3,
      recalculate_on_waiting: false,
      pickup_paid_waiting_enabled: false,
      stop_waiting_rate_pence_per_minute: 99,
      stop_waiting_grace_period_minutes: 3,
    },
    {
      enable_stop_waiting_charge: true,
      stop_waiting_rate_pence_per_minute: 50,
      stop_waiting_grace_period_seconds: 180,
      stop_radius_enabled: true,
      stop_radius_meters: 200,
    },
    {
      stop_waiting_rate_pence_per_minute: 30,
      stop_waiting_grace_period_seconds: 60,
      stop_waiting_charge_interval_seconds: 15,
      stop_radius_enabled: true,
      stop_radius_meters: 150,
      stop_waiting_max_minutes: null,
    },
  );
  assertEquals(snap.free_stop_waiting_seconds, 60);
  assertEquals(snap.stop_grace_source, "stop_waiting_settings");
  assertEquals(snap.stop_waiting_rate_pence_per_minute, 30);
  assertEquals(snap.waiting_charge_interval_seconds, 15);
  assertEquals(snap.waiting_charge_interval_source, "stop_waiting_settings");
  assertEquals(snap.enable_stop_waiting_charge, true);
  assertEquals(snap.stop_radius_meters, 150);
  // Pickup paid can be false while stop waiting remains enabled.
  assertEquals(snap.pickup_paid_waiting_enabled, false);
});

Deno.test("enable_stop_waiting_charge false is honored even if fare recalculate_on_waiting true", () => {
  const snap = buildAdminWaitingConfigSnapshot(
    {
      free_waiting_minutes: 3,
      recalculate_on_waiting: true,
      pickup_paid_waiting_enabled: true,
      waiting_per_minute_pence: 25,
    },
    { enable_stop_waiting_charge: false },
    { stop_waiting_grace_period_seconds: 60, stop_waiting_rate_pence_per_minute: 30 },
  );
  assertEquals(snap.enable_stop_waiting_charge, false);
  assertEquals(snap.pickup_paid_waiting_enabled, true);
});
