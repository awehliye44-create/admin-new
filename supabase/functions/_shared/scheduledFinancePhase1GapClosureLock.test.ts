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

Deno.test("Admin Assign Now calls assert_payment_gate before write", async () => {
  const src = await Deno.readTextFile(join(REPO, "src/pages/ScheduledRides.tsx"));
  assert(src.includes("assert_payment_gate"));
  assert(src.includes("Cannot assign — payment authorisation"));
});
