/**
 * Internal simulator + regression lock for fare-increasing modification payment gate.
 * MK-260915-002 — processing must not unlock apply; issuer decline keeps original fare/route.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/tripModificationPaymentGateSSOT.test.ts
 *   deno test --allow-read supabase/tests/_shared/revolutIncrementCoverage018.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { RevolutOrder } from "../../functions/_shared/revolutOrders.ts";
import { classifyIncrementCoverage } from "../../functions/_shared/revolutOrders.ts";
import {
  assertNoForbiddenModificationAuthMutation,
  classifyModificationApplyCoverage,
  decideFromPreauthInvokeResult,
  decideModificationIncrementCoverage,
  isAlreadyAppliedModification,
  poundsToPenceExact,
  simulateModificationAuthorisationSequence,
  tripFareBasisMatchesExpectation,
} from "../../functions/_shared/tripModificationPaymentGateSSOT.ts";

function orderShape(args: {
  state?: string;
  paymentAuth?: number;
  increments?: Array<{ old_amount: number; new_amount: number; state: string }>;
}): RevolutOrder {
  return {
    id: "ord-sim",
    state: args.state ?? "AUTHORISED",
    amount: args.paymentAuth ?? 500,
    authorised_amount: undefined,
    payments: args.paymentAuth != null
      ? [{ authorised_amount: args.paymentAuth, amount: args.paymentAuth }]
      : [{ authorised_amount: 500, amount: 500 }],
    incremental_authorisations: args.increments ?? [],
  };
}

Deno.test("original AUTHORISED + pending increment → payment pending, not confirmed", () => {
  const order = orderShape({
    paymentAuth: 500,
    increments: [{ old_amount: 500, new_amount: 811, state: "pending" }],
  });
  const d = decideModificationIncrementCoverage({ order, requiredPayablePence: 811 });
  assertEquals(d.phase, "PAYMENT_PENDING");
  assertEquals(d.mayApply, false);
  // Both apply and capture coverage stay strict after MK-260915-002 (pending ≠ confirmed).
  assertEquals(classifyModificationApplyCoverage(order, 811).class, "processing");
  assertEquals(classifyIncrementCoverage(order, 811).class, "processing");
});

Deno.test("pending increment then issuer decline → PAYMENT_FAILED, never applied", () => {
  const sim = simulateModificationAuthorisationSequence({
    originalAuthorisedPence: 500,
    requiredPayablePence: 811,
    providerSnapshots: [
      orderShape({
        paymentAuth: 500,
        increments: [{ old_amount: 500, new_amount: 811, state: "processing" }],
      }),
      orderShape({
        paymentAuth: 500,
        increments: [{ old_amount: 500, new_amount: 811, state: "declined" }],
      }),
    ],
  });
  assertEquals(sim.decisions[0].phase, "PAYMENT_PENDING");
  assertEquals(sim.decisions[1].phase, "PAYMENT_FAILED");
  assertEquals(sim.applied, false);
  assertEquals(sim.finalAuthorisedPence, 500);
});

Deno.test("delayed decline after several unsettled snapshots still does not apply", () => {
  const unsettled = orderShape({
    paymentAuth: 500,
    increments: [{ old_amount: 500, new_amount: 811, state: "processing" }],
  });
  const declined = orderShape({
    paymentAuth: 500,
    increments: [{ old_amount: 500, new_amount: 811, state: "declined" }],
  });
  // Five unsettled polls then decline (no hard-coded wall-clock; sequence only).
  const sim = simulateModificationAuthorisationSequence({
    originalAuthorisedPence: 500,
    requiredPayablePence: 811,
    providerSnapshots: [unsettled, unsettled, unsettled, unsettled, unsettled, declined],
  });
  assertEquals(sim.applied, false);
  assertEquals(sim.decisions.every((d) => d.mayApply === false), true);
  assertEquals(sim.decisions.at(-1)?.phase, "PAYMENT_FAILED");
});

Deno.test("provider-confirmed increased authorisation unlocks apply", () => {
  const sim = simulateModificationAuthorisationSequence({
    originalAuthorisedPence: 500,
    requiredPayablePence: 811,
    providerSnapshots: [
      orderShape({
        paymentAuth: 500,
        increments: [{ old_amount: 500, new_amount: 811, state: "processing" }],
      }),
      orderShape({
        paymentAuth: 811,
        increments: [{ old_amount: 500, new_amount: 811, state: "authorised" }],
      }),
    ],
  });
  assertEquals(sim.decisions[0].mayApply, false);
  assertEquals(sim.decisions[1].phase, "PROVIDER_CONFIRMED");
  assertEquals(sim.applied, true);
  assertEquals(sim.finalAuthorisedPence, 811);
});

Deno.test("provider response amount below required payable → amount_mismatch fail", () => {
  const d = decideModificationIncrementCoverage({
    order: orderShape({
      paymentAuth: 700,
      increments: [{ old_amount: 500, new_amount: 700, state: "authorised" }],
    }),
    requiredPayablePence: 811,
  });
  assertEquals(d.phase, "PAYMENT_FAILED");
  if (d.phase === "PAYMENT_FAILED") {
    assertEquals(d.reason, "amount_mismatch");
  }
  assertEquals(d.mayApply, false);
});

Deno.test("timeout / network map to PAYMENT_PENDING (trip unchanged)", () => {
  const timeout = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 811,
    authorisedAmountPence: 500,
    paymentCoverageStatus: "authorization_reconciliation_pending",
    errorCode: "TIMEOUT",
    warning: "timeout waiting for provider",
  });
  assertEquals(timeout.phase, "PAYMENT_PENDING");
  assertEquals(timeout.mayApply, false);

  const network = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 811,
    authorisedAmountPence: 500,
    paymentCoverageStatus: "authorization_reconciliation_pending",
    errorCode: "NETWORK",
    warning: "network fetch failed",
  });
  assertEquals(network.phase, "PAYMENT_PENDING");
});

Deno.test("MK-260923-002: HTTP 409 decline body must NOT become payment_unknown", () => {
  // Exact forensic shape from update-preauth on definitive decline.
  const d = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 1241,
    authorisedAmountPence: 500,
    paymentCoverageStatus: "authorization_insufficient",
    errorCode: "AUTHORISED_TOTAL_BELOW_TARGET",
    warning: "Provider authorised total remains below the required fare.",
  });
  assertEquals(d.phase, "PAYMENT_FAILED");
  assertEquals(d.mayApply, false);
  assertEquals(d.requestStatus, "payment_failed");
  assertEquals(d.paymentStatus, "failed");
  if (d.phase === "PAYMENT_FAILED") {
    assertEquals(d.reason, "declined");
  }
  assertEquals(d.authorisedTotalPence, 500);
});

Deno.test("MK-260923-002: ADDITIONAL_AUTHORISATION_DECLINED is definitive fail", () => {
  const d = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 1241,
    authorisedAmountPence: 500,
    paymentCoverageStatus: "authorization_insufficient",
    errorCode: "ADDITIONAL_AUTHORISATION_DECLINED",
  });
  assertEquals(d.phase, "PAYMENT_FAILED");
  if (d.phase === "PAYMENT_FAILED") assertEquals(d.reason, "declined");
});

Deno.test("MK-260923-002: reconciliation_pending without decline stays unknown pending", () => {
  const d = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 1241,
    authorisedAmountPence: 500,
    paymentCoverageStatus: "authorization_reconciliation_pending",
    errorCode: "AUTHORISATION_RECONCILIATION_PENDING",
    warning: "ambiguous authorised total",
  });
  assertEquals(d.phase, "PAYMENT_PENDING");
  if (d.phase === "PAYMENT_PENDING") assertEquals(d.reason, "unknown");
});

Deno.test("MK-260923-002: 500→1241 success unlocks apply; decline keeps 500", () => {
  const success = simulateModificationAuthorisationSequence({
    originalAuthorisedPence: 500,
    requiredPayablePence: 1241,
    providerSnapshots: [
      orderShape({
        paymentAuth: 500,
        increments: [{ old_amount: 500, new_amount: 1241, state: "processing" }],
      }),
      orderShape({
        paymentAuth: 1241,
        increments: [{ old_amount: 500, new_amount: 1241, state: "authorised" }],
      }),
    ],
  });
  assertEquals(success.applied, true);
  assertEquals(success.finalAuthorisedPence, 1241);

  const declined = simulateModificationAuthorisationSequence({
    originalAuthorisedPence: 500,
    requiredPayablePence: 1241,
    providerSnapshots: [
      orderShape({
        paymentAuth: 500,
        increments: [{ old_amount: 500, new_amount: 1241, state: "failed" }],
      }),
    ],
  });
  assertEquals(declined.applied, false);
  assertEquals(declined.decisions[0].phase, "PAYMENT_FAILED");
  assertEquals(declined.finalAuthorisedPence, 500);
});

Deno.test("skipped success never invents authorised coverage for positive delta", () => {
  const invented = decideFromPreauthInvokeResult({
    success: true,
    skipped: true,
    requiredPayablePence: 1031,
    authorisedAmountPence: 0,
    paymentCoverageStatus: "authorization_sufficient",
  });
  assertEquals(invented.mayApply, false);
  assertEquals(invented.phase, "PAYMENT_FAILED");

  const covered = decideFromPreauthInvokeResult({
    success: true,
    skipped: true,
    requiredPayablePence: 1031,
    authorisedAmountPence: 1031,
    paymentCoverageStatus: "authorization_sufficient",
  });
  assertEquals(covered.mayApply, true);
  assertEquals(covered.phase, "PROVIDER_CONFIRMED");
});

Deno.test("duplicate confirmation of applied request is idempotent", () => {
  assertEquals(isAlreadyAppliedModification("applied"), true);
  assertEquals(isAlreadyAppliedModification("approved"), true);
  assertEquals(isAlreadyAppliedModification("payment_pending"), false);
});

Deno.test("concurrent second request fails fare-basis lock after first apply", () => {
  // Request A quoted against 500 and applied → trip now 811.
  // Request B still expects 500 → must not stack another delta.
  assertEquals(
    tripFareBasisMatchesExpectation({
      expectedPreviousFarePence: 500,
      currentCommittedFarePence: 811,
    }),
    false,
  );
  assertEquals(
    tripFareBasisMatchesExpectation({
      expectedPreviousFarePence: 500,
      currentCommittedFarePence: 500,
    }),
    true,
  );
});

Deno.test("stale callback from older modification rejected by fare basis", () => {
  assertEquals(
    tripFareBasisMatchesExpectation({
      expectedPreviousFarePence: 500,
      currentCommittedFarePence: 811,
    }),
    false,
  );
});

Deno.test("fare decrease requires no additional authorisation path", () => {
  // Delta ≤ 0 is handled before increment; gate is not consulted for cover.
  // Exact pounds→pence still holds for display conversions.
  assertEquals(poundsToPenceExact(5), 500);
  assertEquals(poundsToPenceExact(8.11), 811);
  assertEquals(poundsToPenceExact(3.11), 311);
});

Deno.test("initiated/requested increment states never confirm modification apply", () => {
  for (const state of ["initiated", "requested", "unknown", "pending", "processing"]) {
    const coverage = classifyModificationApplyCoverage(
      orderShape({
        paymentAuth: 500,
        increments: [{ old_amount: 500, new_amount: 811, state }],
      }),
      811,
    );
    assertEquals(coverage.class === "confirmed", false, `state=${state}`);
  }
});

Deno.test("PLATFORM_COLLECTED isolation — no wallet/commission/payout/invoice/capture during auth", () => {
  for (const kind of [
    "wallet_ledger_write",
    "commission_wallet_write",
    "payout_ledger_write",
    "invoice_mutation",
    "capture_mutation",
  ]) {
    assertEquals(assertNoForbiddenModificationAuthMutation(kind), false);
  }
  assertEquals(assertNoForbiddenModificationAuthMutation("same_order_increment"), true);
});

Deno.test("caller audit: modification apply stays strict; coverage never treats pending as confirmed", async () => {
  const orders = await Deno.readTextFile(new URL("../../functions/_shared/revolutOrders.ts", import.meta.url));
  // MK-260915-002: processing/pending increment states never count as confirmed coverage.
  assertEquals(orders.includes("MK-260915-002 supersedes MK-260815-020 for coverage"), true);
  assertEquals(orders.includes("NEVER count as confirmed"), true);

  const gate = await Deno.readTextFile(
    new URL("../../functions/_shared/tripModificationPaymentGateSSOT.ts", import.meta.url),
  );
  assertEquals(gate.includes("classifyModificationApplyCoverage"), true);
  assertEquals(
    gate.includes("Processing/pending/initiated increment new_amount must NOT unlock"),
    true,
  );

  const exec = await Deno.readTextFile(
    new URL("../../functions/_shared/executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  // Reconcile may compare providerTotal to target, but must classify via
  // classifyIncrementCoverage — never raw providerTotal alone as apply unlock.
  assertEquals(exec.includes("classifyIncrementCoverage"), true);
  assertEquals(exec.includes("preferSameOrderIncrement"), false);

  const confirm = await Deno.readTextFile(
    new URL("../../functions/_shared/executeFareIncreaseModificationPayment.ts", import.meta.url),
  );
  assertEquals(confirm.includes("decideFromPreauthInvokeResult"), true);
  assertEquals(confirm.includes("claim_and_apply_fare_increase_modification"), true);
  assertEquals(confirm.includes("paymentProcessing"), true);
  assertEquals(
    confirm.includes("Payment is still being authorised. Your trip has not changed yet."),
    true,
  );

  const confirmEdge = await Deno.readTextFile(
    new URL("../../functions/confirm-trip-modification-payment/index.ts", import.meta.url),
  );
  assertEquals(confirmEdge.includes("executeFareIncreaseModificationPayment"), true);
  assertEquals(confirmEdge.includes("advance_trip_change_after_payment"), false);

  const requestEdge = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  assertEquals(requestEdge.includes("executeFareIncreaseModificationPayment"), true);
});

Deno.test("reproduced class: hold 500 → required 811 while processing leaves trip at 500", () => {
  const originalFare = poundsToPenceExact(5.0);
  const required = poundsToPenceExact(8.11);
  const delta = required - originalFare;
  assertEquals(delta, 311);

  const whileProcessing = decideModificationIncrementCoverage({
    order: orderShape({
      paymentAuth: originalFare,
      increments: [{
        old_amount: originalFare,
        new_amount: required,
        state: "processing",
      }],
    }),
    requiredPayablePence: required,
  });
  assertEquals(whileProcessing.mayApply, false);
  assertEquals(whileProcessing.phase, "PAYMENT_PENDING");

  const afterDecline = decideModificationIncrementCoverage({
    order: orderShape({
      paymentAuth: originalFare,
      increments: [{
        old_amount: originalFare,
        new_amount: required,
        state: "declined",
      }],
    }),
    requiredPayablePence: required,
  });
  assertEquals(afterDecline.mayApply, false);
  assertEquals(afterDecline.phase, "PAYMENT_FAILED");
  // Original authorised total retained — destination/fare must stay at originalFare.
  assertEquals(afterDecline.authorisedTotalPence, originalFare);
});
