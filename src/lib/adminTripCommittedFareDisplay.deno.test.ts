/// <reference lib="deno.ns" />
/**
 * Admin committed fare display + live preview parity locks.
 * Run: deno test --allow-read src/lib/adminTripCommittedFareDisplay.deno.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  formatAdminCommittedCustomerFare,
  resolveAdminCommittedCustomerFarePence,
  resolveAdminCommittedCustomerFareSource,
} from "./adminTripCommittedFareDisplay.ts";
import { computeLiveTripFarePreview } from "./liveTripFareSSOT.ts";

Deno.test("G. cancelled modified trip uses canonical final, not estimated_fare", () => {
  const trip = {
    final_customer_fare_pence: 699,
    final_fare_pence: 699,
    estimated_fare: 4.5,
    customer_modification_charge_pence: 249,
  };
  assertEquals(resolveAdminCommittedCustomerFarePence(trip), 699);
  assertEquals(formatAdminCommittedCustomerFare(trip, "£"), "£6.99");
  assertEquals(resolveAdminCommittedCustomerFareSource(trip), "final_customer_fare_pence");
});

Deno.test("H. scheduled revised trip uses canonical revised fare", () => {
  const trip = {
    final_customer_fare_pence: 1039,
    estimated_fare: 6.75,
    gross_fare_pence: 1113,
    offer_discount_pence: 74,
  };
  assertEquals(resolveAdminCommittedCustomerFarePence(trip), 1039);
});

Deno.test("I. pre-commit scheduled trip falls back to estimated_fare", () => {
  const trip = {
    estimated_fare: 12.5,
    fare: 12.5,
  };
  assertEquals(resolveAdminCommittedCustomerFarePence(trip), 1250);
  assertEquals(resolveAdminCommittedCustomerFareSource(trip), "fare_column");
});

Deno.test("J. same modified trip matches committed fare on list surfaces", () => {
  const trip = {
    final_customer_fare_pence: 1039,
    final_fare_pence: 1039,
    locked_base_fare_pence: 749,
    customer_modification_charge_pence: 364,
    gross_fare_pence: null,
    offer_discount_pence: null,
  };
  const committed = resolveAdminCommittedCustomerFarePence(trip);
  const live = computeLiveTripFarePreview({
    ...trip,
    modification_delta_pence: 364,
  });
  assertEquals(committed, 1039);
  assertEquals(live.current_customer_total_pence, 1039);
});

Deno.test("E. promo + modification — committed fare once, live preview not inflated", () => {
  const trip = {
    final_customer_fare_pence: 699,
    locked_base_fare_pence: 500,
    customer_modification_charge_pence: 249,
    gross_fare_pence: 699,
    offer_discount_pence: 50,
  };
  assertEquals(resolveAdminCommittedCustomerFarePence(trip), 699);
  const live = computeLiveTripFarePreview(trip);
  assertEquals(live.current_customer_total_pence, 699);
  assertEquals(live.approved_modification_delta_pence, 0);
});

Deno.test("F. active waiting adds only legitimate waiting on top of committed fare", () => {
  const live = computeLiveTripFarePreview({
    final_customer_fare_pence: 1039,
    locked_base_fare_pence: 749,
    customer_modification_charge_pence: 364,
    gross_fare_pence: 1113,
    offer_discount_pence: 74,
    pickup_waiting_charge_pence: 120,
    stop_waiting_charge_pence: 80,
  });
  assertEquals(live.current_customer_total_pence, 1239);
});
