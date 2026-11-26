/**
 * Bug #100 — Highest-version get_driver_active_trip_snapshot must keep Bug #59
 * no-show SSOT + waiting evidence fields (never Arrived wall-clock alone).
 *
 * Run: deno test --allow-read supabase/tests/_shared/bug100DriverSnapshotWaitingSsotLock.test.ts
 */
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migDir = new URL("../../migrations/", import.meta.url);

async function highestSnapshotMigration(): Promise<{ name: string; body: string }> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(migDir)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    names.push(entry.name);
  }
  names.sort();
  let best: { name: string; body: string } | null = null;
  for (const name of names) {
    const body = await Deno.readTextFile(new URL(name, migDir));
    if (!body.includes("CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot")) {
      continue;
    }
    best = { name, body };
  }
  if (!best) throw new Error("no get_driver_active_trip_snapshot migration found");
  return best;
}

Deno.test("Bug #100 highest snapshot migration restores waiting SSOT", async () => {
  const { name, body } = await highestSnapshotMigration();
  assert(
    name >= "20270301220000",
    `expected #100 migration as highest snapshot def, got ${name}`,
  );
  assertStringIncludes(body, "resolve_pickup_no_show_eligibility(");
  assertStringIncludes(body, "pickup_waiting_counted_seconds");
  assertStringIncludes(body, "waiting_geofence_status");
  assertStringIncludes(body, "waiting_geofence_checked_at");
  assertStringIncludes(body, "scheduled_at");
  assertStringIncludes(body, "eligible_waiting_from_at");
  assertStringIncludes(body, "is_driver_active_trip_snapshot_row_eligible");
  assert(
    !/v_eligible_at := v_arrived_at\s*\+\s*make_interval\(mins/.test(body),
    "must not use Arrived wall-clock for no-show",
  );
});

Deno.test("Bug #100 tick exposes checked_at and server_now", async () => {
  const tick = await Deno.readTextFile(
    new URL("../../functions/tick-pickup-waiting-charge/index.ts", import.meta.url),
  );
  assertStringIncludes(tick, "waiting_geofence_checked_at");
  assertStringIncludes(tick, "server_now");
  assertStringIncludes(tick, "free_waiting_seconds");
  assertStringIncludes(tick, "clockFields");
});

Deno.test("#100A tick checked_at is evaluation nowIso not pre-sync trip stamp", async () => {
  const tick = await Deno.readTextFile(
    new URL("../../functions/tick-pickup-waiting-charge/index.ts", import.meta.url),
  );
  assertStringIncludes(tick, "#100A");
  assertStringIncludes(tick, "waiting_geofence_checked_at: nowIso");
  assert(
    !/waiting_geofence_checked_at:\s*\n?\s*\(trip as/.test(tick),
    "must not read pre-sync trip.waiting_geofence_checked_at into clockFields",
  );
  // Chargeable final response must include the same clock anchors.
  const chargeableIdx = tick.lastIndexOf("pickup_waiting_charge_pence");
  const clockOnChargeable = tick.indexOf("...clockFields", chargeableIdx);
  assert(
    clockOnChargeable > chargeableIdx,
    "final chargeable tick response must spread clockFields",
  );
});
