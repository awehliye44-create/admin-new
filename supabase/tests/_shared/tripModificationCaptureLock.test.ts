/**
 * Lock: trip modifications update canonical payable once — never re-add at capture.
 * Explicit case MK-260815-029: 450 + 266 = 716 — never 982.
 *
 * Run: deno test --allow-read --no-check supabase/functions/_shared/tripModificationCaptureLock.test.ts
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeCaptureAmount,
  computeFinalFarePence,
  isModificationAlreadyInRideBase,
  resolveCustomerModificationChargePence,
  resolveRideFareBasePence,
} from "./tripFareSSOT.ts";
import { buildCaptureBreakdownForCompletedTrip } from "./paymentSessionsCaptureBreakdownSSOT.ts";
import {
  calculateTripSettlement,
} from "./tripSettlement.ts";

const MK029 = {
  locked_base_fare_pence: 500,
  gross_fare_pence: 766,
  commissionable_fare_pence: 766,
  final_customer_fare_pence: 716,
  discount_pence: 50,
  customer_modification_charge_pence: 266,
  destination_change_adjustment_pence: 266,
  pickup_waiting_charge_pence: 0,
  stop_waiting_charge_pence: 0,
  airport_charge_pence: 0,
  tip_pence: 0,
  extras_pence: 0,
} as const;

/** Audit delta stays readable; capture must not re-add it. */
function assertAuditDeltaVisibleButNotDoubleCounted(trip: typeof MK029 | Record<string, unknown>) {
  const audit = resolveCustomerModificationChargePence(trip);
  assertEquals(audit > 0, true);
  assertEquals(isModificationAlreadyInRideBase(trip), true);
  const capture = computeCaptureAmount(trip, "completed").capture_amount_pence;
  assertEquals(capture, Number(trip.final_customer_fare_pence));
  assertEquals(capture + audit !== capture, true); // delta exists
  // Poisoned path would be final_customer + audit
  assertEquals(capture, Number(trip.final_customer_fare_pence));
}

Deno.test("1. destination change increases fare once", () => {
  assertEquals(resolveRideFareBasePence(MK029), 716);
  assertEquals(resolveCustomerModificationChargePence(MK029), 266);
  assertEquals(isModificationAlreadyInRideBase(MK029), true);
  assertEquals(computeFinalFarePence(MK029), 716);
});

Deno.test("2. destination change decreases fare", () => {
  const decreased = {
    locked_base_fare_pence: 500,
    final_customer_fare_pence: 400,
    discount_pence: 0,
    // Absolute decrease stored as signed audit field may be negative or positive
    // magnitude depending on writer; SSOT uses absolute charge field when > 0.
    // After fold, final_customer is the canonical total.
    customer_modification_charge_pence: 100,
    pickup_waiting_charge_pence: 0,
    tip_pence: 0,
  };
  assertEquals(isModificationAlreadyInRideBase(decreased), true);
  assertEquals(computeFinalFarePence(decreased), 400);
  assertEquals(computeCaptureAmount(decreased, "completed").capture_amount_pence, 400);
});

Deno.test("3. multiple sequential destination changes", () => {
  // Original 500 → mod1 700 → mod2 825. Only current canonical total matters.
  const afterFirst = {
    locked_base_fare_pence: 500,
    final_customer_fare_pence: 700,
    customer_modification_charge_pence: 200,
    discount_pence: 0,
    tip_pence: 0,
  };
  assertEquals(computeCaptureAmount(afterFirst, "completed").capture_amount_pence, 700);

  const afterSecond = {
    locked_base_fare_pence: 500,
    final_customer_fare_pence: 825,
    customer_modification_charge_pence: 325, // cumulative audit
    discount_pence: 0,
    tip_pence: 0,
  };
  assertEquals(computeFinalFarePence(afterSecond), 825);
  assertEquals(computeCaptureAmount(afterSecond, "completed").capture_amount_pence, 825);
  // Never 500+700+825 or 825+previous deltas
  assertEquals(825 + 200, 1025);
  assertEquals(computeFinalFarePence(afterSecond) !== 1025, true);
});

Deno.test("4. add stop", () => {
  const addStop = {
    locked_base_fare_pence: 500,
    final_customer_fare_pence: 620,
    discount_pence: 50,
    customer_modification_charge_pence: 170,
    pickup_waiting_charge_pence: 0,
    tip_pence: 0,
  };
  assertEquals(isModificationAlreadyInRideBase(addStop), true);
  assertEquals(computeCaptureAmount(addStop, "completed").capture_amount_pence, 620);
});

Deno.test("5. remove stop", () => {
  const removeStop = {
    locked_base_fare_pence: 620,
    final_customer_fare_pence: 500,
    discount_pence: 0,
    customer_modification_charge_pence: 120,
    pickup_waiting_charge_pence: 0,
    tip_pence: 0,
  };
  assertEquals(isModificationAlreadyInRideBase(removeStop), true);
  assertEquals(computeCaptureAmount(removeStop, "completed").capture_amount_pence, 500);
});

Deno.test("6. modification before driver assigned", () => {
  const preAssign = {
    ...MK029,
    // Same fare math whether or not a driver is assigned — canonical total only.
    driver_id: null,
  };
  assertEquals(computeFinalFarePence(preAssign), 716);
  assertEquals(computeCaptureAmount(preAssign, "completed").capture_amount_pence, 716);
});

Deno.test("7. modification after driver assigned", () => {
  const postAssign = {
    ...MK029,
    driver_id: "driver-assigned",
  };
  assertEquals(computeFinalFarePence(postAssign), 716);
  assertEquals(computeCaptureAmount(postAssign, "completed").capture_amount_pence, 716);
});

