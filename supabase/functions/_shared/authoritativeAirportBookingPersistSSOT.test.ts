/**
 * Actual execution tests — authoritative airport split from server_fare_quotes.
 * Covers Instant/Scheduled route-priced airport, standard airport amounts,
 * zero airport, enrich preserve, CTAP/webhook readiness gates.
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFareBreakdownFromServerFareQuote,
  bookingFareSplitFromQuote,
  driverNetFromCustomerTotal,
  resolveAirportPenceForPostCommitEnrich,
  resolveAuthoritativeAirportSplitFromServerFareQuote,
  type ServerFareQuoteAirportAuthority,
} from "./airportChargeFareSplitSSOT.ts";
import {
  evaluateAirportPersistReadiness,
  resolveServerFareQuoteIdFromSession,
  stampTripInsertAirportAuthority,
} from "./authoritativeAirportBookingPersistSSOT.ts";
import { applyBookingFinancialSnapshotToTripData } from "./tripDisplayFareSSOT.ts";

const USER = "5e980515-c7d7-4ee2-bb5f-e8ba5406b085";
const SA = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";
const VT = "a5c59e9b-ed66-4dd1-8043-1f4730691c12";
const QUOTE_ID = "348c0d50-e47f-48c6-ba9c-ecd346271cac";

function mkQuote(overrides: Partial<ServerFareQuoteAirportAuthority> = {}): ServerFareQuoteAirportAuthority {
  return {
    id: QUOTE_ID,
    user_id: USER,
    vehicle_type_id: VT,
    service_area_id: SA,
    route_key: "p:51.99246,-0.80019|s:|d:51.87291,-0.39619",
    gross_fare_pence: 4200,
    airport_charge_pence: 900,
    pricing_evidence: {
      trip_fare: 33,
      airport_charge: 9,
      matched_route_id: "93285a46-0cd3-468e-a8cf-37676297dd85",
      zone_applied: "MK  → LUTON AIRPORT",
    },
    pricing_mode: "ROUTE_PRICING",
    fare_source: "route_fixed",
    ...overrides,
  };
}

Deno.test("MK-261112-010 shape: 4200 / 3300 / 900 → driver net 3870 at 10%", () => {
  const quote = mkQuote();
  const resolved = resolveAuthoritativeAirportSplitFromServerFareQuote({
    quote,
    userId: USER,
    vehicleTypeId: VT,
    serviceAreaId: SA,
    payablePence: 4200,
  });
  assertEquals(resolved.ok, true);
  if (!resolved.ok) return;
  assertEquals(resolved.airportChargePence, 900);
  assertEquals(resolved.commissionableFarePence, 3300);
  const net = driverNetFromCustomerTotal({
    customerPence: 4200,
    airportPence: 900,
    commissionPercent: 10,
  });
  assertEquals(net.commissionablePence, 3300);
  assertEquals(net.commissionPence, 330);
  assertEquals(net.driverNetPence, 3870); // 2970 + 900
});

Deno.test("different configured airport amounts stay dynamic (no hardcode)", () => {
  for (const airport of [500, 700, 900, 1200]) {
    const gross = 3000 + airport;
    const resolved = resolveAuthoritativeAirportSplitFromServerFareQuote({
      quote: mkQuote({
        gross_fare_pence: gross,
        airport_charge_pence: airport,
        pricing_evidence: { trip_fare: 30, airport_charge: airport / 100 },
      }),
      userId: USER,
      vehicleTypeId: VT,
      serviceAreaId: SA,
      payablePence: gross,
    });
    assert(resolved.ok);
    if (!resolved.ok) continue;
    assertEquals(resolved.airportChargePence, airport);
    assertEquals(resolved.commissionableFarePence, 3000);
  }
});

Deno.test("zero airport charge — fail open, no hold", () => {
  const resolved = resolveAuthoritativeAirportSplitFromServerFareQuote({
    quote: mkQuote({
      airport_charge_pence: 0,
      gross_fare_pence: 2500,
      pricing_evidence: { trip_fare: 25, airport_charge: 0 },
    }),
    userId: USER,
    vehicleTypeId: VT,
    serviceAreaId: SA,
    payablePence: 2500,
  });
  assertEquals(resolved.ok, true);
  if (!resolved.ok) return;
  assertEquals(resolved.requiresAirportPersist, false);
  const readiness = evaluateAirportPersistReadiness(resolved);
  assertEquals(readiness.holdBroadcast, false);
  assertEquals(readiness.allowDispatch, true);
});

Deno.test("mismatched vehicle / user — fail closed when airport required", () => {
  const badVehicle = resolveAuthoritativeAirportSplitFromServerFareQuote({
    quote: mkQuote(),
    userId: USER,
    vehicleTypeId: "11111111-1111-4111-8111-111111111111",
    serviceAreaId: SA,
    payablePence: 4200,
  });
  assertEquals(badVehicle.ok, false);
  const readiness = evaluateAirportPersistReadiness(badVehicle);
  assertEquals(readiness.holdBroadcast, true);
  assertEquals(readiness.allowDispatch, false);
});

Deno.test("post-commit enrich cannot overwrite authoritative airport with zero", () => {
  const r = resolveAirportPenceForPostCommitEnrich({
    existingAirportChargePence: 900,
    recalculatedAirportPence: 0,
    authoritativeQuoteAirportPence: 900,
  });
  assertEquals(r.preserveExisting, true);
  assertEquals(r.airportPenceForPatch, 900);
  assertEquals(r.quoteAirportPenceForDispatchGate, 900);
});

Deno.test("post-commit uses authoritative quote when existing is zero", () => {
  const r = resolveAirportPenceForPostCommitEnrich({
    existingAirportChargePence: 0,
    recalculatedAirportPence: 0,
    authoritativeQuoteAirportPence: 900,
  });
  assertEquals(r.preserveExisting, false);
  assertEquals(r.airportPenceForPatch, 900);
});

Deno.test("session fare_snapshot resolves server_fare_quote_id", () => {
  const id = resolveServerFareQuoteIdFromSession({
    sessionFareSnapshot: { server_fare_quote_id: QUOTE_ID, final_fare_pence: 4200 },
  });
  assertEquals(id, QUOTE_ID);
});

Deno.test("financial snapshot stamps airport from authoritative breakdown (CTAP/webhook shared)", () => {
  const quote = mkQuote();
  const breakdown = buildFareBreakdownFromServerFareQuote(quote);
  const split = bookingFareSplitFromQuote({ payablePence: 4200, fareBreakdown: breakdown });
  assert(split);
  const tripData: Record<string, unknown> = {};
  applyBookingFinancialSnapshotToTripData(tripData, { final_fare_pence: 4200 }, {
    grossFarePence: 4200,
    finalPayableFarePence: 4200,
    pricingSource: "booking_ssot_minimal_commit",
    authoritativeFareBreakdown: breakdown,
  });
  assertEquals(tripData.airport_charge_pence, 900);
  assertEquals(tripData.commissionable_fare_pence, 3300);
  assertEquals((tripData.fare_breakdown as { airport_charge_pence: number }).airport_charge_pence, 900);
  assertEquals(
    (tripData.fare_snapshot_json as { server_fare_quote_id: string }).server_fare_quote_id,
    QUOTE_ID,
  );
});

Deno.test("airport persist failure stamps airport_pricing hold on insert row", () => {
  const tripData: Record<string, unknown> = { scheduled_hold_reason: "publication_pending" };
  stampTripInsertAirportAuthority(tripData, {
    split: null,
    requiredAirportPence: 900,
    holdBroadcast: true,
    allowDispatch: false,
    reason: "quote_mismatch",
  });
  assertEquals(tripData.broadcast_enabled, false);
  assertEquals(tripData.scheduled_hold_reason, "airport_pricing");
});

Deno.test("no double-add: driverNet = journey + airport once", () => {
  const net = driverNetFromCustomerTotal({
    customerPence: 4200,
    airportPence: 900,
    commissionPercent: 10,
  });
  // Journey after commission + airport once — never (net + airport) again.
  assertEquals(net.driverNetPence, (3300 - 330) + 900);
  assertEquals(net.driverNetPence + 900 !== net.driverNetPence + 900 + 900, true);
});
