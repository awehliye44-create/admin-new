/**
 * Lock: tip-capture failure must never be classified as fare payment_shortfall
 * by failed_terminal / applyCompleteTripCaptureOutcome handling.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/captureOutcomeTipVsShortfallLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isFareDurableRecoveryStatus,
  isFarePaymentShortfallStatus,
  isTipCaptureOutcomeStatus,
} from "../../functions/_shared/captureOutcomeClassificationSSOT.ts";
import { durableSettlementColumns } from "../../functions/_shared/durableSettlementOutcomeSSOT.ts";
import { resolveTrustedCaptureTipPence } from "../../functions/_shared/resolveTrustedCaptureTipPence.ts";

Deno.test("tip statuses are tip outcomes, never fare shortfall classifiers", () => {
  for (const status of [
    "tip_authorisation_declined",
    "TIP_AUTHORISATION_DECLINED",
    "tip_window_open",
    "tip_shortfall",
    "tip_not_collected",
    "tip_recovery_required",
  ]) {
    assertEquals(isTipCaptureOutcomeStatus(status), true, status);
    assertEquals(isFareDurableRecoveryStatus(status), false, status);
    assertEquals(isFarePaymentShortfallStatus(status), false, status);
  }
});

Deno.test("fare shortfall / partial / recovery still classify as fare durable recovery", () => {
  for (const status of [
    "payment_shortfall",
    "PARTIAL_CAPTURE_ONLY",
    "PAYMENT_RECOVERY_REQUIRED",
    "ADDITIONAL_AUTHORISATION_REQUIRED",
  ]) {
    assertEquals(isTipCaptureOutcomeStatus(status), false, status);
    assertEquals(isFareDurableRecoveryStatus(status), true, status);
  }
  assertEquals(isFarePaymentShortfallStatus("payment_shortfall"), true);
  assertEquals(isFarePaymentShortfallStatus("PARTIAL_CAPTURE_ONLY"), true);
  assertEquals(isFarePaymentShortfallStatus("ADDITIONAL_AUTHORISATION_REQUIRED"), false);
});

Deno.test("durableSettlementColumns keeps tip decline authorized — not payment_shortfall", () => {
  const tipDecline = durableSettlementColumns("tip_authorisation_declined", false);
  assertEquals(tipDecline.payment_status, "authorized");
  assertEquals(tipDecline.payment_hold_status, "tip_authorisation_declined");

  const tipShortfallLabel = durableSettlementColumns("tip_shortfall", false);
  assertEquals(tipShortfallLabel.payment_status !== "payment_shortfall", true);

  const fareShortfall = durableSettlementColumns("payment_shortfall", false);
  assertEquals(fareShortfall.payment_status, "payment_shortfall");
});

Deno.test("trip-capture-job trusted tip is always fare-only (0)", () => {
  assertEquals(
    resolveTrustedCaptureTipPence({
      source: "trip-capture-job",
      bodyTipPence: 500,
      trip: { tip_amount_pence: 250, tip_pence: 250 },
    }),
    0,
  );
  // Tip submit still trusts body.
  assertEquals(
    resolveTrustedCaptureTipPence({
      source: "submit_customer_trip_tip",
      bodyTipPence: 250,
      trip: { tip_amount_pence: 0 },
    }),
    250,
  );
});

Deno.test("applyCompleteTripCaptureOutcome + job SSOT wire tip vs fare separation", async () => {
  const outcome = await Deno.readTextFile(
    new URL("../../functions/_shared/applyCompleteTripCaptureOutcome.ts", import.meta.url),
  );
  assertStringIncludes(outcome, "isTipCaptureOutcomeStatus");
  assertStringIncludes(outcome, "isFareDurableRecoveryStatus");
  assertStringIncludes(outcome, "isFarePaymentShortfallStatus");
  assertStringIncludes(outcome, 'applied: "tip_outcome"');
  assertStringIncludes(outcome, "durableSettlementColumns");
  // Must not use naive includes('shortfall') without tip exclusion.
  assertEquals(outcome.includes("isDurableRecoveryStatus"), false);

  const job = await Deno.readTextFile(
    new URL("../../functions/_shared/tripCaptureJobSSOT.ts", import.meta.url),
  );
  assertStringIncludes(job, "isTipCaptureOutcomeStatus");
  assertStringIncludes(job, "isFareDurableRecoveryStatus");
  assertStringIncludes(job, 'applied === "tip_outcome"');
  assertStringIncludes(job, "tip_outcome_retry");
  assertStringIncludes(job, "tip_capture_failed");
  // Fare shortfall terminal path must use fare classifier only.
  assertStringIncludes(job, "isFareDurableRecoveryStatus(bodyStatus)");
  assertEquals(job.includes("bodyStatus.includes(\"shortfall\")"), false);
});
