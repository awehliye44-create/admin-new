/**
 * MK-261125 — Payment integrity lock (D1–D4).
 *
 * Waiting coverage, capture-amount integrity, captured-status integrity,
 * and completion lock ordering.
 *
 * Run: deno test -A supabase/tests/_shared/paymentIntegrityWaitingCaptureLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeCaptureAmount, resolveTripFare } from "../../functions/_shared/tripFareSSOT.ts";
import { computeLiveTripFarePreview } from "../../functions/_shared/liveTripFareSSOT.ts";
import { planRevolutCompletionCapture } from "../../functions/_shared/revolutPaymentHoldSSOT.ts";
import { revisedPayablePenceForModification } from "../../functions/_shared/modificationHoldLivenessSSOT.ts";
import {
  resolveModificationRequiredAuthorisationPence,
  resolveProviderConfirmedCapturePence,
} from "../../functions/_shared/providerConfirmedCaptureEvidenceSSOT.ts";
import { tripHasConflictingFinalCapture } from "../../functions/_shared/revolutCaptureIdempotencySSOT.ts";
import { durableSettlementColumns } from "../../functions/finalize-trip-and-capture/lib/durableSettlementOutcomeSSOT.ts";
import { foldTripModificationFare } from "./support/foldTripModificationFare.ts";

const TRIP_002_SHAPE = {
  locked_base_fare_pence: 880,
  final_customer_fare_pence: 903,
  final_fare_pence: 935,
  gross_fare_pence: 935,
  pickup_waiting_charge_pence: 32,
  stop_waiting_charge_pence: 0,
  customer_modification_charge_pence: 23,
  offer_discount_pence: 0,
  discount_pence: 0,
};

Deno.test("D1: SSOT payable includes waiting after modification fold", () => {
  const resolved = resolveTripFare(TRIP_002_SHAPE);
  const capture = computeCaptureAmount(TRIP_002_SHAPE, "completed");
  const live = computeLiveTripFarePreview(TRIP_002_SHAPE);
  assertEquals(resolved.final_fare_pence, 935);
  assertEquals(capture.capture_amount_pence, 935);
  assertEquals(live.current_customer_total_pence, 935);
});

Deno.test("D1: waiting-only payable requires increment above original hold", () => {
  const trip = {
    locked_base_fare_pence: 880,
    final_customer_fare_pence: 880,
    pickup_waiting_charge_pence: 32,
    customer_modification_charge_pence: 0,
    offer_discount_pence: 0,
  };
  const capture = computeCaptureAmount(trip, "completed");
  assertEquals(capture.capture_amount_pence, 912);
  const plan = planRevolutCompletionCapture({
    finalFarePence: 912,
    authorisedHoldPence: 880,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "same_order_increment_required");
  if (plan.kind === "same_order_increment_required") {
    assertEquals(plan.target_total_authorised_pence, 912);
  }
});

Deno.test("D1: modification required auth includes accumulated waiting", () => {
  assertEquals(
    revisedPayablePenceForModification({
      newFarePence: 903,
      pickupWaitingChargePence: 32,
      newCustomerTotalPence: 935,
    }),
    935,
  );
  assertEquals(
    resolveModificationRequiredAuthorisationPence({
      newFarePence: 903,
      pickupWaitingChargePence: 32,
      stopWaitingChargePence: 0,
      newCustomerTotalPence: 935,
    }),
    935,
  );
  // Preview wins when larger than route+waiting reconstruction
  assertEquals(
    resolveModificationRequiredAuthorisationPence({
      newFarePence: 900,
      pickupWaitingChargePence: 0,
      newCustomerTotalPence: 950,
    }),
    950,
  );
  // Backward compatible: route only when waiting omitted
  assertEquals(
    revisedPayablePenceForModification({ newFarePence: 903 }),
    903,
  );
});

Deno.test("D1: modification then waiting still plans increment at completion", () => {
  const afterMod = {
    ...TRIP_002_SHAPE,
    // waiting finalized after mod (mod-followed-by-waiting)
    final_customer_fare_pence: 903,
    pickup_waiting_charge_pence: 32,
  };
  const capture = computeCaptureAmount(afterMod, "completed");
  assertEquals(capture.capture_amount_pence, 935);
  const plan = planRevolutCompletionCapture({
    finalFarePence: 935,
    authorisedHoldPence: 903,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "same_order_increment_required");
});

Deno.test("D1: promotion + waiting + mod — discount already in final_customer", () => {
  const trip = {
    locked_base_fare_pence: 1000,
    final_customer_fare_pence: 1100, // net after promo + folded mod
    pickup_waiting_charge_pence: 40,
    customer_modification_charge_pence: 100,
    offer_discount_pence: 50,
    discount_pence: 50,
    gross_fare_pence: 1150,
  };
  const capture = computeCaptureAmount(trip, "completed");
  // ride base = final_customer 1100 (mod folded); + waiting 40; discount already in ride
  assertEquals(capture.capture_amount_pence, 1140);
});

Deno.test("D2: insufficient auth plans same-order increment (not second payment)", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 935,
    authorisedHoldPence: 903,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "same_order_increment_required");
  if (plan.kind === "same_order_increment_required") {
    assertEquals(plan.shortfall_pence, 32);
    assertEquals(plan.capture_amount_pence, 935);
  }
});

Deno.test("D2: completion capture source acquires composition after increment path", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  const incrementIdx = src.indexOf("executeSameOrderIncrement({");
  const compositionAfter = src.indexOf(
    "acquire CAPTURING composition only after authorised coverage",
  );
  assertEquals(incrementIdx > 0, true);
  assertEquals(compositionAfter > incrementIdx, true);
  assertStringIncludes(src, "reclaimExpiredPaymentSessionFinancialLock");
  assertStringIncludes(src, "revolutCompletionCapture:stale_lock_reclaim");
  assertStringIncludes(src, 'incrementResult.kind === "lock_busy"');
});

Deno.test("D3: modification fold mirror payable must not imply capture stamp", () => {
  const folded = foldTripModificationFare({
    lockedBasePence: 880,
    discountPence: 0,
    priorModificationChargePence: 0,
    fareDeltaPence: 23,
    newFarePence: 903,
  });
  assertEquals(folded.finalCustomerFarePence, 903);
  assertEquals(folded.captureAmountPence, 903); // payable mirror only
});

Deno.test("D3: apply_trip_modification migration removes capture_amount stamp", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270228140000_modification_fold_no_capture_amount_stamp.sql",
      import.meta.url,
    ),
  );
  assertEquals(mig.includes("capture_amount_pence = v_final_pence"), false);
  assertStringIncludes(mig, "final_customer_fare_pence = v_final_pence");
  assertStringIncludes(mig, "CREATE OR REPLACE FUNCTION public.apply_trip_modification_to_trip");
});

Deno.test("D4: premature trip.capture_amount is not confirmed capture evidence", () => {
  // AUTHORISED provider + premature trip stamp 903 must NOT count as confirmed
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
      confirmedCapturePence: confirmed,
      requestedCapturePence: 935,
    }),
    false,
  );
});

Deno.test("D4: provider COMPLETED with amount is confirmed", () => {
  assertEquals(
    resolveProviderConfirmedCapturePence({
      providerState: "COMPLETED",
      providerCapturedPence: 903,
      sessionStatus: "trip_created",
      sessionCapturedPence: null,
      paymentCapturedPence: null,
    }),
    903,
  );
});

Deno.test("D4: durableSettlement does not invent captured from capture_busy", () => {
  const cols = durableSettlementColumns("capture_busy", false);
  assertEquals(cols.payment_status, "authorized");
  assertEquals(cols.payment_hold_status, "capture_pending");
});

Deno.test("D4: already_captured success still maps to captured (producer must be truthful)", () => {
  const cols = durableSettlementColumns("already_captured", true);
  assertEquals(cols.payment_status, "captured");
});

Deno.test("D4: completion source ignores trips.capture_amount as sole confirmation", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(src, "resolveProviderConfirmedCapturePence");
  assertStringIncludes(src, "never treat trips.capture_amount_pence as confirmed");
  // Must not prefer storedTripCapture over session/provider
  assertEquals(src.includes("const confirmedFinalCapturePence = storedTripCapture > 0"), false);
});

Deno.test("Multiple increments: first mod then waiting shortfall", () => {
  // After mod auth 903, waiting needs 935
  const plan1 = planRevolutCompletionCapture({
    finalFarePence: 903,
    authorisedHoldPence: 880,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan1.kind, "same_order_increment_required");
  const plan2 = planRevolutCompletionCapture({
    finalFarePence: 935,
    authorisedHoldPence: 903,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan2.kind, "same_order_increment_required");
  if (plan2.kind === "same_order_increment_required") {
    assertEquals(plan2.target_total_authorised_pence, 935);
  }
  const covered = planRevolutCompletionCapture({
    finalFarePence: 935,
    authorisedHoldPence: 935,
    bufferPence: 0,
    preferSameOrderIncrement: true,
  });
  assertEquals(covered.kind, "capture_within_hold");
});
