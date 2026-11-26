/**
 * #111 / MK-261126-001 — no-show fee stuck in PROVIDER_PENDING_RECONCILIATION.
 *
 * Production: cancel-trip logged fee=450p + outcome PROVIDER_PENDING_RECONCILIATION
 * while release-terminal-trip-hold was concurrently enqueued. Payment session stayed
 * AUTHORISED (captured_amount null); zero ledger; previous_driver_id set.
 * My Trips completed tab includes no_show via previous_driver_id but payable is
 * ledger-only until TEN exists — Wallet empty is correct until capture confirms.
 *
 * Permanent path: cancel-trip schedules a background dispose retry + settlement
 * resume when outcome is PROVIDER_PENDING_RECONCILIATION (never invent TEN).
 *
 * Run: deno test --allow-read --no-check supabase/tests/_shared/noShowPendingDisposition111Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("#111 cancel-trip retries PROVIDER_PENDING_RECONCILIATION off-request", async () => {
  const cancel = await Deno.readTextFile(
    new URL("../../functions/cancel-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(cancel, "PROVIDER_PENDING_RECONCILIATION");
  assertStringIncludes(cancel, "cancel_trip_pending_disposition_retry");
  assertStringIncludes(cancel, "scheduleEdgeBackground");
  assertStringIncludes(cancel, "cancel-trip_pending_retry");
  assertStringIncludes(cancel, "maybeResumeTerminalFeeSettlementAfterProviderFee");
  // #111A — terminal fee stamps retained on PROVIDER_FAILED so retry/sweep can settle.
  assertStringIncludes(cancel, "terminal fee stamps retained for retry");
  assertStringIncludes(cancel, "PROVIDER_FAILED");
});

Deno.test("#111A pickup-no-show settles via dispose+resume (not charge-lifecycle)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/pickup-no-show/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "disposeTerminalTripPayment");
  assertStringIncludes(src, "maybeResumeTerminalFeeSettlementAfterProviderFee");
  assertStringIncludes(src, "pickup_no_show_pending_disposition_retry");
  assertStringIncludes(src, "scheduleEdgeBackground");
  assertEquals(src.includes("functions/v1/charge-lifecycle-fee"), false);
  assertEquals(src.includes('fee_type: "no_show"'), false);
});

Deno.test("#111 sweep still candidates AUTHORISED terminal no_show holds", async () => {
  const sweep = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertStringIncludes(sweep, 'provider_state", ["AUTHORISED", "AUTHORIZED"]');
  assertStringIncludes(sweep, "PROVIDER_PENDING_RECONCILIATION");
  assertStringIncludes(sweep, "disposeTerminalTripPayment");
  assertStringIncludes(sweep, "terminal_disposition_in_progress");
});

Deno.test("#111 terminal fee capture passes sessionLockAlreadyHeld (MK-261126-001)", async () => {
  const disposition = await Deno.readTextFile(
    new URL("../../functions/_shared/terminalTripPaymentDisposition.ts", import.meta.url),
  );
  // Capture while disposition lock is held — without the flag, CLAIM_REFUSED loops forever.
  assertStringIncludes(disposition, 'purpose: "terminal_fee"');
  assertStringIncludes(disposition, "sessionLockAlreadyHeld: true");
  assertStringIncludes(disposition, "sessionLockOwner: dispositionLockOwner");
  assertStringIncludes(disposition, "terminal_disposition_pending: true");
  assertStringIncludes(disposition, "terminal_disposition_in_progress: true");

  const adminCapture = await Deno.readTextFile(
    new URL(
      "../../functions/admin-capture-trip-payment/lib/adminCaptureTripPaymentSSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(adminCapture, 'purpose: "fare"');
  assertStringIncludes(adminCapture, "sessionLockAlreadyHeld: true");
  assertStringIncludes(adminCapture, "sessionLockOwner: captureOwner");

  const guarded = await Deno.readTextFile(
    new URL("../../functions/_shared/guardedProviderCaptureSSOT.ts", import.meta.url),
  );
  // #110 P4C: bare flag refused — genuine CAPTURING/RECONCILING owner required.
  assertStringIncludes(guarded, "sessionLockAlreadyHeld without genuine lock");
  assertStringIncludes(guarded, "readPaymentSessionFinancialLock");
});
