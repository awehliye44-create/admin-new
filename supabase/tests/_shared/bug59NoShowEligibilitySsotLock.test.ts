/**
 * Bug #59 — No-show eligibility SSOT lock (MK-261120-001).
 * Soft-poll SQL + Edge must share counted-after-scheduled-floor semantics.
 *
 * Run: deno test --allow-read supabase/tests/_shared/bug59NoShowEligibilitySsotLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../", import.meta.url).pathname;

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(`${root}${rel}`);
}

Deno.test("Bug #59 migration adds resolve_pickup_no_show_eligibility SSOT", async () => {
  const mig = await read(
    "migrations/20261120214810_bug59_no_show_eligibility_ssot.sql",
  );
  assertStringIncludes(mig, "CREATE OR REPLACE FUNCTION public.resolve_pickup_no_show_eligibility");
  assertStringIncludes(mig, "CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot");
  assertStringIncludes(mig, "pickup_waiting_counted_seconds");
  assertStringIncludes(mig, "Bug #59");
  // Must not keep Arrived wall-clock eligibility.
  assert(
    !/v_eligible_at := v_arrived_at\s*\+\s*make_interval\(mins/.test(mig),
    "snapshot must not use Arrived wall-clock for no-show",
  );
  assertStringIncludes(mig, "resolve_pickup_no_show_eligibility(");
});

Deno.test("Bug #59 Edge tick free-wait uses scheduled floor", async () => {
  const tick = await read("functions/tick-pickup-waiting-charge/index.ts");
  assertStringIncludes(tick, "eligibleFromMsForPickupTrip");
  assertStringIncludes(tick, "Bug #59");
  assertStringIncludes(tick, "freeWaitAnchorMs");
});

Deno.test("Bug #59 stop-workflow corrects early free_wait stamp", async () => {
  const sw = await read("functions/stop-workflow/index.ts");
  assertStringIncludes(sw, "freeWaitNeedsFloorCorrection");
  assertStringIncludes(sw, "Bug #59");
});

Deno.test("Bug #59 buildPickupWaitingSnapshot keeps eligible when paused after counted", async () => {
  const { buildPickupWaitingSnapshot, buildAdminWaitingConfigSnapshot } = await import(
    "../../functions/_shared/waitingAdminConfig.ts"
  );
  const config = buildAdminWaitingConfigSnapshot(
    {
      free_waiting_minutes: 3,
      no_show_wait_time_minutes: 5,
      pickup_paid_waiting_enabled: true,
      waiting_per_minute_pence: 24,
    },
    {
      pickup_waiting_grace_period_seconds: 180,
      pickup_paid_waiting_enabled: true,
      pickup_paid_waiting_rate_pence_per_minute: 24,
      stop_waiting_charge_interval_seconds: 15,
    },
    null,
  );
  const arrived = "2026-11-20T20:26:08.000Z";
  const scheduled = "2026-11-20T20:30:00.000Z";

  // Early: freeze even with huge counted.
  const early = buildPickupWaitingSnapshot({
    driverArrivedAt: arrived,
    waitingStatus: "free_waiting",
    config,
    nowMs: Date.parse("2026-11-20T20:28:00.000Z"),
    countedInRadiusSeconds: 9999,
    scheduledAtIso: scheduled,
    isScheduledOrigin: true,
  });
  assertEquals(early.no_show_eligible, false);
  assertEquals(early.pickup_waiting_state, "awaiting_scheduled_pickup");

  // After floor + counted >= 300: eligible even when paused outside radius.
  const pausedEligible = buildPickupWaitingSnapshot({
    driverArrivedAt: arrived,
    waitingStatus: "blocked_outside_radius",
    config,
    nowMs: Date.parse("2026-11-20T20:36:00.000Z"),
    countedInRadiusSeconds: 300,
    scheduledAtIso: scheduled,
    isScheduledOrigin: true,
  });
  assertEquals(pausedEligible.no_show_eligible, true);
  assertEquals(pausedEligible.no_show_remaining_seconds, 0);

  // MK-261120-001 shape: 156s counted → not eligible (wall would have been).
  const incident = buildPickupWaitingSnapshot({
    driverArrivedAt: arrived,
    waitingStatus: "free_waiting",
    config,
    nowMs: Date.parse("2026-11-20T20:32:40.000Z"),
    countedInRadiusSeconds: 156,
    scheduledAtIso: scheduled,
    isScheduledOrigin: true,
  });
  assertEquals(incident.no_show_eligible, false);
  assertEquals(incident.no_show_remaining_seconds, 144);
});
