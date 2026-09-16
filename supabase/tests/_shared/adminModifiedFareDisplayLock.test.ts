/**
 * Admin modified-fare display lock — list surfaces + live preview parity.
 * Run: deno test --allow-read supabase/functions/_shared/adminModifiedFareDisplayLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeLiveTripFarePreview } from "./liveTripFareSSOT.ts";

const MK_260816_002_GROSS_NULL = {
  final_customer_fare_pence: 1039,
  final_fare_pence: 1039,
  locked_base_fare_pence: 749,
  customer_modification_charge_pence: 364,
  gross_fare_pence: null as number | null,
  pickup_waiting_charge_pence: 0,
  stop_waiting_charge_pence: 0,
};

Deno.test("LOCK A. gross=null + mod +364 + final 1039 → 1039", () => {
  const preview = computeLiveTripFarePreview(MK_260816_002_GROSS_NULL);
  assertEquals(preview.current_customer_total_pence, 1039);
  assertEquals(preview.approved_modification_delta_pence, 0);
});

Deno.test("LOCK E. promo + modification — payable once", () => {
  const preview = computeLiveTripFarePreview({
    final_customer_fare_pence: 699,
    locked_base_fare_pence: 500,
    customer_modification_charge_pence: 249,
    gross_fare_pence: 699,
    offer_discount_pence: 50,
  });
  assertEquals(preview.current_customer_total_pence, 699);
  assertEquals(preview.approved_modification_delta_pence, 0);
});

Deno.test("LOCK: all four Admin list surfaces import adminTripCommittedFareDisplay", async () => {
  for (const page of ["ActiveTrips", "MissedCancelled", "ScheduledRides", "TripHistory"]) {
    const src = await Deno.readTextFile(
      new URL(`../../../src/pages/${page}.tsx`, import.meta.url),
    );
    assertEquals(src.includes("adminTripCommittedFareDisplay"), true, page);
  }
  for (const page of ["ActiveTrips", "MissedCancelled", "ScheduledRides"]) {
    const src = await Deno.readTextFile(
      new URL(`../../../src/pages/${page}.tsx`, import.meta.url),
    );
    assertEquals(
      src.includes("estimated_fare.toFixed") || src.includes("trip.estimated_fare ?? 0)"),
      false,
      `${page} raw estimated display`,
    );
  }
});

Deno.test("LOCK: frontend and edge liveTripFareSSOT stay in sync", async () => {
  const frontend = await Deno.readTextFile(
    new URL("../../../src/lib/liveTripFareSSOT.ts", import.meta.url),
  );
  const edge = await Deno.readTextFile(new URL("./liveTripFareSSOT.ts", import.meta.url));
  assertEquals(frontend, edge);
});

Deno.test("LOCK: committed fare defaults audit-only when metadata missing", async () => {
  const src = await Deno.readTextFile(new URL("./liveTripFareSSOT.ts", import.meta.url));
  assertEquals(src.includes("Committed canonical fare — modification is audit-only"), true);
  assertEquals(src.includes("confirmedFare + modStored"), false);
});
