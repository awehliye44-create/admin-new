/**
 * Signed modification-fold lock — MK-260816-003.
 *
 * Run: deno test --allow-read supabase/functions/_shared/foldTripModificationFare.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { foldTripModificationFare } from "./foldTripModificationFare.ts";
import { computeModificationFareDelta } from "./tripModificationFareDelta.ts";

Deno.test("A. farther route: +300 increases committed fare by 300", () => {
  const folded = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: 0,
    fareDeltaPence: 300,
    newFarePence: 788 + 300,
  });
  assertEquals(folded.customerModificationChargePence, 300);
  assertEquals(folded.finalCustomerFarePence, 1088);
  assertEquals(folded.grossFarePence, 1175);
  assertEquals(folded.destinationChangeAdjustmentPence, 300);
});

Deno.test("B. shorter route: −375 decreases committed fare by 375", () => {
  const folded = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: 0,
    fareDeltaPence: -375,
    newFarePence: 413,
  });
  assertEquals(folded.customerModificationChargePence, -375);
  assertEquals(folded.finalCustomerFarePence, 413);
  assertEquals(folded.grossFarePence, 500);
});

Deno.test("C. exact MK-260816-003 fixture: 788 − 375 = 413", () => {
  const delta = computeModificationFareDelta({
    currentConfirmedFarePence: 788,
    oldRemainingRouteFarePence: 875,
    newRemainingRouteFarePence: 500,
  });
  assertEquals(delta.fareDeltaPence, -375);
  assertEquals(delta.newFarePence, 413);
  assertEquals(delta.paymentRequired, false);

  const folded = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: 0,
    fareDeltaPence: delta.fareDeltaPence,
    newFarePence: delta.newFarePence,
  });
  assertEquals(folded.finalCustomerFarePence, 413);
  assertEquals(folded.captureAmountPence, 413);
  assertEquals(folded.customerModificationChargePence, -375);
  // Old GREATEST(0, …) clamp produced 788 — never again.
  assertEquals(folded.finalCustomerFarePence === 788, false);
});

Deno.test("D. negative delta → payment_required false", () => {
  const delta = computeModificationFareDelta({
    currentConfirmedFarePence: 788,
    oldRemainingRouteFarePence: 875,
    newRemainingRouteFarePence: 500,
  });
  assertEquals(delta.paymentRequired, false);
});

Deno.test("E. positive delta → payment_required true (Revolut increment path)", () => {
  const delta = computeModificationFareDelta({
    currentConfirmedFarePence: 788,
    oldRemainingRouteFarePence: 500,
    newRemainingRouteFarePence: 875,
  });
  assertEquals(delta.fareDeltaPence, 375);
  assertEquals(delta.paymentRequired, true);
});

Deno.test("F. promotion present: discount applied exactly once", () => {
  const folded = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: 0,
    fareDeltaPence: -375,
    newFarePence: 413, // already net of 87
  });
  // Gross = net + discount — never net − discount again (would be 326).
  assertEquals(folded.finalCustomerFarePence, 413);
  assertEquals(folded.grossFarePence, 413 + 87);
  assertEquals(folded.finalCustomerFarePence === 413 - 87, false);
});

Deno.test("G. + then − modifications: signed cumulative stays correct", () => {
  const afterUp = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: 0,
    fareDeltaPence: 300,
    newFarePence: 1088,
  });
  assertEquals(afterUp.customerModificationChargePence, 300);
  assertEquals(afterUp.finalCustomerFarePence, 1088);

  const afterDown = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: afterUp.customerModificationChargePence,
    fareDeltaPence: -200,
    newFarePence: 888,
  });
  assertEquals(afterDown.customerModificationChargePence, 100);
  assertEquals(afterDown.finalCustomerFarePence, 888);
});

Deno.test("H. − then + modifications: signed cumulative stays correct", () => {
  const afterDown = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: 0,
    fareDeltaPence: -375,
    newFarePence: 413,
  });
  assertEquals(afterDown.customerModificationChargePence, -375);

  const afterUp = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: afterDown.customerModificationChargePence,
    fareDeltaPence: 200,
    newFarePence: 613,
  });
  assertEquals(afterUp.customerModificationChargePence, -175);
  assertEquals(afterUp.finalCustomerFarePence, 613);
});

Deno.test("I. multiple reductions: no zero clamp between revisions", () => {
  let cumulative = 0;
  let committed = 788;
  for (const step of [-100, -100, -100]) {
    const next = computeModificationFareDelta({
      currentConfirmedFarePence: committed,
      oldRemainingRouteFarePence: 800,
      newRemainingRouteFarePence: 700,
    });
    // Force the scripted step rather than route math for this lock.
    const folded = foldTripModificationFare({
      lockedBasePence: 875,
      discountPence: 87,
      priorModificationChargePence: cumulative,
      fareDeltaPence: step,
      newFarePence: committed + step,
    });
    cumulative = folded.customerModificationChargePence;
    committed = folded.finalCustomerFarePence;
    assertEquals(cumulative < 0, true);
    void next;
  }
  assertEquals(cumulative, -300);
  assertEquals(committed, 488);
});

Deno.test("J. final fare floor: total cannot go below 1p", () => {
  const folded = foldTripModificationFare({
    lockedBasePence: 500,
    discountPence: 0,
    priorModificationChargePence: 0,
    fareDeltaPence: -10_000,
    newFarePence: 1, // Edge already floored
  });
  assertEquals(folded.finalCustomerFarePence, 1);
  // Accumulator itself stays signed — floor is on the total only.
  assertEquals(folded.customerModificationChargePence, -10_000);
});

Deno.test("K. waiting is outside the fold (caller must not mix it in)", () => {
  const folded = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: 0,
    fareDeltaPence: -375,
    newFarePence: 413,
  });
  // Live card may show 413 + 54 waiting = 467; fold itself stays 413.
  assertEquals(folded.finalCustomerFarePence, 413);
  assertEquals(folded.finalCustomerFarePence + 54, 467);
});

Deno.test("L. restore/live projection: folded net is the committed fare basis", () => {
  const folded = foldTripModificationFare({
    lockedBasePence: 875,
    discountPence: 87,
    priorModificationChargePence: 0,
    fareDeltaPence: -375,
    newFarePence: 413,
  });
  // Live preview must render 413 (+ waiting), never re-clamp to 788.
  assertEquals(folded.finalCustomerFarePence, 413);
  assertEquals(folded.captureAmountPence, 413);
});
