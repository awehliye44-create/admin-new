/**
 * #92 behavioural / failure-injection locks (mocked concurrent + classification).
 * No live Revolut. DB uniqueness behaviour is simulated against the logical-key rules.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildLogicalIdempotencyKey,
  decideProviderPostSafety,
} from "../../functions/_shared/paymentFinancialOperationSSOT.ts";
import { classifyCaptureConfirmation } from "../../functions/admin-payment-sessions/lib/captureConfirmationClassificationSSOT.ts";
import {
  buildPayableFareSnapshot,
  forceCompletePayableSnapshot,
} from "../../functions/_shared/payableFareSnapshotSSOT.ts";
import { evaluateAuthorisationCoverage } from "./financialCoverageSSOT.ts";

/** Simulate DB unique active logical key + inflight POST. */
function simulateConcurrentClaims(args: {
  firstInflight: boolean;
  firstState: string;
  secondLogicalSame: boolean;
}): { first: string; second: string } {
  const key = buildLogicalIdempotencyKey({
    opType: "CAPTURE",
    paymentSessionId: "ps1",
    providerOrderId: "ord1",
    targetAmountPence: 900,
    payableSnapshotVersion: 1,
  });
  const first = decideProviderPostSafety({
    priorOp: null,
    requestedLogicalKey: key,
  });
  assertEquals(first.action, "allow_post");
  const second = decideProviderPostSafety({
    priorOp: {
      state: args.firstState,
      provider_post_inflight: args.firstInflight,
      logical_idempotency_key: args.secondLogicalSame ? key : key + ":other",
    },
    requestedLogicalKey: key,
    leaseExpired: true,
  });
  return { first: first.action, second: second.action };
}

Deno.test("#92 concurrent same logical capture: second is reconcile_only while inflight", () => {
  const r = simulateConcurrentClaims({
    firstInflight: true,
    firstState: "CAPTURE_PENDING",
    secondLogicalSame: true,
  });
  assertEquals(r.second, "reconcile_only");
});

Deno.test("#92 expired lease with inflight never allows new POST", () => {
  const key = buildLogicalIdempotencyKey({
    opType: "INCREMENT",
    paymentSessionId: "ps",
    providerOrderId: "o",
    targetAmountPence: 935,
    payableSnapshotVersion: 2,
  });
  const safety = decideProviderPostSafety({
    priorOp: {
      state: "INCREMENT_PENDING",
      provider_post_inflight: true,
      logical_idempotency_key: key,
      lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
    },
    requestedLogicalKey: key,
    leaseExpired: true,
  });
  assertEquals(safety.action, "reconcile_only");
});

Deno.test("#92 one-penny shortfall / overcapture / zero-payable", () => {
  assertEquals(
    classifyCaptureConfirmation({ payablePence: 100, confirmedCapturedPence: 99 }).class,
    "PARTIALLY_CAPTURED",
  );
  assertEquals(
    classifyCaptureConfirmation({ payablePence: 100, confirmedCapturedPence: 101 }).class,
    "OVERCAPTURE_ANOMALY",
  );
  assertEquals(
    classifyCaptureConfirmation({ payablePence: 0, confirmedCapturedPence: 0 }).class,
    "NO_PAYMENT_REQUIRED",
  );
});

Deno.test("#92 waiting counted once across mod + completion composition", () => {
  const snap = buildPayableFareSnapshot({
    source: "completion",
    grossFarePence: 880,
    modificationPence: 23,
    waitingPence: 32,
    tipPence: 0,
    receivablesPence: 0,
  });
  assertEquals(snap.waiting_pence, 32);
  assertEquals(snap.total_payable_pence, 935);
  const cov = evaluateAuthorisationCoverage({
    snapshot: snap,
    providerConfirmedAuthorisedPence: 903,
    providerAuthKnown: true,
  });
  assertEquals(cov.shortfallPence, 32);
});

Deno.test("#92 force_complete preserves waiting evidence in snapshot composition", () => {
  const snap = forceCompletePayableSnapshot({
    adminFarePence: 1000,
    pickupWaitingPence: 40,
    stopWaitingPence: 10,
    adminFareIncludesWaiting: true,
  });
  assertEquals(snap.waiting_basis, "included_in_fare");
  assertEquals(snap.waiting_pence, 0);
  assertEquals(snap.total_payable_pence, 1000);
});

Deno.test("#92 COUNTER still must not pre-authorise (source)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/customer-fare-decision/index.ts", import.meta.url),
  );
  const idx = src.indexOf("CUSTOMER_SEND_COUNTER");
  const before = src.slice(idx - 600, idx);
  assertEquals(before.includes("ensureNegotiationPayableAuthorised"), false);
});

Deno.test("#92 Policy A: partial still settlement-eligible; overcapture is not", () => {
  const partial = classifyCaptureConfirmation({
    payablePence: 1000,
    confirmedCapturedPence: 700,
  });
  assertEquals(partial.settlementEligibleForPolicyA, true);
  const over = classifyCaptureConfirmation({
    payablePence: 1000,
    confirmedCapturedPence: 1100,
  });
  assertEquals(over.settlementEligibleForPolicyA, false);
});

