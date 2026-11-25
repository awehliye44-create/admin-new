/**
 * #89E — Automatic capture after increment must not dead-end on false local captured.
 * MK-261125-002 forensic shape: premature capture_amount + AUTHORISED provider +
 * stale CAPTURING + trip.payment_status=captured → sweep must retry.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planRevolutCompletionCapture } from "../../functions/_shared/revolutPaymentHoldSSOT.ts";
import { resolveProviderConfirmedCapturePence } from "../../functions/_shared/providerConfirmedCaptureEvidenceSSOT.ts";
import { tripHasConflictingFinalCapture } from "../../functions/_shared/revolutCaptureIdempotencySSOT.ts";
import { durableSettlementColumns } from "../../functions/finalize-trip-and-capture/lib/durableSettlementOutcomeSSOT.ts";
import { computeCaptureAmount } from "../../functions/_shared/tripFareSSOT.ts";

Deno.test("#89E normal trip without buffer plans capture_within_hold", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 880,
    authorisedHoldPence: 880,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
});

Deno.test("#89E normal trip with buffer captures fare only", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 880,
    authorisedHoldPence: 1080,
    bufferPence: 200,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 880);
  }
});

Deno.test("#89E successful increment then completion captures final payable", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 903,
    authorisedHoldPence: 903,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
});

Deno.test("#89E multiple increments then waiting still requires coverage", () => {
  const afterMod = planRevolutCompletionCapture({
    finalFarePence: 903,
    authorisedHoldPence: 880,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(afterMod.kind, "same_order_increment_required");
  const afterWaiting = planRevolutCompletionCapture({
    finalFarePence: 935,
    authorisedHoldPence: 903,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(afterWaiting.kind, "same_order_increment_required");
  if (afterWaiting.kind === "same_order_increment_required") {
    assertEquals(afterWaiting.target_total_authorised_pence, 935);
  }
});

Deno.test("#89E scheduled trip with increment uses same-order path", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 3194,
    authorisedHoldPence: 3394,
    bufferPence: 200,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 3194);
  }
});

Deno.test("#89E waiting increases final fare above authorised hold", () => {
  const capture = computeCaptureAmount({
    locked_base_fare_pence: 880,
    final_customer_fare_pence: 903,
    final_fare_pence: 935,
    pickup_waiting_charge_pence: 32,
    customer_modification_charge_pence: 23,
  }, "completed");
  assertEquals(capture.capture_amount_pence, 935);
});

Deno.test("#89E partial capture leaves residual buffer unused", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 3194,
    authorisedHoldPence: 3394,
    bufferPence: 200,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 3194);
  }
});

Deno.test("#89E full capture with no residual", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 903,
    authorisedHoldPence: 903,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
});

Deno.test("#89E premature capture_amount must not invent confirmed capture", () => {
  const confirmed = resolveProviderConfirmedCapturePence({
    providerState: "AUTHORISED",
    providerCapturedPence: null,
    sessionStatus: "trip_created",
    sessionCapturedPence: null,
    paymentCapturedPence: null,
  });
  assertEquals(confirmed, 0);
  assertEquals(
    tripHasConflictingFinalCapture({
      confirmedCapturePence: 903, // would be wrong if stamp counted
      requestedCapturePence: 935,
    }),
    true,
  );
  // With provider-confirmed evidence only, conflict is false:
  assertEquals(
    tripHasConflictingFinalCapture({
      confirmedCapturePence: confirmed,
      requestedCapturePence: 935,
    }),
    false,
  );
});

Deno.test("#89E capture completion source ignores trip stamp as sole confirmation", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertEquals(src.includes("const confirmedFinalCapturePence = storedTripCapture > 0"), false);
  assertStringIncludes(src, "resolveProviderConfirmedCapturePence");
  assertStringIncludes(src, "reclaimExpiredPaymentSessionFinancialLock");
});

Deno.test("#89E sweep retries false local captured + reclaims stale CAPTURING", async () => {
  const sweep = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertStringIncludes(sweep, '"captured"');
  assertStringIncludes(sweep, "falseLocalCaptured");
  assertStringIncludes(sweep, "reclaimExpiredPaymentSessionFinancialLock");
  assertStringIncludes(sweep, "false_local_captured_retry");
});

Deno.test("#89E lock reclaim helper exists for stale CAPTURING", async () => {
  const lock = await Deno.readTextFile(
    new URL("../../functions/_shared/paymentSessionFinancialLockSSOT.ts", import.meta.url),
  );
  assertStringIncludes(lock, "reclaimExpiredPaymentSessionFinancialLock");
  assertStringIncludes(lock, "LOCK_TTL_MS");
});

Deno.test("#89E durableSettlement still maps truthful already_captured", () => {
  const cols = durableSettlementColumns("already_captured", true);
  assertEquals(cols.payment_status, "captured");
  const busy = durableSettlementColumns("capture_busy", false);
  assertEquals(busy.payment_status, "authorized");
});

Deno.test("#89E missing TEN recovery remains wired", async () => {
  const sweep = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertStringIncludes(sweep, "sweepRecoverMissingTripEarningNet");
});

Deno.test("#90A admin capture never treats trip stamp as confirmed capture", async () => {
  const admin = await Deno.readTextFile(
    new URL(
      "../../functions/admin-capture-trip-payment/lib/adminCaptureTripPaymentSSOT.ts",
      import.meta.url,
    ),
  );
  assertEquals(admin.includes("storedTripCapture > 0 ? storedTripCapture"), false);
  assertStringIncludes(admin, "resolveProviderConfirmedCapturePence");
});
