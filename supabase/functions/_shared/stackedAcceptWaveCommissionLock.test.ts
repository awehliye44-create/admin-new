/**
 * Lock: stacked accept must persist the same accepted-offer wave snapshot as
 * accept_ride_offer (MK-260817-008 queued with null driver_net_pence → £0.00).
 *
 * Driver card SSOT is driver_net_pence (offered net), never customer fare.
 *
 * Run: deno test --allow-read supabase/functions/_shared/stackedAcceptWaveCommissionLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const stackedSqlPath = new URL(
  "../../migrations/20260927190000_stacked_accept_wave_commission_snapshot.sql",
  import.meta.url,
);
const snapshotSqlPath = new URL(
  "../../migrations/20260928150000_canonical_promotion_settlement_ssot.sql",
  import.meta.url,
);
const acceptOfferPath = new URL("../accept-offer/index.ts", import.meta.url);
const driverSnapshotSqlPath = new URL(
  "../../migrations/20260927200000_driver_snapshot_accepted_offer_stamps.sql",
  import.meta.url,
);

function promoteUpdateBlock(sql: string): string {
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.promote_stacked_trip"));
  const updateIdx = fn.indexOf("UPDATE trips\n  SET");
  const whereIdx = fn.indexOf("WHERE id = v_stacked_trip_id", updateIdx);
  return fn.slice(updateIdx, whereIdx);
}

Deno.test("accept_stacked_ride reuses snapshot_accepted_wave_commission before queueing", async () => {
  const sql = await Deno.readTextFile(stackedSqlPath);
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.accept_stacked_ride"));
  const snapshotIdx = fn.indexOf("PERFORM public.snapshot_accepted_wave_commission(v_offer.trip_id, p_offer_id)");
  const queuedIdx = fn.indexOf("status           = 'queued'");
  assertEquals(snapshotIdx > 0, true);
  assertEquals(queuedIdx > snapshotIdx, true);
  assertStringIncludes(fn, "accepted_ride_offer_id = p_offer_id");
  assertStringIncludes(fn, "assigned_at            = COALESCE(assigned_at, v_now)");
  assertStringIncludes(fn, "stacked_offer_net_missing");
  assertStringIncludes(fn, "stacked_offer_commission_missing");
  assertStringIncludes(fn, "stacked_fare_snapshot_failed::driver_net");
  assertStringIncludes(fn, "'accepted_via', 'accept_stacked_ride'");
  assertEquals(fn.includes("final_customer_fare_pence"), false);
  assertEquals(fn.includes("estimated_fare"), false);
});

Deno.test("snapshot SSOT still writes driver_net from offer effective commission", async () => {
  const sql = await Deno.readTextFile(snapshotSqlPath);
  assertStringIncludes(sql, "driver_net_pence = CASE WHEN v_commissionable > 0 THEN v_net ELSE driver_net_pence END");
  assertStringIncludes(sql, "accepted_dispatch_wave = v_offer.dispatch_wave");
  assertStringIncludes(sql, "accepted_commission_percent = v_pct");
  assertStringIncludes(sql, "'commission_source', 'accepted_wave_snapshot'");
});

Deno.test("promote_stacked_trip does not clear accepted fare or net stamps", async () => {
  const sql = await Deno.readTextFile(stackedSqlPath);
  const setBlock = promoteUpdateBlock(sql);
  assertStringIncludes(setBlock, "status                          = 'accepted'");
  assertStringIncludes(setBlock, "pickup_waiting_charge_pence     = 0");
  for (const forbidden of [
    "driver_net_pence",
    "driver_net_before_tip_pence",
    "accepted_ride_offer_id",
    "accepted_commission_percent",
    "accepted_dispatch_wave",
    "accepted_dispatch_round",
    "commission_pence",
    "final_fare_pence",
    "final_customer_fare_pence",
    "snapshot_accepted_wave_commission",
  ]) {
    assertEquals(setBlock.includes(forbidden), false, forbidden);
  }
});

Deno.test("accept-offer stacked path no longer claims fare isolation", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  assertStringIncludes(src, "snapshot_accepted_wave_commission");
  assertEquals(src.includes("fare/wallet unchanged — observability stub only"), false);
  assertStringIncludes(src, "stacked_fare_snapshot_failed");
});

Deno.test("driver snapshots pass through accepted-offer stamps, never customer fare", async () => {
  const sql = await Deno.readTextFile(driverSnapshotSqlPath);
  const active = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot"),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.get_driver_queued_trips"),
  );
  const queued = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.get_driver_queued_trips"));
  for (const fn of [active, queued]) {
    assertStringIncludes(fn, "accepted_ride_offer_id");
    assertStringIncludes(fn, "accepted_commission_percent");
    assertStringIncludes(fn, "accepted_dispatch_wave");
    assertStringIncludes(fn, "accepted_dispatch_round");
    const netIdx = fn.includes("AS driver_net_pence")
      ? fn.lastIndexOf("COALESCE(", fn.indexOf("AS driver_net_pence"))
      : fn.indexOf("'driver_net_pence', COALESCE(");
    const netBlock = fn.slice(netIdx, netIdx + 280);
    assertEquals(netBlock.includes("driver_net_pence"), true);
    assertEquals(netBlock.includes("final_fare_pence"), false, "driver_net must not use customer fare");
    assertEquals(netBlock.includes("final_customer_fare_pence"), false);
  }
});