Deno.test("#91/#91A contracts preserved in increment orchestrator", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  assert(src.includes("targetTotalAuthorisedPence"));
  assert(src.includes("AUTHORISATION_RECONCILIATION_PENDING"));
  assert(src.includes("claimFinancialOperationForPost"));
  // Must not redesign amount as delta.
  assertEquals(src.includes("targetTotalAuthorisedPence: plan.deltaPence"), false);
});

Deno.test("#92B Edge rollback refused while inflight / unresolved", async () => {
  const {
    decideEdgeRollbackSafety,
    decideStageDEnablement,
    assertProviderCaptureEvidenceBinding,
  } = await import("./offline/paymentSsotQuiescenceSSOT.ts");

  assertEquals(
    decideEdgeRollbackSafety({
      inflight_count: 1,
      unresolved_count: 1,
      sample_execution_ids: ["CAPTURE:t:1"],
    }).ok,
    false,
  );
  assertEquals(
    decideEdgeRollbackSafety({
      inflight_count: 0,
      unresolved_count: 0,
      sample_execution_ids: [],
    }).ok,
    true,
  );
  assertEquals(
    decideStageDEnablement({
      allWorkersFenceAware: false,
      inflight: { inflight_count: 0, unresolved_count: 0, sample_execution_ids: [] },
    }).ok,
    false,
  );
  assertEquals(
    decideStageDEnablement({
      allWorkersFenceAware: true,
      inflight: { inflight_count: 0, unresolved_count: 0, sample_execution_ids: [] },
    }).ok,
    true,
  );

  const bound = assertProviderCaptureEvidenceBinding({
    claimedProviderOrderId: "ord-1",
    retrievedOrderId: "ord-1",
    claimedPaymentSessionId: "ps-1",
    claimedCurrency: "GBP",
    retrievedCurrency: "GBP",
    requestedAmountPence: 1000,
    confirmedAmountPence: 1000,
    providerTerminal: true,
  });
  assertEquals(bound.ok, true);

  const mismatch = assertProviderCaptureEvidenceBinding({
    claimedProviderOrderId: "ord-1",
    retrievedOrderId: "ord-2",
    claimedPaymentSessionId: "ps-1",
    claimedCurrency: "GBP",
    requestedAmountPence: 1000,
    confirmedAmountPence: 1000,
    providerTerminal: true,
  });
  assertEquals(mismatch.ok, false);

  // Never confirm from requested alone when provider not terminal / no amount.
  const httpOnly = assertProviderCaptureEvidenceBinding({
    claimedProviderOrderId: "ord-1",
    retrievedOrderId: "ord-1",
    claimedPaymentSessionId: "ps-1",
    claimedCurrency: "GBP",
    requestedAmountPence: 1000,
    confirmedAmountPence: null,
    providerTerminal: false,
  });
  assertEquals(httpOnly.ok, false);
});

Deno.test("#92B guarded capture takes session CAPTURING lock (mixed-version)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/guardedProviderCaptureSSOT.ts", import.meta.url),
  );
  assert(src.includes("claimPaymentSessionFinancialLock"));
  assert(src.includes("assertProviderCaptureEvidenceBinding"));
  assert(src.includes("STALE_PAYABLE"));
  assert(src.includes("sessionLockAlreadyHeld"));
});

Deno.test("#92B fare vs fee purposes use distinct logical keys", () => {
  const fare = buildLogicalIdempotencyKey({
    opType: "CAPTURE",
    paymentSessionId: "ps1",
    providerOrderId: "ord1",
    targetAmountPence: 500,
    payableSnapshotVersion: 1,
    purpose: "fare",
  });
  const fee = buildLogicalIdempotencyKey({
    opType: "CAPTURE",
    paymentSessionId: "ps1",
    providerOrderId: "ord1",
    targetAmountPence: 500,
    payableSnapshotVersion: 1,
    purpose: "terminal_fee",
  });
  assert(fare !== fee);
});

Deno.test("#92B booking snapshot retries + completion rewrite recovery (source)", async () => {
  const booking = await Deno.readTextFile(
    new URL(
      "../../functions/create-trip-after-payment/lib/bookingPostCommit.ts",
      import.meta.url,
    ),
  );
  assert(booking.includes("payable_snapshot_booking_soft_fail"));
  assert(booking.includes("completion_or_admin_capture_rewrites_before_post"));
  // #92J: sync after-insert + paymentSessionId on booking writes.
  assert(booking.includes("persistBookingPayableSnapshotAfterInsert"));
  assert(booking.includes("paymentSessionId"));
  const ctap = await Deno.readTextFile(
    new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url),
  );
  assert(ctap.includes("persistBookingPayableSnapshotAfterInsert"));
  const completion = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assert(completion.includes('source: "completion"'));
  // #92G/#92H: static wrapper required — dynamic writeAuthoritativePayableSnapshot
  // was omitted from Edge ESZIP (MK-261125-003).
  assert(
    completion.includes("writePayableSnapshotOrLog")
      || completion.includes("writeAuthoritativePayableSnapshot"),
  );
});
