/**
 * bookingCanonicalTripLookupSSOT — CTAP-inflight fast adopt identity gate.
 * Discovery only. Never mutates payment/wallet/trip.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  evaluateBookingCanonicalTripLookup,
  type BookingCanonicalTripRow,
} from "./bookingCanonicalTripLookupSSOT.ts";

function baseTrip(over: Partial<BookingCanonicalTripRow> = {}): BookingCanonicalTripRow {
  return {
    id: "trip-1",
    trip_code: "MK1",
    status: "searching",
    dispatch_status: "searching",
    dispatch_mode: "instant",
    pickup_address: "A",
    dropoff_address: "B",
    pickup_latitude: 52.0,
    pickup_longitude: -0.7,
    dropoff_latitude: 52.1,
    dropoff_longitude: -0.8,
    service_area_id: "sa-1",
    vehicle_type_id: "vt-1",
    created_at: "2026-09-26T17:22:30.000Z",
    searching_expires_at: "2099-01-01T00:00:00.000Z",
    passenger_id: "cust-1",
    client_action_id: "cai-1",
    is_scheduled: false,
    scheduled_at: null,
    scheduled_status: null,
    payment_session_id: "ps-1",
    ...over,
  };
}

Deno.test("fast adopt: owned searching trip by CAI succeeds without reverse link", () => {
  const r = evaluateBookingCanonicalTripLookup({
    clientActionId: "cai-1",
    customerId: "cust-1",
    trip: baseTrip({ payment_session_id: null }),
  });
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.seed.trip_id, "trip-1");
    assertEquals(r.seed.client_action_id, "cai-1");
    assertEquals(r.seed.payment_session_id, null);
  }
});

Deno.test("fast adopt: wrong customer rejected", () => {
  const r = evaluateBookingCanonicalTripLookup({
    clientActionId: "cai-1",
    customerId: "other",
    trip: baseTrip(),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "ownership_mismatch");
});

Deno.test("fast adopt: CAI mismatch rejected", () => {
  const r = evaluateBookingCanonicalTripLookup({
    clientActionId: "cai-other",
    customerId: "cust-1",
    trip: baseTrip(),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "client_action_id_mismatch");
});

Deno.test("fast adopt: not found", () => {
  const r = evaluateBookingCanonicalTripLookup({
    clientActionId: "cai-1",
    customerId: "cust-1",
    trip: null,
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "not_found");
});

Deno.test("fast adopt: terminal trip rejected", () => {
  const r = evaluateBookingCanonicalTripLookup({
    clientActionId: "cai-1",
    customerId: "cust-1",
    trip: baseTrip({ status: "completed" }),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "terminal_or_empty_status");
});

Deno.test("fast adopt: expired searching rejected", () => {
  const r = evaluateBookingCanonicalTripLookup({
    clientActionId: "cai-1",
    customerId: "cust-1",
    trip: baseTrip({ searching_expires_at: "2020-01-01T00:00:00.000Z" }),
    nowMs: Date.parse("2026-09-26T17:22:30.000Z"),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "search_expired");
});
