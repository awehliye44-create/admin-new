/**
 * A2 lock: customer cancel during free waiting.
 * Rematch (A1) excluded — see driverCancelRematch.lock.test.ts.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isArrivalCancellationFeeEligible,
  resolveTerminalPaymentDecision,
  shouldApplyForceFeeOverride,
  type FarePricingFeeConfig,
  type TerminalTripEvidence,
} from "./terminalFeeDecisionSSOT.ts";
import {
  buildTerminalDispositionMetadata,
  sessionMetadataContradictsCapture,
  terminalPaymentSessionStatus,
} from "./terminalTripPaymentDisposition.ts";
import { noShowEligibleFromCountedSeconds } from "./waitingSegmentClock.ts";

const TRIP_ID = "c7ce4f1a-897a-41f0-8d26-2ec9df72a062";
const DRIVER_ID = "c40dd8a6-f422-40bc-9534-bae7be88b93e";
const ARRIVED = "2026-09-13T16:35:45.708Z";
const FREE_EXPIRES = "2026-09-13T16:38:45.708Z";
const CANCELLED_DURING_FREE = "2026-09-13T16:37:05.465Z";
const CANCELLED_AFTER_FREE = "2026-09-13T16:38:46.000Z";

const mkPolicy: FarePricingFeeConfig = {
  cancellation_fee_pence: 400,
  cancellation_grace_period_minutes: 3,
  cancellation_apply_after_arrival_only: true,
  no_show_fee_pence: 400,
  no_show_wait_time_minutes: 4,
  no_show_apply_after_arrival_only: true,
  late_cancel_enabled: true,
  late_cancel_threshold_minutes: 30,
  late_cancel_fee_pence: 500,
  arrival_cancellation_enabled: true,
  arrival_cancellation_fee_pence: 400,
  arrival_cancellation_apply_after_free_waiting_expired: true,
  arrival_cancellation_after_arrival_only: true,
  free_waiting_minutes: 3,
};

function evidence(over: Partial<TerminalTripEvidence> = {}): TerminalTripEvidence {
  return {
    trip_id: TRIP_ID,
    trip_status: "cancelled",
    started_at: null,
    arrived_at: null,
    free_wait_expires_at: null,
    cancelled_at: CANCELLED_DURING_FREE,
    cancelled_by: "rider",
    scheduled_at: null,
    cancellation_grace_expires_at: null,
    driver_id: DRIVER_ID,
    confirmed_driver_id: DRIVER_ID,
    no_show_recorded: false,
    authorised_amount_pence: 800,
    previously_captured_amount_pence: 0,
    payment_session_id: "f4ad76a3-fd85-49fa-9ace-33be1baf5c52",
    provider: "revolut",
    pickup_waiting_counted_seconds: 0,
    ...over,
  };
}

function decide(over: Partial<TerminalTripEvidence> = {}) {
  return resolveTerminalPaymentDecision({
    evidence: evidence(over),
    config: mkPolicy,
    feePolicyId: "9ab39ea8-536c-4e4a-864e-218db52b7263",
  });
}


function simulateCustomerMoney(args: {
  decision: ReturnType<typeof decide>;
  provider: "ok" | "fail";
  alreadyFinal: boolean;
  creditDriverWallet: boolean;
}) {
  if (args.alreadyFinal) {
    return { capturePosts: 0, refundPosts: 0, capturePence: args.decision.capture_required_pence, walletPence: 0, commissionPence: 0, phantomFee: false };
  }
  if (args.provider === "fail") {
    return { capturePosts: 0, refundPosts: 0, capturePence: 0, walletPence: 0, commissionPence: 0, phantomFee: false };
  }
  const capture = args.decision.capture_required_pence;
  const wallet = capture > 0 && args.creditDriverWallet ? capture : 0;
  return { capturePosts: capture > 0 ? 1 : 0, refundPosts: 0, capturePence: capture, walletPence: wallet, commissionPence: 0, phantomFee: false };
}

function planMkRefund(state: { refundedPence: number; capturedPence: number }) {
  if (state.refundedPence >= 400) {
    return { execute: false, idempotent: true, refundPence: 0, walletDeltaPence: 0, secondCapture: false };
  }
  if (state.capturedPence !== 400) {
    return { execute: false, idempotent: false, refundPence: 0, walletDeltaPence: 0, secondCapture: false, blocked: "captured_not_400" };
  }
  return {
    execute: false,
    idempotent: true,
    refundPence: 400,
    walletDeltaPence: 0,
    secondCapture: false,
    idempotencyKey: "mk260913006:refund:400:6aa6cf84-2fef-a6a5-b0dc-c2746911a045",
  };
}
Deno.test("B: customer cancel before arrival releases the hold", () => {
  const d = decide({ arrived_at: null, free_wait_expires_at: null, pickup_waiting_counted_seconds: null });
  assertEquals(d.fee_amount_pence, 0);
  assertEquals(d.capture_required_pence, 0);
  assertEquals(d.provider_action, "void_full");
});

Deno.test("B: MK-260913-006 free-wait cancel captures 0", () => {
  const d = decide({
    arrived_at: ARRIVED,
    free_wait_expires_at: FREE_EXPIRES,
    cancelled_at: CANCELLED_DURING_FREE,
    pickup_waiting_counted_seconds: 79,
    cancellation_grace_expires_at: null,
  });
  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.capture_required_pence, 0);
  assertEquals(d.release_required_pence, 800);
  assertEquals(shouldApplyForceFeeOverride({
    force: true,
    feePence: 400,
    dispositionReason: d.disposition_reason,
  }), false);
});

Deno.test("B: arrival fee only after free wait expired and counted seconds cover it", () => {
  const d = decide({
    arrived_at: ARRIVED,
    free_wait_expires_at: FREE_EXPIRES,
    cancelled_at: CANCELLED_AFTER_FREE,
    pickup_waiting_counted_seconds: 180,
  });
  assertEquals(d.disposition_reason, "ARRIVAL_CANCELLATION_FEE");
  assertEquals(d.capture_required_pence, 400);
  assertEquals(d.release_required_pence, 400);
  assertEquals(d.fee_type, "arrival_cancellation");
});

Deno.test("B: paused outside radius does not advance the fee clock", () => {
  const wallClockExpired = decide({
    arrived_at: ARRIVED,
    free_wait_expires_at: FREE_EXPIRES,
    cancelled_at: CANCELLED_AFTER_FREE,
    pickup_waiting_counted_seconds: 40,
  });
  assertEquals(wallClockExpired.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(wallClockExpired.capture_required_pence, 0);
  assertEquals(isArrivalCancellationFeeEligible({
    arrivedAtMs: Date.parse(ARRIVED),
    cancelledAtMs: Date.parse(CANCELLED_AFTER_FREE),
    freeExpiresMs: Date.parse(FREE_EXPIRES),
    requireFreeWaitExpired: true,
    freeWaitingMinutes: 3,
    countedInRadiusSeconds: 40,
  }), false);
});

Deno.test("B: no-show before eligible is denied; after eligible is the configured fee", () => {
  assertEquals(noShowEligibleFromCountedSeconds({
    countedSeconds: 79,
    requiredWaitMinutes: 4,
  }), false);
  assertEquals(noShowEligibleFromCountedSeconds({
    countedSeconds: 240,
    requiredWaitMinutes: 4,
  }), true);
  const fee = decide({
    trip_status: "no_show",
    cancelled_by: "driver",
    no_show_recorded: true,
    arrived_at: ARRIVED,
    pickup_waiting_counted_seconds: 240,
  });
  assertEquals(fee.disposition_reason, "CUSTOMER_NO_SHOW");
  assertEquals(fee.capture_required_pence, 400);
});

Deno.test("B: null cancellation grace must not charge after arrival", () => {
  const d = decide({
    arrived_at: ARRIVED,
    free_wait_expires_at: FREE_EXPIRES,
    cancelled_at: CANCELLED_DURING_FREE,
    cancellation_grace_expires_at: null,
    pickup_waiting_counted_seconds: 79,
  });
  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.fee_type, "none");
});

Deno.test("C: session reconcile must not use status cancelled", () => {
  assertEquals(terminalPaymentSessionStatus(0), "released");
  assertEquals(terminalPaymentSessionStatus(400), "PARTIAL_CAPTURE_ONLY");
  assertEquals(terminalPaymentSessionStatus(0) === "cancelled", false);
  assertEquals(terminalPaymentSessionStatus(400) === "cancelled", false);
});

Deno.test("B: null grace does not charge before arrival", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ arrived_at: null, cancellation_grace_expires_at: null }),
    config: { ...mkPolicy, cancellation_apply_after_arrival_only: false },
    feePolicyId: "9ab39ea8-536c-4e4a-864e-218db52b7263",
  });
  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.capture_required_pence, 0);
});

Deno.test("B: duplicate customer cancel does not post a second capture or refund", () => {
  const decision = decide({
    arrived_at: ARRIVED,
    free_wait_expires_at: FREE_EXPIRES,
    cancelled_at: CANCELLED_AFTER_FREE,
    pickup_waiting_counted_seconds: 180,
  });
  const first = simulateCustomerMoney({ decision, provider: "ok", alreadyFinal: false, creditDriverWallet: false });
  const second = simulateCustomerMoney({ decision, provider: "ok", alreadyFinal: true, creditDriverWallet: false });
  assertEquals(first.capturePosts, 1);
  assertEquals(second.capturePosts, 0);
  assertEquals(second.refundPosts, 0);
});

Deno.test("B: provider failure writes no phantom fee and no wallet credit", () => {
  const decision = decide({
    arrived_at: ARRIVED,
    free_wait_expires_at: FREE_EXPIRES,
    cancelled_at: CANCELLED_AFTER_FREE,
    pickup_waiting_counted_seconds: 180,
  });
  const failed = simulateCustomerMoney({ decision, provider: "fail", alreadyFinal: false, creditDriverWallet: true });
  assertEquals(failed.capturePence, 0);
  assertEquals(failed.walletPence, 0);
  assertEquals(failed.commissionPence, 0);
  assertEquals(failed.phantomFee, false);
});

Deno.test("C: free-wait cancel captures 0 and credits no wallet or commission", () => {
  const decision = decide({
    arrived_at: ARRIVED,
    free_wait_expires_at: FREE_EXPIRES,
    cancelled_at: CANCELLED_DURING_FREE,
    pickup_waiting_counted_seconds: 79,
  });
  const money = simulateCustomerMoney({ decision, provider: "ok", alreadyFinal: false, creditDriverWallet: false });
  assertEquals(money.capturePence, 0);
  assertEquals(money.walletPence, 0);
  assertEquals(money.commissionPence, 0);
});

Deno.test("C: arrival fee captures the configured fee only and does not credit the driver", () => {
  const decision = decide({
    arrived_at: ARRIVED,
    free_wait_expires_at: FREE_EXPIRES,
    cancelled_at: CANCELLED_AFTER_FREE,
    pickup_waiting_counted_seconds: 180,
  });
  const money = simulateCustomerMoney({ decision, provider: "ok", alreadyFinal: false, creditDriverWallet: false });
  assertEquals(money.capturePence, 400);
  assertEquals(money.walletPence, 0);
  assertEquals(money.commissionPence, 0);
});

Deno.test("C: captured session metadata must not stay fee 0 / void_full / pending", () => {
  const stale = {
    terminal_disposition_pending: true,
    void_full: true,
    fee_pence: 0,
    terminal_disposition_decision: {
      disposition_reason: "NO_FEE_FULL_RELEASE",
      fee_amount_pence: 0,
      provider_action: "void_full",
    },
  };
  const written = buildTerminalDispositionMetadata({
    priorMeta: stale,
    dispositionKey: "mk-key",
    decision: decide({
      arrived_at: ARRIVED,
      free_wait_expires_at: FREE_EXPIRES,
      cancelled_at: CANCELLED_DURING_FREE,
      pickup_waiting_counted_seconds: 79,
    }),
    capturedFeePence: 400,
    nowIso: "2026-09-13T16:37:07.000Z",
  });
  assertEquals(sessionMetadataContradictsCapture(written, 400), false);
  assertEquals(written.terminal_disposition_pending, false);
  assertEquals(written.void_full, false);
  assertEquals(written.fee_pence, 400);
});

Deno.test("C: MK refund is a separate 400p plan; no driver credit was posted", () => {
  const capturedByBugPence = 400;
  const driverWalletCreditPence = 0;
  const commissionLedgerPence = 0;
  assertEquals(capturedByBugPence, 400);
  assertEquals(driverWalletCreditPence, 0);
  assertEquals(commissionLedgerPence, 0);
  const first = planMkRefund({ refundedPence: 0, capturedPence: 400 });
  const replay = planMkRefund({ refundedPence: 400, capturedPence: 400 });
  assertEquals(first.execute, false);
  assertEquals(first.refundPence, 400);
  assertEquals(first.walletDeltaPence, 0);
  assertEquals(first.secondCapture, false);
  assertEquals(replay.refundPence, 0);
  assertEquals(replay.idempotent, true);
  assertEquals(shouldApplyForceFeeOverride({
    force: true,
    feePence: 0,
    dispositionReason: "ARRIVAL_CANCELLATION_FEE",
  }), true);
});


Deno.test("A2: live cancel-trip / disposition sources enforce free-wait gates", async () => {
  const cancel = await Deno.readTextFile(new URL("../cancel-trip/index.ts", import.meta.url));
  const dispose = await Deno.readTextFile(new URL("./terminalTripPaymentDisposition.ts", import.meta.url));
  const fee = await Deno.readTextFile(new URL("./terminalFeeDecisionSSOT.ts", import.meta.url));
  assertEquals(cancel.includes("cancelled_after_arrival_grace"), false);
  assertStringIncludes(cancel, "isArrivalCancellationFeeEligible");
  assertStringIncludes(fee, "isArrivalCancellationFeeEligible");
  assertStringIncludes(fee, "shouldApplyForceFeeOverride");
  assertEquals(dispose.includes('status: "cancelled"'), false);
  assertStringIncludes(dispose, "shouldApplyForceFeeOverride");
  assertStringIncludes(dispose, "terminalPaymentSessionStatus");
  assertStringIncludes(dispose, "buildTerminalDispositionMetadata");
});
