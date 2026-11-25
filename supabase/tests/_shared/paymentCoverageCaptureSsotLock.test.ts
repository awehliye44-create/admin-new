/**
 * Permanent Payment Coverage & Capture SSOT — P0–P3 lock tests.
 * Exact pence, COUNTER no pre-cover, POST safety, force_complete waiting once.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyCaptureConfirmation,
  captureConfirmationStateFromClass,
  isAmbiguousProviderFinancialOutcome,
  isBoundProviderCaptureEvidence,
} from "../../functions/_shared/captureConfirmationClassificationSSOT.ts";
import {
  buildPayableFareSnapshot,
  forceCompletePayableSnapshot,
  requiredAuthorisedTotalFromSnapshot,
} from "../../functions/_shared/payableFareSnapshotSSOT.ts";
import {
  evaluateAuthorisationCoverage,
  sameOrderIncrementTargetPence,
} from "../../functions/_shared/financialCoverageSSOT.ts";
import {
  assertModernFinancialWriter,
  buildExecutionId,
  buildLogicalIdempotencyKey,
  decideProviderPostSafety,
} from "../../functions/_shared/paymentFinancialOperationSSOT.ts";
import { resolveAdminPaymentFinancialVisibility } from "../../functions/_shared/adminPaymentFinancialVisibilitySSOT.ts";
import { sanitiseFinancialEventDetail } from "../../functions/_shared/paymentFinancialDiagnosticsSSOT.ts";
import {
  isFareCapturedBlockingTipWindow,
  storedCaptureAllowsTipWindowClose,
} from "../../functions/_shared/tripPaymentFinalised.ts";

Deno.test("exact FULLY_CAPTURED: confirmed === payable (no 1p tolerance)", () => {
  const full = classifyCaptureConfirmation({ payablePence: 935, confirmedCapturedPence: 935 });
  assertEquals(full.class, "FULLY_CAPTURED");
  assertEquals(full.outstandingPence, 0);

  const short = classifyCaptureConfirmation({ payablePence: 935, confirmedCapturedPence: 934 });
  assertEquals(short.class, "PARTIALLY_CAPTURED");
  assertEquals(short.outstandingPence, 1);

  const over = classifyCaptureConfirmation({ payablePence: 935, confirmedCapturedPence: 936 });
  assertEquals(over.class, "OVERCAPTURE_ANOMALY");
  assertEquals(over.overcapturePence, 1);
  assertEquals(over.settlementEligibleForPolicyA, false);
});

Deno.test("zero-payable uses NO_PAYMENT_REQUIRED", () => {
  const z = classifyCaptureConfirmation({ payablePence: 0, confirmedCapturedPence: 0 });
  assertEquals(z.class, "NO_PAYMENT_REQUIRED");
});

Deno.test("one-penny shortfall is PARTIALLY_CAPTURED not full", () => {
  const c = classifyCaptureConfirmation({ payablePence: 500, confirmedCapturedPence: 499 });
  assertEquals(c.isFullyCaptured, false);
  assertEquals(c.isPartiallyCaptured, true);
  assertEquals(captureConfirmationStateFromClass(c.class), "PARTIALLY_CAPTURED");
});

Deno.test("ambiguous provider outcomes never prove failure", () => {
  assert(isAmbiguousProviderFinancialOutcome({ providerState: "AUTHORISED" }));
  assert(isAmbiguousProviderFinancialOutcome({ providerState: "PROCESSING" }));
  assert(isAmbiguousProviderFinancialOutcome({ timedOut: true }));
  assert(isAmbiguousProviderFinancialOutcome({ httpStatus: 503 }));
  assertEquals(
    isAmbiguousProviderFinancialOutcome({ providerState: "COMPLETED" }),
    false,
  );
});

Deno.test("bound provider evidence requires GET + COMPLETED + amount", () => {
  assertEquals(
    isBoundProviderCaptureEvidence({
      paymentSessionId: "s1",
      providerOrderId: "o1",
      providerState: "COMPLETED",
      confirmedCapturedPence: 100,
      amountFromProviderGet: true,
    }),
    true,
  );
  assertEquals(
    isBoundProviderCaptureEvidence({
      paymentSessionId: "s1",
      providerOrderId: "o1",
      providerState: "COMPLETED",
      confirmedCapturedPence: 100,
      amountFromProviderGet: false,
    }),
    false,
  );
  assertEquals(
    isBoundProviderCaptureEvidence({
      paymentSessionId: "s1",
      providerOrderId: "o1",
      providerState: "AUTHORISED",
      confirmedCapturedPence: 100,
      amountFromProviderGet: true,
    }),
    false,
  );
});

Deno.test("payable snapshot composition-before-cover includes waiting tip receivables once", () => {
  const snap = buildPayableFareSnapshot({
    source: "completion",
    grossFarePence: 880,
    modificationPence: 23,
    waitingPence: 32,
    tipPence: 0,
    receivablesPence: 100,
    discountPence: 0,
  });
  assertEquals(snap.total_payable_pence, 880 + 23 + 32 + 100);
  assertEquals(requiredAuthorisedTotalFromSnapshot(snap), snap.total_payable_pence);

  const cov = evaluateAuthorisationCoverage({
    snapshot: snap,
    providerConfirmedAuthorisedPence: 903,
    providerAuthKnown: true,
  });
  assertEquals(cov.shortfallPence, 132);
  assertEquals(sameOrderIncrementTargetPence(cov), snap.total_payable_pence);
});

Deno.test("G-FC force_complete waiting_basis included_in_fare does not re-add waiting", () => {
  const snap = forceCompletePayableSnapshot({
    adminFarePence: 1000,
    pickupWaitingPence: 50,
    stopWaitingPence: 25,
    adminFareIncludesWaiting: true,
  });
  assertEquals(snap.waiting_basis, "included_in_fare");
  assertEquals(snap.waiting_pence, 0);
  assertEquals(snap.total_payable_pence, 1000);
});

Deno.test("POST safety: inflight / unresolved → reconcile_only; lease alone never allows POST", () => {
  const key = buildLogicalIdempotencyKey({
    opType: "CAPTURE",
    paymentSessionId: "ps",
    providerOrderId: "ord",
    targetAmountPence: 900,
    payableSnapshotVersion: 1,
  });
  const inflight = decideProviderPostSafety({
    priorOp: {
      state: "CAPTURE_PENDING",
      provider_post_inflight: true,
      logical_idempotency_key: key,
    },
    requestedLogicalKey: key,
    leaseExpired: true,
  });
  assertEquals(inflight.action, "reconcile_only");

  const unknown = decideProviderPostSafety({
    priorOp: {
      state: "CAPTURE_UNKNOWN",
      provider_post_inflight: false,
      logical_idempotency_key: key,
    },
    requestedLogicalKey: key,
  });
  assertEquals(unknown.action, "reconcile_only");

  const fresh = decideProviderPostSafety({
    priorOp: null,
    requestedLogicalKey: key,
  });
  assertEquals(fresh.action, "allow_post");
});

Deno.test("logical keys differ by snapshot version / epoch after decrease revisit", () => {
  const a = buildLogicalIdempotencyKey({
    opType: "INCREMENT",
    paymentSessionId: "ps",
    providerOrderId: "ord",
    targetAmountPence: 900,
    payableSnapshotVersion: 1,
    epoch: 0,
  });
  const b = buildLogicalIdempotencyKey({
    opType: "INCREMENT",
    paymentSessionId: "ps",
    providerOrderId: "ord",
    targetAmountPence: 900,
    payableSnapshotVersion: 2,
    epoch: 1,
  });
  assert(a !== b);
  assert(buildExecutionId({ opType: "CAPTURE", tripId: "t1", ulid: "u1" }).startsWith("CAPTURE:"));
});

Deno.test("legacy writer without fence/execution is blocked", () => {
  assertEquals(
    assertModernFinancialWriter({ schemaAware: false, executionId: "x", fence: "f" }).ok,
    false,
  );
  assertEquals(
    assertModernFinancialWriter({ schemaAware: true, executionId: null, fence: "f" }).ok,
    false,
  );
  assertEquals(
    assertModernFinancialWriter({ schemaAware: true, executionId: "e", fence: "f" }).ok,
    true,
  );
});

Deno.test("diagnostics strip secrets", () => {
  const clean = sanitiseFinancialEventDetail({
    amount: 100,
    token: "sekrit",
    pan: "4111111111111111",
    state: "COMPLETED",
  });
  assertEquals(clean.token, undefined);
  assertEquals(clean.pan, undefined);
  assertEquals(clean.amount, 100);
});

Deno.test("admin visibility: partial is not fully paid", () => {
  const vis = resolveAdminPaymentFinancialVisibility({
    payablePence: 1000,
    captureRequestedPence: 1000,
    captureConfirmedPence: 700,
    refundedPence: 0,
  });
  assertEquals(vis.fully_captured, false);
  assertEquals(vis.partially_captured, true);
  assertEquals(vis.outstanding_pence, 300);
});

Deno.test("tip-window readers require captureConfirmedPence (G4 no legacy stamp)", () => {
  assertEquals(
    isFareCapturedBlockingTipWindow({
      paymentStatus: "authorized",
      captureAmountPence: 500,
    }),
    false,
  );
  assertEquals(
    isFareCapturedBlockingTipWindow({
      paymentStatus: "authorized",
      captureAmountPence: 500,
      captureConfirmedPence: 0,
    }),
    false,
  );
  assertEquals(
    storedCaptureAllowsTipWindowClose({
      paymentStatus: "captured",
      captureAmountPence: 500,
    }),
    false,
  );
  assertEquals(
    storedCaptureAllowsTipWindowClose({
      paymentStatus: "captured",
      captureConfirmedPence: 500,
    }),
    true,
  );
});

Deno.test("#92 increment hub claims financial op before POST (source lock)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  assert(src.includes("claimFinancialOperationForPost"));
  assert(src.includes("markFinancialOperationPostDispatched"));
  assert(src.indexOf("claimFinancialOperationForPost") < src.indexOf("incrementRevolutOrderAuthorisation({"));
});

Deno.test("#92 capture POSTs go through guardedCaptureRevolutOrder (source lock)", async () => {
  const completion = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assert(completion.includes("guardedCaptureRevolutOrder"));
  assertEquals(completion.includes("await captureRevolutOrder("), false);
  const admin = await Deno.readTextFile(
    new URL(
      "../../functions/admin-capture-trip-payment/lib/adminCaptureTripPaymentSSOT.ts",
      import.meta.url,
    ),
  );
  assert(admin.includes("guardedCaptureRevolutOrder"));
});

Deno.test("Stage A migration is additive; Stage D enables strict cutover", async () => {
  const a = await Deno.readTextFile(
    new URL(
      "../../migrations/20270301120000_payment_coverage_capture_ssot_p0.sql",
      import.meta.url,
    ),
  );
  assert(a.includes("payment_ssot_cutover"));
  assert(a.includes("strict_trip_capture_mirror"));
  assert(a.includes("IF NOT COALESCE(strict_on, false)"));
  const d = await Deno.readTextFile(
    new URL(
      "../../migrations/20270301130000_payment_ssot_cutover_stage_d_strict.sql",
      import.meta.url,
    ),
  );
  assert(d.includes("require_financial_op_claim = true"));
  const g7 = await Deno.readTextFile(
    new URL(
      "../../migrations/20270301140000_completion_gate_payable_snapshot_waiting.sql",
      import.meta.url,
    ),
  );
  assert(g7.includes("payment_payable_snapshots"));
  assert(g7.includes("waiting_pence"));
});

Deno.test("COUNTER path must not call ensureNegotiationPayableAuthorised (source lock)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/customer-fare-decision/index.ts", import.meta.url),
  );
  const counterIdx = src.indexOf("CUSTOMER_SEND_COUNTER");
  assert(counterIdx > 0);
  // Between counter fare validation and CUSTOMER_SEND_COUNTER log — no cover call.
  const slice = src.slice(src.indexOf("customer_counter_ride_offer") - 800, counterIdx);
  assertEquals(slice.includes("ensureNegotiationPayableAuthorised"), false);
  assert(src.includes("COUNTER must never initiate incremental authorisation"));
});

Deno.test("G8 tip-window TEN must not post before capture (source lock)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assert(src.includes("never post TEN during tip-window deferral"));
  const fnStart = src.indexOf("const queueTipWindowTen");
  const fnEnd = src.indexOf("let tipWindowDeferred", fnStart);
  const body = src.slice(fnStart, fnEnd);
  assertEquals(body.includes("postTripEarningNetCanonical"), false);
});

Deno.test("sweep includes recovery_required (G9 source lock)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assert(src.includes('"recovery_required"'));
});

Deno.test("safe capture path retrieves order after POST (G1 source lock)", async () => {
  const completion = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assert(completion.includes("guardedCaptureRevolutOrder"));
  const guarded = await Deno.readTextFile(
    new URL("../../functions/_shared/guardedProviderCaptureSSOT.ts", import.meta.url),
  );
  assert(guarded.includes("retrieveRevolutOrder"));
  assert(
    guarded.indexOf("captureRevolutOrder") < guarded.indexOf("retrieveRevolutOrder"),
  );
});

Deno.test("P0 migration defines capture_confirmed + durable ops + trip mirror trigger", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270301120000_payment_coverage_capture_ssot_p0.sql",
      import.meta.url,
    ),
  );
  assert(mig.includes("capture_confirmed_pence"));
  assert(mig.includes("capture_requested_pence"));
  assert(mig.includes("payment_financial_operations"));
  assert(mig.includes("payment_payable_snapshots"));
  assert(mig.includes("payment_financial_events"));
  assert(mig.includes("trips_capture_amount_confirmed_only"));
  assert(mig.includes("payment_financial_operations_logical_active_uidx"));
});

Deno.test("lock claim no longer re-enters same owner (source lock)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/paymentSessionFinancialLockSSOT.ts", import.meta.url),
  );
  assert(src.includes("same owner string must NOT re-enter"));
  assertEquals(src.includes("current.owner === owner"), false);
});
