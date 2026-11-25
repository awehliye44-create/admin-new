/**
 * #92G lock — payable snapshot writers must be statically imported into Edge
 * bundles. Dynamic import("./writeAuthoritativePayableSnapshotSSOT.ts") was
 * omitted from production ESZIP (MK-261125-003 → zero payment_payable_snapshots).
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

const MUST_STATIC = [
  "supabase/functions/_shared/revolutCompletionCapture.ts",
  "supabase/functions/accept-offer/index.ts",
  "supabase/functions/create-trip-after-payment/lib/bookingPostCommit.ts",
  "supabase/functions/_shared/executeFareIncreaseModificationPayment.ts",
  "supabase/functions/customer-fare-decision/index.ts",
  "supabase/functions/driver-fare-final/index.ts",
  "supabase/functions/admin-trip-action/index.ts",
  "supabase/functions/admin-capture-trip-payment/lib/adminCaptureTripPaymentSSOT.ts",
];

Deno.test("92G: no dynamic import of writeAuthoritativePayableSnapshotSSOT", () => {
  for (const rel of MUST_STATIC) {
    const src = Deno.readTextFileSync(`${ROOT}${rel}`);
    assert(
      !/import\(\s*["'][^"']*writeAuthoritativePayableSnapshotSSOT/.test(src),
      `${rel} still dynamically imports writeAuthoritativePayableSnapshotSSOT`,
    );
  }
});

Deno.test("92G: capture + booking paths use writePayableSnapshotOrLog static helper", () => {
  const capture = Deno.readTextFileSync(
    `${ROOT}supabase/functions/_shared/revolutCompletionCapture.ts`,
  );
  const booking = Deno.readTextFileSync(
    `${ROOT}supabase/functions/create-trip-after-payment/lib/bookingPostCommit.ts`,
  );
  assert(capture.includes('from "./writePayableSnapshotOrLogSSOT.ts"'));
  assert(capture.includes("writePayableSnapshotOrLog("));
  assert(booking.includes("writePayableSnapshotOrLog"));
  assert(capture.includes("buildTripPaymentProjectionAfterCapture"));
  assert(capture.includes("payment_coverage_status"));
  assert(capture.includes("terminalizeAbandonedTripChangeRequests"));
  assert(capture.includes("reconcileIncrementOperationsToCoverConfirmed"));
});

Deno.test("92G: increment confirm flips financial op to COVER_CONFIRMED", () => {
  const src = Deno.readTextFileSync(
    `${ROOT}supabase/functions/_shared/executeSameOrderIncrementSSOT.ts`,
  );
  assert(src.includes('state: "COVER_CONFIRMED"'));
  assert(src.includes("completeFinancialOperationFromProvider"));
  // POST-time UNKNOWN must not be the final state after retrieve confirm.
  const confirmIdx = src.indexOf("increment_provider_confirmed");
  assert(confirmIdx > 0);
  const after = src.slice(confirmIdx, confirmIdx + 800);
  assert(after.includes("COVER_CONFIRMED"));
});

Deno.test("92G: evidence reconcile + TCR terminalize modules exist", () => {
  const ops = Deno.readTextFileSync(
    `${ROOT}supabase/functions/_shared/reconcileFinancialOperationFromEvidenceSSOT.ts`,
  );
  const tcr = Deno.readTextFileSync(
    `${ROOT}supabase/functions/_shared/terminalizeAbandonedModificationSSOT.ts`,
  );
  assert(ops.includes("reconcileIncrementOperationsToCoverConfirmed"));
  assert(ops.includes("Never POSTs"));
  assert(tcr.includes("abandoned_unapplied_at_trip_completion"));
  assert(tcr.includes('status: "expired"'));
  assertEquals(true, true);
});
