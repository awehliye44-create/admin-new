/**
 * Lock: Phase 1 SQL rollback pack exists and preserves payment-first by default.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO = fromFileUrl(new URL("../../..", import.meta.url));
const RB = join(REPO, "supabase/migrations/rollback");

Deno.test("rollback pack covers 120000 / 120100 / 120200", async () => {
  const a = await Deno.readTextFile(
    join(RB, "rollback_20270201120000_scheduled_finance_phase1_capture_deadline.sql"),
  );
  const b = await Deno.readTextFile(
    join(RB, "rollback_20270201120100_scheduled_finance_phase1_gap_closure.sql"),
  );
  const c = await Deno.readTextFile(
    join(RB, "rollback_20270201120200_scheduled_finance_phase1_payment_first_atomicity.sql"),
  );
  const opt = await Deno.readTextFile(
    join(RB, "rollback_20270201120200_drop_payment_first_OPTIONAL.sql"),
  );

  assert(a.includes("CREATE OR REPLACE FUNCTION public.assert_payment_gate"));
  assert(a.includes("Do NOT restore max_advance_days to 30") || a.includes("approved policy remains 5"));
  assert(a.includes("scheduled_capture_coverage_enforced = false"));
  assert(!a.includes("max_advance_days = 30"));

  assert(b.includes("accept_scheduled_ride"));
  assert(b.includes("activate_paid_corporate_trip"));
  assert(b.includes("DROP TRIGGER IF EXISTS trg_trips_enforce_scheduled_advance_window"));

  assert(c.includes("DROP FUNCTION IF EXISTS public.admin_assign_scheduled_driver"));
  assert(c.includes("trg_trips_enforce_scheduled_modification_coverage"));
  // Default 120200 rollback must NOT drop payment-first.
  assertEquals(c.includes("trips_enforce_payment_first_platform_card"), false);

  assert(opt.includes("trips_enforce_payment_first_platform_card"));
  assert(opt.includes("DANGER"));
});