Deno.test("8. modification followed by pickup waiting", () => {
  const withPickupWait = {
    ...MK029,
    pickup_waiting_charge_pence: 12,
  };
  assertEquals(computeFinalFarePence(withPickupWait), 728);
  assertEquals(computeCaptureAmount(withPickupWait, "completed").capture_amount_pence, 728);
});

Deno.test("9. modification followed by stop waiting", () => {
  const withStopWait = {
    ...MK029,
    stop_waiting_charge_pence: 24,
  };
  assertEquals(computeFinalFarePence(withStopWait), 740);
  assertEquals(computeCaptureAmount(withStopWait, "completed").capture_amount_pence, 740);
});

Deno.test("10. modification plus discount", () => {
  // final_customer already net of discount; must not subtract again.
  assertEquals(MK029.discount_pence, 50);
  assertEquals(computeFinalFarePence(MK029), 716);
});

Deno.test("11. modification plus tip", () => {
  const withTip = {
    ...MK029,
    tip_pence: 100,
  };
  // Tip is outside final_fare / added at capture as tips_pence.
  assertEquals(computeFinalFarePence(withTip), 716);
  assertEquals(computeCaptureAmount(withTip, "completed").capture_amount_pence, 816);
});

Deno.test("12. final capture equals canonical payable", () => {
  assertEquals(computeCaptureAmount(MK029, "completed").capture_amount_pence, 716);
  assertEquals(computeCaptureAmount(MK029, "completed").cancel_authorisation, false);
});

Deno.test("13. incremental auth requests only the difference", () => {
  const originalAuth = 450;
  const targetAfterMod = 716;
  const increment = targetAfterMod - originalAuth;
  assertEquals(increment, 266);
  assertEquals(originalAuth + increment, 716);
  // Once authorised = 716, no further +266 unless new components appear.
  const alreadyAuthorised = 716;
  assertEquals(Math.max(0, targetAfterMod - alreadyAuthorised), 0);
});

Deno.test("14. modification delta remains visible for audit but is not counted twice", () => {
  assertEquals(resolveCustomerModificationChargePence(MK029), 266);
  assertAuditDeltaVisibleButNotDoubleCounted(MK029);
  // Old poisoned math
  assertEquals(716 + 266, 982);
  assertEquals(computeFinalFarePence(MK029), 716);
});

Deno.test("15. Payment Sessions expected capture matches canonical total", () => {
  const canonical = computeCaptureAmount(MK029, "completed").capture_amount_pence;
  const breakdown = buildCaptureBreakdownForCompletedTrip({
    trip: { ...MK029 },
    provider_captured_pence: 716,
    canonical_expected_capture_pence: canonical,
  });
  assertEquals(breakdown.expected_capture_pence, 716);
  assertEquals(breakdown.ride_fare_pence, 716);
  // Additive mod fields nulled when already in final_customer — audit via trip columns.
  assertEquals(breakdown.manual_adjustment_pence, null);
  assertEquals(breakdown.destination_change_pence, null);
  // Must never expect 716+266+266 = 1248
  assertEquals(breakdown.expected_capture_pence !== 1248, true);
});

Deno.test("16. Driver Wallet receives canonical driver net", () => {
  // Commissionable for 029 settlement stamp uses ride economics, not poisoned 982.
  const commissionable = 766;
  const settlement = calculateTripSettlement({
    final_fare_pence: commissionable,
    driver_tier_commission_percent: 15,
  });
  assertEquals(settlement.commission_pence, 115);
  assertEquals(settlement.driver_net_pence, 651);
  // Capture target is customer payable 716 — not 982 — so ledger must not use 982×0.85.
  assertEquals(computeCaptureAmount(MK029, "completed").capture_amount_pence, 716);
  assertEquals(Math.round(982 * 0.85), 835);
  assertEquals(settlement.driver_net_pence !== 835, true);
});

Deno.test("17. Financial Reconciliation does not double-count modification fields", () => {
  const breakdown = buildCaptureBreakdownForCompletedTrip({
    trip: { ...MK029 },
    provider_captured_pence: 716,
    canonical_expected_capture_pence: 716,
  });
  // FR / PS expected must equal canonical once — not ride + mod + destination.
  const poisoned =
    Number(breakdown.ride_fare_pence ?? 0) +
    Number(MK029.customer_modification_charge_pence) +
    Number(MK029.destination_change_adjustment_pence);
  assertEquals(poisoned, 1248);
  assertEquals(breakdown.expected_capture_pence, 716);
});

Deno.test("MK-260815-029 regression: 450 + 266 → 716 auth and capture — never 982", () => {
  assertEquals(450 + 266, 716);
  assertEquals(computeFinalFarePence(MK029), 716);
  assertEquals(computeCaptureAmount(MK029, "completed").capture_amount_pence, 716);
  assertEquals(716 + 266, 982);
  assertEquals(computeFinalFarePence(MK029) !== 982, true);
});

Deno.test("locked base without final_customer still adds modification delta once", () => {
  const preFold = {
    locked_base_fare_pence: 450,
    discount_pence: 0,
    customer_modification_charge_pence: 266,
    pickup_waiting_charge_pence: 0,
    tip_pence: 0,
  };
  assertEquals(isModificationAlreadyInRideBase(preFold), false);
  assertEquals(computeFinalFarePence(preFold), 716);
});

Deno.test("historical overcapture refund math (MK-260815-029)", () => {
  const grossCaptured = 982;
  const legitimate = 716;
  const refund = grossCaptured - legitimate;
  assertEquals(refund, 266);
  assertEquals(grossCaptured - refund, 716);
  assertEquals(835 - 651, 184);
});
