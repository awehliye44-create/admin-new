/**
 * Live fare projection lock: a modification delta already folded into the
 * committed fare must never be added again, and discounts/vouchers must not
 * break fold detection.
 *
 * Run: deno test --allow-read supabase/functions/_shared/liveTripFareSSOT.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeLiveTripFarePreview } from "./liveTripFareSSOT.ts";

/**
 * MK-260816-002 production row, post-fold.
 * locked base 749 + modification 364 = gross 1113, minus 74 offer discount
 * => committed net payable 1039.
 */
const MK_260816_002 = {
  final_customer_fare_pence: 1039,
  final_fare_pence: 1039,
  locked_base_fare_pence: 749,
  customer_modification_charge_pence: 364,
  modification_delta_pence: 364,
  gross_fare_pence: 1113,
  offer_discount_pence: 74,
  pickup_waiting_charge_pence: 0,
  stop_waiting_charge_pence: 0,
  stop_charge_total_pence: 0,
};

Deno.test("A. MK-260816-002 discounted post-fold: committed delta is not re-added", () => {
  const preview = computeLiveTripFarePreview(MK_260816_002);

  assertEquals(preview.approved_modification_delta_pence, 0);
  assertEquals(preview.current_customer_total_pence, 1039);
  // The regression this locks: 1039 + 364 = 1403 (£14.03) on the Customer card.
  assertEquals(preview.current_customer_total_pence === 1403, false);
});

Deno.test("B. undiscounted post-fold: total is gross, delta not re-added", () => {
  const preview = computeLiveTripFarePreview({
    final_customer_fare_pence: 1113,
    final_fare_pence: 1113,
    locked_base_fare_pence: 749,
    customer_modification_charge_pence: 364,
    modification_delta_pence: 364,
    gross_fare_pence: 1113,
  });

  assertEquals(preview.approved_modification_delta_pence, 0);
  assertEquals(preview.current_customer_total_pence, 1113);
});

Deno.test("C. pre-fold: approved delta is applied exactly once (675 + 364 = 1039)", () => {
  const preview = computeLiveTripFarePreview({
    final_customer_fare_pence: 675,
    final_fare_pence: 675,
    locked_base_fare_pence: 749,
    customer_modification_charge_pence: 364,
    modification_delta_pence: 364,
    gross_fare_pence: 749,
  });

  assertEquals(preview.approved_modification_delta_pence, 364);
  assertEquals(preview.current_customer_total_pence, 1039);
});

Deno.test("D. idempotent: re-projecting a committed total never grows it", () => {
  const first = computeLiveTripFarePreview(MK_260816_002);
  const second = computeLiveTripFarePreview({
    ...MK_260816_002,
    final_customer_fare_pence: first.current_customer_total_pence,
    final_fare_pence: first.current_customer_total_pence,
  });
  const third = computeLiveTripFarePreview({
    ...MK_260816_002,
    final_customer_fare_pence: second.current_customer_total_pence,
    final_fare_pence: second.current_customer_total_pence,
  });

  assertEquals(first.current_customer_total_pence, 1039);
  assertEquals(second.current_customer_total_pence, 1039);
  assertEquals(third.current_customer_total_pence, 1039);
});

Deno.test("second modification previews from 1039, not the inflated 1403", () => {
  // request-trip-modification: newCustomerTotalPence = live total + fare delta.
  const liveBase = computeLiveTripFarePreview(MK_260816_002).current_customer_total_pence;
  assertEquals(liveBase, 1039);

  const secondModDeltaPence = 250;
  assertEquals(liveBase + secondModDeltaPence, 1289);
  // Pre-fix this quoted 1403 + 250 = 1653.
  assertEquals(liveBase + secondModDeltaPence === 1653, false);
});

Deno.test("shorter destination reduces from the corrected base", () => {
  const liveBase = computeLiveTripFarePreview(MK_260816_002).current_customer_total_pence;

  const shorterRouteDeltaPence = -200;
  assertEquals(liveBase + shorterRouteDeltaPence, 839);
  // Pre-fix a genuine reduction still looked like an increase over 675.
  assertEquals(liveBase + shorterRouteDeltaPence === 1203, false);
});

