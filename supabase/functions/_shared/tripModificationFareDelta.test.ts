/**
 * Modification fare delta lock — MK-260816-002 regression.
 *
 * All route fares below are real values returned by ONECAB's own
 * calculate-route + calculate-fare for the Milton Keynes ONECAB GO config
 * (base £3.00, minimum £5.00, banded distance pricing).
 *
 * Run: deno test --allow-read supabase/functions/_shared/tripModificationFareDelta.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeModificationFareDelta } from "./tripModificationFareDelta.ts";

/** Priced from the Driver's real position (~10m from pickup). */
const DRIVER_TO_LIDL = 1224; // 13670 m
const DRIVER_TO_WORK = 500; //  2186 m, floored to the £5.00 minimum

/** Priced from the OLD DESTINATION — the bug this locks out. */
const LIDL_TO_LIDL = 500; // 0 m, floored to the £5.00 minimum
const LIDL_TO_WORK = 1076; // 11966 m

Deno.test("A. shorter remaining route yields a negative delta and a lower fare", () => {
  const result = computeModificationFareDelta({
    currentConfirmedFarePence: 1039,
    oldRemainingRouteFarePence: DRIVER_TO_LIDL,
    newRemainingRouteFarePence: DRIVER_TO_WORK,
  });

  assertEquals(result.fareDeltaPence, -724);
  assertEquals(result.newFarePence, 315);
  // The old origin bug produced +576 for this exact modification.
  assertEquals(result.fareDeltaPence === 576, false);
});

Deno.test("B. farther remaining route yields a positive delta", () => {
  const result = computeModificationFareDelta({
    currentConfirmedFarePence: 1039,
    oldRemainingRouteFarePence: DRIVER_TO_WORK,
    newRemainingRouteFarePence: DRIVER_TO_LIDL,
  });

  assertEquals(result.fareDeltaPence, 724);
  assertEquals(result.newFarePence, 1763);
  assertEquals(result.paymentRequired, true);
});

Deno.test("C. same destination yields a zero delta and an unchanged fare", () => {
  const result = computeModificationFareDelta({
    currentConfirmedFarePence: 1039,
    oldRemainingRouteFarePence: DRIVER_TO_WORK,
    newRemainingRouteFarePence: DRIVER_TO_WORK,
  });

  assertEquals(result.fareDeltaPence, 0);
  assertEquals(result.newFarePence, 1039);
  assertEquals(result.paymentRequired, false);
});

Deno.test("J. negative delta requires no incremental authorisation", () => {
  const result = computeModificationFareDelta({
    currentConfirmedFarePence: 1039,
    oldRemainingRouteFarePence: DRIVER_TO_LIDL,
    newRemainingRouteFarePence: DRIVER_TO_WORK,
  });

  assertEquals(result.fareDeltaPence < 0, true);
  assertEquals(result.paymentRequired, false);
});

Deno.test("K. positive delta still requests the canonical increment", () => {
  const result = computeModificationFareDelta({
    currentConfirmedFarePence: 675,
    oldRemainingRouteFarePence: 500,
    newRemainingRouteFarePence: 864,
  });

  assertEquals(result.fareDeltaPence, 364);
  assertEquals(result.newFarePence, 1039);
  assertEquals(result.paymentRequired, true);
});

Deno.test("I. second modification starts from the current committed fare", () => {
  const first = computeModificationFareDelta({
    currentConfirmedFarePence: 675,
    oldRemainingRouteFarePence: 500,
    newRemainingRouteFarePence: 864,
  });
  assertEquals(first.newFarePence, 1039);

  const second = computeModificationFareDelta({
    currentConfirmedFarePence: first.newFarePence,
    oldRemainingRouteFarePence: DRIVER_TO_LIDL,
    newRemainingRouteFarePence: DRIVER_TO_WORK,
  });

  assertEquals(second.fareDeltaPence, -724);
  assertEquals(second.newFarePence, 315);
  // Never compounds off the poisoned live projection (1403) or the old origin.
  assertEquals(second.newFarePence === 1615, false);
  assertEquals(second.newFarePence === 1979, false);
});

Deno.test("L. review arithmetic holds: newFare - previousFare === difference", () => {
  const currentConfirmedFarePence = 1039;
  const result = computeModificationFareDelta({
    currentConfirmedFarePence,
    oldRemainingRouteFarePence: DRIVER_TO_LIDL,
    newRemainingRouteFarePence: DRIVER_TO_WORK,
  });

  // The three review-screen values, all on the committed payable basis.
  const previousFarePence = currentConfirmedFarePence;
  const newFarePence = result.newFarePence;
  const differencePence = result.fareDeltaPence;

  assertEquals(newFarePence - previousFarePence, differencePence);

  // Positive case too.
  const up = computeModificationFareDelta({
    currentConfirmedFarePence: 675,
    oldRemainingRouteFarePence: 500,
    newRemainingRouteFarePence: 864,
  });
  assertEquals(up.newFarePence - 675, up.fareDeltaPence);
});

Deno.test("origin bug reproduction stays fixed: old-destination pricing is not the model", () => {
  // What the old code did for modification #2.
  const buggy = computeModificationFareDelta({
    currentConfirmedFarePence: 1039,
    oldRemainingRouteFarePence: LIDL_TO_LIDL,
    newRemainingRouteFarePence: LIDL_TO_WORK,
  });
  assertEquals(buggy.fareDeltaPence, 576);
  assertEquals(buggy.newFarePence, 1615);

  // What the correct origin produces.
  const correct = computeModificationFareDelta({
    currentConfirmedFarePence: 1039,
    oldRemainingRouteFarePence: DRIVER_TO_LIDL,
    newRemainingRouteFarePence: DRIVER_TO_WORK,
  });
  assertEquals(correct.fareDeltaPence, -724);

  // £13.00 apart on a single modification.
  assertEquals(buggy.fareDeltaPence - correct.fareDeltaPence, 1300);
});

Deno.test("fare total never drops below 1p", () => {
  const result = computeModificationFareDelta({
    currentConfirmedFarePence: 500,
    oldRemainingRouteFarePence: 2000,
    newRemainingRouteFarePence: 500,
  });

  assertEquals(result.fareDeltaPence, -1500);
  assertEquals(result.newFarePence, 1);
});

Deno.test("M. distance band pricing is supplied by the fare engine, not recomputed here", async () => {
  const src = await Deno.readTextFile(
    new URL("./tripModificationFareDelta.ts", import.meta.url),
  );

  // Route fares arrive from calculate-fare; no local rate/band arithmetic.
  assertEquals(/perKmRate|perMileRate|baseFare|minimumFare|band/i.test(src), false);
});
