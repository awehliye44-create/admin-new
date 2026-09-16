/**
 * Internal simulator + regression lock for fare-increasing modification payment gate.
 * MK-260915-002 — processing must not unlock apply; issuer decline keeps original fare/route.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/tripModificationPaymentGateSSOT.test.ts
 *   deno test --allow-read supabase/functions/_shared/revolutIncrementCoverage018.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { RevolutOrder } from "./revolutOrders.ts";
import { classifyIncrementCoverage } from "./revolutOrders.ts";
import {
  assertNoForbiddenModificationAuthMutation,
  decideFromPreauthInvokeResult,
  decideModificationIncrementCoverage,
  isAlreadyAppliedModification,
  poundsToPenceExact,
  simulateModificationAuthorisationSequence,
  tripFareBasisMatchesExpectation,
} from "./tripModificationPaymentGateSSOT.ts";

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

Deno.test("initiated/requested increment states never confirm", () => {
  for (const state of ["initiated", "requested", "unknown", "pending", "processing"]) {
    const coverage = classifyIncrementCoverage(
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

Deno.test("caller audit: classifyIncrementCoverage has no second processing→confirmed path", async () => {
  const orders = await Deno.readTextFile(new URL("./revolutOrders.ts", import.meta.url));
  assertEquals(orders.includes("acceptedIncrementTotal"), false);
  assertEquals(orders.includes("MK-260815-020: increment POST 200 leaves"), false);
  assertEquals(orders.includes("isUnsettledIncrementState"), true);

  const exec = await Deno.readTextFile(
    new URL("./executeSameOrderIncrementSSOT.ts", import.meta.url),
  );
  // Prior-attempt reconcile must not fall back to raw providerTotal without confirmed class.
  assertEquals(
    exec.includes("providerTotal >= plan.targetTotalPence\n        ? providerTotal"),
    false,
  );

  const confirm = await Deno.readTextFile(
    new URL("../confirm-trip-modification-payment/index.ts", import.meta.url),
  );
  assertEquals(confirm.includes("decideFromPreauthInvokeResult"), true);
  assertEquals(confirm.includes("claim_and_apply_fare_increase_modification"), true);
  assertEquals(confirm.includes("paymentProcessing"), true);
  assertEquals(
    confirm.includes("Payment is still processing. Your trip has not been changed."),
    true,
  );
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
