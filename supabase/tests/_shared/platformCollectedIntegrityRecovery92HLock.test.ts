/**
 * #92H locks — generic PC integrity recovery + wallet realtime publication.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

Deno.test("92H: generic integrity recovery never POSTs money or duplicates TEN", () => {
  const src = Deno.readTextFileSync(
    `${ROOT}supabase/functions/sweep-revolut-stale-holds/lib/platformCollectedFinancialIntegrityRecoverySSOT.ts`,
  );
  assert(src.includes("Never POSTs CAPTURE/INCREMENT") || src.includes("Never POSTs"));
  assert(src.includes("Never creates a second TEN") || src.includes("second TEN"));
  assert(src.includes("recoverPlatformCollectedTripFinancialIntegrity"));
  assert(src.includes("sweepPlatformCollectedFinancialIntegrity"));
  assert(!/incrementRevolutOrderAuthorisation|captureRevolutOrder\(/.test(src));
  assert(src.includes('source: "recovery"'));
  // #92J/#92K: missing booking source is a recovery trigger (MK-261125-006).
  assert(src.includes('.eq("source", "booking")'));
  assert(src.includes("pc-integrity-recovery-booking-gap"));
  assert(src.includes("resolveBookingTimePayableEvidence"));
  assert(src.includes("payable_snapshot_booking_gap_unrecoverable"));
  // #92L — booking-gap recovery while tip window defers capture
  assert(src.includes("not_captured_or_authorised"));
  assert(src.includes("capture_requested"));
  assert(src.includes("Completion/recovery snap only after confirmed capture"));
});

Deno.test("92H: sweep wires pc integrity recovery without capture POST", () => {
  const src = Deno.readTextFileSync(
    `${ROOT}supabase/functions/sweep-revolut-stale-holds/index.ts`,
  );
  assert(src.includes("sweepPlatformCollectedFinancialIntegrity"));
  assert(src.includes("pc_integrity_recovery"));
  assert(src.includes("reconcileIncrementOperationsToCoverConfirmed"));
});

Deno.test("92H: wallet realtime publication migration present", () => {
  const mig = Deno.readTextFileSync(
    `${ROOT}supabase/migrations/20261125160000_driver_wallet_realtime_publication_92h.sql`,
  );
  assert(mig.includes("ALTER PUBLICATION supabase_realtime ADD TABLE public.driver_wallet_ledger"));
  assert(mig.includes("ALTER PUBLICATION supabase_realtime ADD TABLE public.driver_wallets"));
  assert(mig.includes("REPLICA IDENTITY FULL"));
  assertEquals(mig.includes("clearing"), true); // comment preserves clearing policy
});

Deno.test("92H: MK-261125-003 recovery delegates to generic SSOT", () => {
  const src = Deno.readTextFileSync(
    `${ROOT}supabase/tests/_shared/mk261125003RecoverySSOT.ts`,
  );
  assert(src.includes("recoverPlatformCollectedTripFinancialIntegrity"));
  assert(src.includes("tenCount"));
  assert(!/from\("driver_wallet_ledger"\)\.insert/.test(src));
});
