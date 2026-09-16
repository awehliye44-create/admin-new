import {
  assertEquals,
  assertEquals as eq,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseStopsFromFareQuoteId,
  resolveBookingIntermediateStops,
  totalStopsFromIntermediateCount,
} from "./fareQuoteStops.ts";
import { buildMinimalTripInsertRow } from "./bookingSSOT.ts";

Deno.test("parseStopsFromFareQuoteId: reads one via from fingerprint", () => {
  const fq =
    "pickup=current-location:51.97,-0.76;dest=saved:saved-home:51.99,-0.80;stops=ChIJ4Vm9s-n_dkgR0dmR70abKK4:52.005446,-0.792304;mode=now;sched=";
  const stops = parseStopsFromFareQuoteId(fq);
  assertEquals(stops.length, 1);
  assertEquals(stops[0].lat, 52.005446);
  assertEquals(stops[0].lng, -0.792304);
});

Deno.test("parseStopsFromFareQuoteId: empty stops= yields none", () => {
  assertEquals(
    parseStopsFromFareQuoteId(
      "pickup=a:1,2;dest=b:3,4;stops=;mode=now;sched=",
    ).length,
    0,
  );
});

Deno.test("resolveBookingIntermediateStops: body wins over fare quote", () => {
  const stops = resolveBookingIntermediateStops({
    bodyStops: [{ address: "Cafe", lat: 52.01, lng: -0.79 }],
    fareQuoteId:
      "stops=ChIJOther:52.00,-0.80;mode=now",
  });
  assertEquals(stops.length, 1);
  assertEquals(stops[0].address, "Cafe");
});

Deno.test("resolveBookingIntermediateStops: recovers from fare_quote_id when body empty", () => {
  const stops = resolveBookingIntermediateStops({
    bodyStops: [],
    fareQuoteId:
      "pickup=x:1,1;dest=y:2,2;stops=ChIJVia:52.005446,-0.792304;mode=now;sched=",
  });
  assertEquals(stops.length, 1);
  assertEquals(stops[0].lat, 52.005446);
});

Deno.test("totalStopsFromIntermediateCount: pickup + vias + dropoff", () => {
  assertEquals(totalStopsFromIntermediateCount(0), 2);
  assertEquals(totalStopsFromIntermediateCount(1), 3);
  assertEquals(totalStopsFromIntermediateCount(2), 4);
});

Deno.test("buildMinimalTripInsertRow: recovers vias from session fare_quote_id", () => {
  const body = {
    client_action_id: "ca-stops-1",
    pickup: { address: "A", lat: 51.97, lng: -0.76 },
    dropoff: { address: "B", lat: 51.99, lng: -0.8 },
    stops: [] as Array<{ address: string; lat: number; lng: number }>,
    when: "NOW" as const,
    estimated_fare: 9.11,
    payment_method: "APPLE_PAY",
  };
  const row = buildMinimalTripInsertRow({
    body,
    customerId: "cust-1",
    serviceAreaId: "sa-1",
    serviceAreaCode: "MK",
    regionId: "reg-1",
    regionCurrencyCode: "GBP",
    regionDistanceUnit: "miles",
    paymentProvider: "revolut",
    paymentRefId: "ord-1",
    preauthAmountPence: 911,
    paymentSessionId: "ps-1",
    sessionFareSnapshot: {
      fare_quote_id:
        "pickup=current-location:51.97,-0.76;dest=saved:saved-home:51.99,-0.80;stops=ChIJVia:52.005446,-0.792304;mode=now;sched=",
      final_fare_pence: 911,
      gross_fare_pence: 911,
    },
  });
  eq(row.total_stops, 3);
  eq(Array.isArray(row.stops), true);
  eq((row.stops as unknown[]).length, 1);
  eq(body.stops?.length, 1);
});
