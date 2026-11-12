/**
 * Phase 1 gap-closure locks — payment-first create vs legacy latch.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO = fromFileUrl(new URL("../../..", import.meta.url));

Deno.test("CTAP always runs ensureScheduledCaptureCoverage for scheduled card (not latch-gated)", async () => {
  const ctap = await Deno.readTextFile(
    join(REPO, "supabase/functions/create-trip-after-payment/index.ts"),
  );
  assert(ctap.includes("ensureScheduledCaptureCoverage"));
  assert(ctap.includes("scheduled_capture_coverage_required"));
  assert(ctap.includes("capture_deadline_coverage"));
  assert(!ctap.includes("scheduled_capture_coverage_enforced"));
});

Deno.test("assert_payment_gate gap migration requires coverage for stamped new sessions", async () => {
  const sql = await Deno.readTextFile(
    join(REPO, "supabase/migrations/20270201120100_scheduled_finance_phase1_gap_closure.sql"),
  );
  assert(sql.includes("scheduled_capture_coverage_required"));
  assert(sql.includes("trips_enforce_scheduled_advance_window"));
  assert(sql.includes("PERFORM public.assert_payment_gate(p_trip_id)"));
  assert(sql.includes("accept_scheduled_ride"));
  assert(sql.includes("activate_paid_corporate_trip"));
  assert(sql.includes("CAPTURE_DEADLINE_MISSING"));
});

Deno.test("scheduled-dispatch sweeps payment_gate_blocked and gates assign/broadcast/activation", async () => {
  const src = await Deno.readTextFile(
    join(REPO, "supabase/functions/scheduled-dispatch/index.ts"),
  );
  assertEquals(src.includes("payment_gate_blocked sweep"), true);
  assertEquals(src.includes("resolvePaymentGateBlockedTrip"), true);
  const gateCount = (src.match(/assertPaymentGate\(/g) ?? []).length;
  assert(gateCount >= 3);
});

Deno.test("Admin Assign Now uses atomic admin_assign_scheduled_driver RPC", async () => {
  // Phase 3: UI → Edge → admin_scheduled_emergency_mutate (assign_now + audit one txn).
  // Payment-first assign RPC remains for direct/JWT callers; emergency path is atomic mutate.
  const src = await Deno.readTextFile(join(REPO, "src/pages/ScheduledRides.tsx"));
  assert(src.includes("assign_now") || src.includes("admin_assign_scheduled_driver"));
  assert(src.includes("Cannot assign — payment authorisation"));
  assert(!src.includes("assert_payment_gate"));
  const edge = await Deno.readTextFile(
    join(REPO, "supabase/functions/admin-scheduled-ride-action/index.ts"),
  );
  assert(edge.includes("admin_scheduled_emergency_mutate"));
  assert(edge.includes("assign_now"));
  const sql = await Deno.readTextFile(
    join(REPO, "supabase/migrations/20270201120200_scheduled_finance_phase1_payment_first_atomicity.sql"),
  );
  assert(sql.includes("admin_assign_scheduled_driver"));
  assert(sql.includes("assert_payment_gate"));
  assert(sql.includes("trips_enforce_payment_first_platform_card"));
  assert(sql.includes("trips_enforce_scheduled_modification_coverage"));
  const atomic = await Deno.readTextFile(
    join(REPO, "supabase/migrations/20270213140000_scheduled_marketplace_emergency_mutate_atomic.sql"),
  );
  assert(atomic.includes("assign_now"));
  assert(atomic.includes("assert_payment_gate"));
  assert(atomic.includes("INSERT INTO public.audit_logs"));
});
