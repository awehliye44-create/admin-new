import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluatePaymentAuthorisationValidity,
  resolveBookingCustomerPayablePence,
} from "../../../shared/paymentAuthorisationValiditySSOT.ts";
import {
  durableSettlementColumns,
  needsDurableSettlementPersist,
} from "../../../shared/durableSettlementOutcomeSSOT.ts";
import { planRevolutCompletionCapture } from "../../../shared/revolutPaymentHoldSSOT.ts";
import { decideCaptureAfterRetrieve } from "./revolutCaptureIdempotencySSOT.ts";
import { safeCaptureAfterIncrementDecline } from "./paymentRecoveryGuardSSOT.ts";
import { isCardPaymentCaptured } from "./onecabFinanceLedger.ts";

Deno.test("1: authorised == required → valid", () => {
  const r = evaluatePaymentAuthorisationValidity({
    paymentMethod: "CARD",
    providerState: "AUTHORISED",
    sessionStatus: "payment_authorised",
    authorisedAmountPence: 788,
    requiredCustomerPayablePence: 788,
  });
  assertEquals(r.valid, true);
});

Deno.test("2: authorised > required → valid", () => {
  assertEquals(
    evaluatePaymentAuthorisationValidity({
      paymentMethod: "CARD",
      providerState: "AUTHORISED",
      sessionStatus: "payment_authorised",
      authorisedAmountPence: 900,
      requiredCustomerPayablePence: 788,
    }).valid,
    true,
  );
});

Deno.test("3: authorised < required → PAYMENT_AUTHORISATION_INSUFFICIENT", () => {
  const r = evaluatePaymentAuthorisationValidity({
    paymentMethod: "CARD",
    providerState: "AUTHORISED",
    sessionStatus: "payment_authorised",
    authorisedAmountPence: 788,
    requiredCustomerPayablePence: 875,
  });
  assertEquals(r.valid, false);
  assertEquals(r.code, "PAYMENT_AUTHORISATION_INSUFFICIENT");
});

Deno.test("4-6: discount lineage distinct; not a shortfall", () => {
  const lineage = resolveBookingCustomerPayablePence({
    bookingSnapshot: {
      gross_fare_pence: 875,
      discount_amount_pence: 87,
      final_estimated_fare_pence: 788,
    },
    fareSnapshot: {
      gross_fare_pence: 875,
      offer_discount_pence: 87,
      final_fare_pence: 788,
      estimated_total_pence: 788,
    },
    sessionAuthorisedAmountPence: 788,
  });
  assertEquals(lineage.gross_fare_pence, 875);
  assertEquals(lineage.discount_pence, 87);
  assertEquals(lineage.customer_payable_pence, 788);
  assertEquals(lineage.customer_payable_pence + lineage.discount_pence, lineage.gross_fare_pence);
  assertEquals(
    evaluatePaymentAuthorisationValidity({
      paymentMethod: "CARD",
      providerState: "AUTHORISED",
      sessionStatus: "payment_authorised",
      authorisedAmountPence: 788,
      requiredCustomerPayablePence: lineage.customer_payable_pence,
    }).valid,
    true,
  );
});

Deno.test("7: completion final <= hold → capture_within_hold exact once amount", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 788,
    authorisedHoldPence: 788,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 788);
    assertEquals(plan.release_remainder_pence, 0);
  }
});

Deno.test("8: final > hold → same_order_increment_required when supported", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 875,
    authorisedHoldPence: 788,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "same_order_increment_required");
  if (plan.kind === "same_order_increment_required") {
    assertEquals(plan.shortfall_pence, 87);
    assertEquals(plan.target_total_authorised_pence, 875);
  }
});

Deno.test("9: incremental auth fails → explicit shortfall via safe capture", () => {
  const safe = safeCaptureAfterIncrementDecline({
    finalFarePence: 875,
    providerConfirmedAuthorisedTotalPence: 788,
  });
  assertEquals(safe.capturePence, 788);
  assertEquals(safe.shortfallPence, 87);
  const cols = durableSettlementColumns("PAYMENT_RECOVERY_REQUIRED", true);
  assertEquals(cols.payment_status, "payment_shortfall");
});

Deno.test("10: capture failure persists failure state", () => {
  const cols = durableSettlementColumns("capture_failed", false);
  assertEquals(cols.payment_status, "capture_failed");
  assertEquals(cols.payment_hold_status, "capture_failed");
});

Deno.test("11-12: finalize/webhook retry → reconcile_already_captured (no second capture)", () => {
  const decision = decideCaptureAfterRetrieve({
    paymentSessionId: "sess",
    providerOrderId: "ord",
    order: { state: "COMPLETED", amount: 788 } as any,
    finalFarePence: 788,
  });
  assertEquals(decision.action, "reconcile_already_captured");
});

Deno.test("13: stale CANCELLED cannot overwrite newer AUTHORISED (shared rank SSOT)", async () => {
  const { isRevolutProviderStateRegression, revolutProviderStateRank } = await import(
    "../../../shared/revolutProviderStateRankSSOT.ts"
  );
  assertEquals(revolutProviderStateRank("CANCELLED") < revolutProviderStateRank("AUTHORISED"), true);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "CANCELLED"), true);
  assertEquals(isRevolutProviderStateRegression("CANCELLED", "AUTHORISED"), false);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "COMPLETED"), false);
});

Deno.test("14: completed trip cannot remain draft/authorized with no settlement", () => {
  assertEquals(
    needsDurableSettlementPersist({
      paymentStatus: "authorized",
      paymentHoldStatus: null,
      paymentState: "draft",
      finalizeSuccess: false,
      finalizeStatus: "capture_failed",
    }),
    true,
  );
  assertEquals(
    needsDurableSettlementPersist({
      paymentStatus: "preauth_authorized",
      paymentHoldStatus: "",
      paymentState: "booking_created",
      finalizeSuccess: true,
      finalizeStatus: "PAYMENT_RECOVERY_REQUIRED",
    }),
    true,
  );
  const cols = durableSettlementColumns("PAYMENT_RECOVERY_REQUIRED", true);
  assertEquals(cols.payment_status, "payment_shortfall");
});

Deno.test("15: ledger only from captured settlement evidence", () => {
  assertEquals(
    isCardPaymentCaptured({
      tripPaymentStatus: "authorized",
    }),
    false,
  );
  assertEquals(
    isCardPaymentCaptured({
      tripPaymentStatus: "captured",
    }),
    true,
  );
});