Deno.test("driver net preview uses the corrected total", () => {
  const preview = computeLiveTripFarePreview({
    ...MK_260816_002,
    accepted_commission_percent: 15,
  });

  assertEquals(preview.current_customer_total_pence, 1039);
  assertEquals(preview.commission_percent, 15);
  assertEquals(preview.driver_net_preview_pence, 883); // round(1039 × 0.85)
  assertEquals(preview.driver_net_preview_pence === 1193, false); // round(1403 × 0.85)
});

Deno.test("waiting charges still stack on top of the corrected total", () => {
  const preview = computeLiveTripFarePreview({
    ...MK_260816_002,
    pickup_waiting_charge_pence: 120,
    stop_waiting_charge_pence: 80,
  });

  assertEquals(preview.approved_modification_delta_pence, 0);
  assertEquals(preview.current_customer_total_pence, 1239);
});

Deno.test("no gross_fare_pence falls back to confirmed-fare fold detection", () => {
  const folded = computeLiveTripFarePreview({
    final_customer_fare_pence: 1113,
    locked_base_fare_pence: 749,
    modification_delta_pence: 364,
    gross_fare_pence: null,
  });
  assertEquals(folded.approved_modification_delta_pence, 0);
  assertEquals(folded.current_customer_total_pence, 1113);

  const notFolded = computeLiveTripFarePreview({
    final_customer_fare_pence: 749,
    locked_base_fare_pence: 749,
    modification_delta_pence: 364,
    gross_fare_pence: null,
  });
  assertEquals(notFolded.approved_modification_delta_pence, 364);
  assertEquals(notFolded.current_customer_total_pence, 1113);
});

Deno.test("unmodified trip is unaffected", () => {
  const preview = computeLiveTripFarePreview({
    final_customer_fare_pence: 675,
    locked_base_fare_pence: 749,
    gross_fare_pence: 749,
    modification_delta_pence: 0,
  });

  assertEquals(preview.approved_modification_delta_pence, 0);
  assertEquals(preview.current_customer_total_pence, 675);
});

Deno.test("LOCK: fold detection compares on the gross basis, never confirmed fare alone", async () => {
  const src = await Deno.readTextFile(new URL("./liveTripFareSSOT.ts", import.meta.url));

  assertEquals(src.includes("const grossFare = nonNeg(trip.gross_fare_pence);"), true);
  assertEquals(src.includes("const foldBasis = grossFare > 0 ? grossFare : confirmedFare;"), true);
  assertEquals(src.includes("foldBasis >= lockedBase + modStored - 1"), true);
  // The reverted form that re-added a committed delta on every discounted trip.
  assertEquals(src.includes("confirmedFare >= lockedBase + modStored - 1"), false);
  // Signed cumulative must not be coerced through nonNeg (MK-260816-004).
  assertEquals(
    src.includes(
      "nonNeg(trip.customer_modification_charge_pence) || nonNeg(trip.modification_delta_pence)",
    ),
    false,
  );
  assertEquals(src.includes("resolveModificationStoredPence"), true);
});

/**
 * MK-260816-004 after Work (−375) then MK9 (+266):
 * cumulative charge −109, committed net 679, gross 766.
 * Pre-fix nonNeg(−109) fell through to modification_delta 266 and
 * re-added → 679+266=945 on the Customer card.
 */
Deno.test("MK-260816-004 signed cumulative: never re-add last positive delta", () => {
  const preview = computeLiveTripFarePreview({
    final_customer_fare_pence: 679,
    final_fare_pence: 679,
    locked_base_fare_pence: 875,
    customer_modification_charge_pence: -109,
    modification_delta_pence: 266,
    gross_fare_pence: 766,
  });

  assertEquals(preview.approved_modification_delta_pence, 0);
  assertEquals(preview.current_customer_total_pence, 679);
  assertEquals(preview.current_customer_total_pence === 945, false);
});
