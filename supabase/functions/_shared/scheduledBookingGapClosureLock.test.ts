/**
 * Scheduled booking gap closure lock (Gap B + Gap C).
 *
 * B: Phase 4 commitment feasibility is re-validated INSIDE accept_ride_offer /
 *    accept_scheduled_ride (SQL), not only in the Edge precheck (TOCTOU).
 * C: Scheduled marketplace listing + accept + Admin assign_now use the same
 *    driver_passes_commission_wallet_dispatch_gate as instant dispatch.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO = fromFileUrl(new URL("../../..", import.meta.url));
const MIGRATION =
  "supabase/migrations/20270218120000_scheduled_gap_closure_commitment_wallet_sql_gates.sql";

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO, rel));
}

Deno.test("Gap B: migration ports commitment feasibility into SQL and patches both accept RPCs", async () => {
  const sql = await read(MIGRATION);
  assertStringIncludes(sql, "scheduled_commitment_is_feasible");
  assertStringIncludes(sql, "scheduled_commitment_estimate_eta_minutes");
  assertStringIncludes(sql, "driver_scheduled_commitment_gate");
  assertStringIncludes(sql, "SCHEDULED_COMMITMENT_INFEASIBLE");
  // Both accept RPCs are patched.
  assertStringIncludes(sql, "pg_get_functiondef('public.accept_ride_offer(uuid,uuid,boolean)'::regprocedure)");
  assertStringIncludes(sql, "pg_get_functiondef('public.accept_scheduled_ride(uuid,uuid)'::regprocedure)");
  assertStringIncludes(sql, "'additional_work'");
  assertStringIncludes(sql, "'additional_scheduled'");
  // Race-free: same per-driver advisory key accept_scheduled_ride already uses, taken before row locks.
  assertStringIncludes(sql, "pg_advisory_xact_lock(hashtext('driver_sched_accept:' || p_driver_id::text))");
  // Same JIT config columns as the Edge SSOT — no flag flips.
  assertStringIncludes(sql, "jit_target_early_arrival_minutes");
  assert(!/jit_auto_activate_enabled\s*=\s*true/i.test(sql), "must not enable jit_auto_activate_enabled");
  assert(!/scheduled_departure_ack_enabled\s*=\s*true/i.test(sql), "must not enable scheduled_departure_ack_enabled");
  assert(
    !/UPDATE\s+public\.global_dispatch_settings/i.test(sql),
    "gap closure migration must not mutate global_dispatch_settings",
  );
});

Deno.test("Gap B: SQL math mirrors Edge feasibility constants", async () => {
  const sql = await read(MIGRATION);
  const ts = await read("supabase/functions/_shared/scheduledDispatchConfig.ts");
  assertStringIncludes(ts, "distKm * 1.45");
  assertStringIncludes(ts, "avgSpeedKmh = 20");
  assertStringIncludes(sql, "v_km * 1.45 / 20.0");
  assertStringIncludes(sql, "GREATEST(3,");
  assertStringIncludes(sql, "interval '15 minutes'");
  // Edge precheck remains (SQL is a backstop, not a replacement).
  const acceptOffer = await read("supabase/functions/accept-offer/index.ts");
  assertStringIncludes(acceptOffer, "driverMayAcceptAdditionalWork");
  const sched = await read("supabase/functions/scheduled-ride-action/index.ts");
  assertStringIncludes(sched, "driverMayTakeAdditionalScheduledBooking");
});

Deno.test("Gap C: accept_scheduled_ride SQL re-checks commission wallet gate", async () => {
  const sql = await read(MIGRATION);
  assertStringIncludes(sql, "driver_passes_commission_wallet_dispatch_gate(v_driver_id, p_trip_id)");
  assertStringIncludes(sql, "INSUFFICIENT_COMMISSION_WALLET_BALANCE");
});

Deno.test("Gap C: scheduled-ride-action gates get_available + accept with the instant wallet RPC", async () => {
  const shared = await read("supabase/functions/_shared/scheduledMarketplaceCommissionWalletGate.ts");
  assertStringIncludes(shared, "driver_passes_commission_wallet_dispatch_gate");
  assertStringIncludes(shared, "wallet_gate_error"); // fail closed on RPC error

  const src = await read("supabase/functions/scheduled-ride-action/index.ts");
  assertStringIncludes(src, 'from "../_shared/scheduledMarketplaceCommissionWalletGate.ts"');
  assertStringIncludes(src, "filterTripsByScheduledCommissionWalletGate(supabase, driver_id, filteredTrips)");
  assertStringIncludes(src, "checkScheduledCommissionWalletGate(supabase, driver_id, trip_id!)");
  assertStringIncludes(src, "SCHEDULED_COMMISSION_WALLET_ERROR");
  // Listing must map from the wallet-filtered set, not the raw filtered set.
  assertStringIncludes(src, "walletEligibleTrips.map(trip =>");
});

Deno.test("Gap C: admin assign_now uses commission wallet gate", async () => {
  const src = await read("supabase/functions/admin-scheduled-ride-action/index.ts");
  assertStringIncludes(src, 'from "../_shared/scheduledMarketplaceCommissionWalletGate.ts"');
  assertStringIncludes(src, "checkScheduledCommissionWalletGate(gate.supabase, driverId, tripId)");
});

Deno.test("Gap C: instant wallet gate is unchanged", async () => {
  const src = await read("supabase/functions/_shared/rideOfferDriverEligibility.ts");
  assertStringIncludes(src, '"driver_passes_commission_wallet_dispatch_gate"');
  assertStringIncludes(src, 'reason: "wallet_ineligible"');
});

Deno.test("Admin assign_now SQL + deferred assign_at execution share commitment lock", async () => {
  const sql = await read(
    "supabase/migrations/20270218120100_admin_assign_commitment_wallet_atomic.sql",
  );
  assertStringIncludes(sql, "admin_scheduled_emergency_mutate");
  assertStringIncludes(sql, "driver_scheduled_commitment_gate(v_driver, p_trip_id");
  assertStringIncludes(sql, "driver_passes_commission_wallet_dispatch_gate(v_driver, p_trip_id)");
  assertStringIncludes(sql, "pg_advisory_xact_lock(hashtext('driver_sched_accept:' || v_driver::text))");
  assertStringIncludes(sql, "execute_due_pending_scheduled_assign");
  assertStringIncludes(sql, "pending_cleared");

  const dispatch = await read("supabase/functions/scheduled-dispatch/index.ts");
  assertStringIncludes(dispatch, 'execute_due_pending_scheduled_assign');
  // No direct Assign At trips.update bypass after payment gate.
  assert(
    !/buildAssignNowPatch\(\{\s*driverId,\s*nowIso/.test(dispatch),
    "deferred assign must not use buildAssignNowPatch direct update",
  );
});
