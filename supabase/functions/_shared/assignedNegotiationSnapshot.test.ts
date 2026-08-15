import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assignedNegotiationSuccessBody,
  buildAssignedNegotiationSnapshot,
} from "./assignedNegotiationSnapshot.ts";

Deno.test("assigned snapshot uses agreed fare, same driver ids, and closed negotiation", () => {
  const snap = buildAssignedNegotiationSnapshot({
    id: "trip-z",
    status: "driver_assigned",
    dispatch_status: "assigned",
    driver_id: "drv-owner",
    confirmed_driver_id: "drv-owner",
    negotiation_owner_driver_id: null,
    fare: 6.45,
    gross_fare_pence: 645,
    final_fare_pence: 645,
    final_customer_fare_pence: 645,
    fare_locked: true,
    commission_pence: 97,
    driver_net_pence: 548,
    driver_tier_commission_percent: 15,
    fare_snapshot_json: { fare_source: "customer_counter_offer" },
  });
  assertEquals(snap?.trip_id, "trip-z");
  assertEquals(snap?.status, "driver_assigned");
  assertEquals(snap?.driver_id, "drv-owner");
  assertEquals(snap?.confirmed_driver_id, "drv-owner");
  assertEquals(snap?.final_fare_pence, 645);
  assertEquals(snap?.final_customer_fare_pence, 645);
  assertEquals(snap?.driver_net_pence, 548);
  assertEquals(snap?.fare_source, "customer_counter_offer");
  assertEquals(snap?.negotiation_status, "closed");
});

Deno.test("assigned snapshot does not restore quote or driver-offer fare when final is £Z", () => {
  const snap = buildAssignedNegotiationSnapshot({
    id: "trip-y",
    status: "accepted",
    driver_id: "drv-1",
    final_fare_pence: 695,
    final_customer_fare_pence: 695,
    fare: 6.95,
    driver_net_pence: 591,
    fare_snapshot_json: { fare_source: "negotiated_offer", quote_fare_pence: 495 },
  }, { fareSource: "negotiated_offer" });
  assertEquals(snap?.final_fare_pence, 695);
  assertEquals(snap?.fare_source, "negotiated_offer");
  assertEquals(snap?.confirmed_driver_id, "drv-1");
});

Deno.test("agreement success body is one assigned snapshot for both apps", () => {
  const snap = buildAssignedNegotiationSnapshot({
    id: "trip-z",
    status: "driver_assigned",
    dispatch_status: "assigned",
    driver_id: "drv-owner",
    confirmed_driver_id: "drv-owner",
    final_fare_pence: 645,
    final_customer_fare_pence: 645,
    driver_net_pence: 548,
    fare_snapshot_json: { fare_source: "customer_counter_offer" },
  });
  const body = assignedNegotiationSuccessBody({
    tripId: "trip-z",
    offerId: "offer-z",
    driverId: "drv-owner",
    snapshot: snap,
    fallbackFarePence: 645,
    fallbackFareSource: "customer_counter_offer",
  });
  assertEquals(body.success, true);
  assertEquals(body.action, "ACCEPTED");
  assertEquals(body.status, "driver_assigned");
  assertEquals(body.driver_id, "drv-owner");
  assertEquals(body.confirmed_driver_id, "drv-owner");
  assertEquals(body.final_fare_pence, 645);
  assertEquals(body.driver_net_pence, 548);
  assertEquals(body.negotiation_status, "closed");
  assertEquals((body.trip as { status: string }).status, "driver_assigned");
});
