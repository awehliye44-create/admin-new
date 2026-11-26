/**
 * #100A — waiting runner must stamp pickup_waiting_last_tick_at on every
 * geofence sync (including free wait), and cron must advance SSOT without
 * the Driver app.
 *
 * Run: deno test --allow-read supabase/tests/_shared/bug100aWaitingRunnerHeartbeatLock.test.ts
 */
import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("#100A syncWaitingGeofenceClock stamps last_tick_at on pickup", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/waitingSegmentClock.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "pickup_waiting_last_tick_at");
  assertStringIncludes(src, "#100A — Heartbeat of waiting SSOT evaluation");
});

Deno.test("#100A advance-active-waiting-ssot cron edge exists", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/advance-active-waiting-ssot/index.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "assertCronOrServiceRoleAuth");
  assertStringIncludes(src, "syncWaitingGeofenceClock");
  assertStringIncludes(src, "computePickupChargeFromCountedSeconds");
  assertStringIncludes(src, "computeStopChargeFromCountedSeconds");
  assertStringIncludes(src, 'locationType: "stop"');
  assertStringIncludes(src, "waiting_charge_active");
  assertStringIncludes(src, "Recovery mechanism");
  assertStringIncludes(src, "#100A");
});

Deno.test("#100A cron migration schedules advance-active-waiting-ssot", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20270304170000_bug100a_advance_active_waiting_ssot_cron.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "advance-active-waiting-ssot");
  assertStringIncludes(src, "advance-active-waiting-ssot-every-1-min");
});
