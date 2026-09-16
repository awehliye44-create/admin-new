/**
 * Custom Zone + stops + airport pricing SSOT lock.
 * Run: deno test --allow-read supabase/functions/_shared/pricingWaypointCustomZoneLock.test.ts
 */
import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateFare,
  type FarePricingRow,
  type ZoneRoutePricingRow,
  type ZoneRow,
  type LatLng,
} from "./pricing-engine.ts";

const MK_ZONE_ID = "zone-mk";
const LHR_ZONE_ID = "zone-lhr";
const VT = "vt-onecab";

/** Rough MK centre */
const MK_A: LatLng = { lat: 52.04, lng: -0.76 };
const MK_B: LatLng = { lat: 52.05, lng: -0.75 };
const MK_C: LatLng = { lat: 52.045, lng: -0.755 };
/** Rough Heathrow */
const LHR: LatLng = { lat: 51.47, lng: -0.46 };

function circleZone(
  id: string,
  name: string,
  center: LatLng,
  radiusMeters: number,
  opts?: { zone_type?: string; airport_charge?: number },
): ZoneRow {
  return {
    id,
    name,
    shape_type: "circle",
    zone_type: opts?.zone_type ?? "custom",
    metadata: opts?.airport_charge != null
      ? { airport_charge: opts.airport_charge }
      : {},
    priority: 10,
    center_lat: center.lat,
    center_lng: center.lng,
    radius_meters: radiusMeters,
    geo_boundary: null,
  };
}

const ZONES: ZoneRow[] = [
  circleZone(MK_ZONE_ID, "Milton Keynes", MK_A, 20_000),
  circleZone(LHR_ZONE_ID, "Heathrow", LHR, 8_000, { zone_type: "airport" }),
];

function route(
  id: string,
  from: string,
  to: string,
  fixed: number,
  airport: number,
): ZoneRoutePricingRow {
  return {
    id,
    from_zone_id: from,
    to_zone_id: to,
    vehicle_type_id: VT,
    fixed_fare: fixed,
    airport_charge: airport,
    airport_pickup_fee: null,
    airport_dropoff_fee: null,
    priority: 1,
    is_active: true,
    service_area_id: null,
  };
}

const PRICING: FarePricingRow = {
  pricing_mode: "fixed",
  base_fare_pence: 300,
  per_km_rate_pence: 150,
  per_min_rate_pence: 20,
  booking_fee_pence: 0,
  minimum_fare_pence: 500,
};

function fare(input: {
  pickup: LatLng;
  dropoff: LatLng;
  stops?: LatLng[];
  routes: ZoneRoutePricingRow[];
  distanceKm?: number;
  durationMin?: number;
  saAirport?: number;
}) {
  return calculateFare({
    pricing: PRICING,
    distanceKm: input.distanceKm ?? 80,
    durationMin: input.durationMin ?? 70,
    pickup: input.pickup,
    dropoff: input.dropoff,
    stops: input.stops ?? [],
    zones: ZONES,
    zoneRoutes: input.routes,
    serviceAreaId: "sa-test",
    serviceAreaPricingSettings: input.saAirport != null
      ? { airport_charge: input.saAirport }
      : null,
    vehicleTypeId: VT,
    distanceUnit: "mile",
  });
}

Deno.test("1. MK → Heathrow one-way fixed + airport", () => {
  const routes = [route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25)];
  const b = fare({ pickup: MK_A, dropoff: LHR, routes });
  assertEquals(b.pricing_mode, "ROUTE_PRICING");
  assertEquals(b.trip_fare, 52);
  assertEquals(b.airport_charge, 25);
  assertEquals(b.final_fare, 77);
  assertEquals(b.fixed_fare_applied, true);
});

Deno.test("2. Heathrow → MK one-way uses reverse directional row", () => {
  const routes = [
    route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25),
    route("r2", LHR_ZONE_ID, MK_ZONE_ID, 48, 20),
  ];
  const b = fare({ pickup: LHR, dropoff: MK_A, routes });
  assertEquals(b.trip_fare, 48);
  assertEquals(b.airport_charge, 20);
  assertEquals(b.final_fare, 68);
});

Deno.test("3. MK → local MK stop → Heathrow keeps single Custom Zone fare", () => {
  const routes = [route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25)];
  const b = fare({
    pickup: MK_A,
    dropoff: LHR,
    stops: [MK_B],
    routes,
  });
  assertEquals(b.pricing_mode, "ROUTE_PRICING");
  assertEquals(b.trip_fare, 52);
  assertEquals(b.airport_charge, 25);
  assertEquals(b.final_fare, 77);
});

Deno.test("4. MK → two local MK stops → Heathrow still one fixed fare", () => {
  const routes = [route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25)];
  const b = fare({
    pickup: MK_A,
    dropoff: LHR,
    stops: [MK_B, MK_C],
    routes,
  });
  assertEquals(b.final_fare, 77);
  assertEquals(b.trip_fare, 52);
  assertEquals(b.airport_charge, 25);
});

Deno.test("5. MK → Heathrow stop → MK sums both directional legs", () => {
  const routes = [
    route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25),
    route("r2", LHR_ZONE_ID, MK_ZONE_ID, 52, 25),
  ];
  const b = fare({
    pickup: MK_A,
    dropoff: MK_B,
    stops: [LHR],
    routes,
  });
  assertEquals(b.trip_fare, 104);
  assertEquals(b.airport_charge, 50);
  assertEquals(b.final_fare, 154);
  assertEquals(b.fixed_fare_applied, true);
});

Deno.test("6. MK → Heathrow stop → different MK address still two legs", () => {
  const routes = [
    route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25),
    route("r2", LHR_ZONE_ID, MK_ZONE_ID, 40, 15),
  ];
  const b = fare({
    pickup: MK_A,
    dropoff: MK_C,
    stops: [LHR],
    routes,
  });
  assertEquals(b.trip_fare, 92);
  assertEquals(b.airport_charge, 40);
  assertEquals(b.final_fare, 132);
});

Deno.test("7. MK → local stop → local MK destination uses meter (no zone route)", () => {
  const routes = [route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25)];
  const b = fare({
    pickup: MK_A,
    dropoff: MK_C,
    stops: [MK_B],
    routes,
    distanceKm: 5,
    durationMin: 12,
  });
  assertEquals(b.pricing_mode, "NORMAL_DISTANCE_TIME");
  assertEquals(b.fixed_fare_applied, false);
  assertEquals(b.airport_charge, 0);
  // Must not invent a stop fee and must not apply Heathrow fixed fare.
  assertEquals(b.final_fare === 77, false);
});

Deno.test("8. reverse directional fares are different", () => {
  const routes = [
    route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25),
    route("r2", LHR_ZONE_ID, MK_ZONE_ID, 40, 10),
  ];
  const out = fare({ pickup: MK_A, dropoff: LHR, routes });
  const ret = fare({ pickup: LHR, dropoff: MK_A, routes });
  assertEquals(out.final_fare, 77);
  assertEquals(ret.final_fare, 50);
  assertEquals(out.final_fare === ret.final_fare, false);
});

Deno.test("9. airport charge outbound only — return missing airport uses reverse fixed only", () => {
  const routes = [
    route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25),
    route("r2", LHR_ZONE_ID, MK_ZONE_ID, 52, 0),
  ];
  const out = fare({ pickup: MK_A, dropoff: LHR, routes });
  const ret = fare({ pickup: LHR, dropoff: MK_A, routes });
  assertEquals(out.airport_charge, 25);
  assertEquals(ret.airport_charge, 0);
  assertEquals(ret.trip_fare, 52);
  assertEquals(ret.final_fare, 52);

  const roundTrip = fare({
    pickup: MK_A,
    dropoff: MK_B,
    stops: [LHR],
    routes,
  });
  // 52+25 + 52+0 = 129 — exact £129 root cause
  assertEquals(roundTrip.final_fare, 129);
});

Deno.test("10. airport charge both directions — round trip sums both", () => {
  const routes = [
    route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25),
    route("r2", LHR_ZONE_ID, MK_ZONE_ID, 52, 25),
  ];
  const b = fare({
    pickup: MK_A,
    dropoff: MK_B,
    stops: [LHR],
    routes,
  });
  assertEquals(b.airport_charge, 50);
  assertEquals(b.final_fare, 154);
});

Deno.test("11. Custom Zone route absent → normal meter fallback", () => {
  const b = fare({
    pickup: MK_A,
    dropoff: LHR,
    routes: [],
    distanceKm: 10,
    durationMin: 20,
  });
  assertEquals(b.pricing_mode, "NORMAL_DISTANCE_TIME");
  assertEquals(b.fixed_fare_applied, false);
});

Deno.test("12. local stops do not create a stop fee", () => {
  const routes = [route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25)];
  const oneWay = fare({ pickup: MK_A, dropoff: LHR, routes });
  const withStops = fare({
    pickup: MK_A,
    dropoff: LHR,
    stops: [MK_B, MK_C],
    routes,
  });
  assertEquals(withStops.final_fare, oneWay.final_fare);
  assertEquals(withStops.fare_details.some((l) => /stop fee/i.test(l.label)), false);
});

Deno.test("13. local stop does not destroy Custom Zone fixed pricing", () => {
  const routes = [route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25)];
  const b = fare({
    pickup: MK_A,
    dropoff: LHR,
    stops: [MK_B],
    routes,
    distanceKm: 120, // longer via stop — must still be fixed 77
  });
  assertEquals(b.fare_source, "route_fixed");
  assertEquals(b.final_fare, 77);
});

Deno.test("14. Heathrow intermediate cannot collapse to MK→MK pricing", () => {
  const routes = [
    route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25),
    route("r2", LHR_ZONE_ID, MK_ZONE_ID, 52, 25),
  ];
  const b = fare({
    pickup: MK_A,
    dropoff: MK_B,
    stops: [LHR],
    routes,
  });
  // Must not meter MK→MK and must not be a single 77.
  assertEquals(b.final_fare, 154);
  assertEquals(b.zone_applied?.includes("Heathrow") ?? false, true);
});

Deno.test("15. no duplicate airport charge on a single directional segment", () => {
  const routes = [route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25)];
  const b = fare({
    pickup: MK_A,
    dropoff: LHR,
    stops: [MK_B],
    routes,
  });
  assertEquals(b.airport_charge, 25);
});

Deno.test("16. no duplicate fixed fare for local-stop journey", () => {
  const routes = [route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25)];
  const b = fare({
    pickup: MK_A,
    dropoff: LHR,
    stops: [MK_B],
    routes,
  });
  assertEquals(b.trip_fare, 52);
  assertAlmostEquals(b.final_fare, 77, 0.001);
});

Deno.test("17. quote semantics: same inputs yield identical fare (create parity)", () => {
  const routes = [
    route("r1", MK_ZONE_ID, LHR_ZONE_ID, 52, 25),
    route("r2", LHR_ZONE_ID, MK_ZONE_ID, 52, 25),
  ];
  const input = {
    pickup: MK_A,
    dropoff: MK_B,
    stops: [LHR],
    routes,
    distanceKm: 160,
    durationMin: 140,
  };
  const a = fare(input);
  const b = fare(input);
  assertEquals(a.final_fare_pence, b.final_fare_pence);
  assertEquals(a.trip_fare, b.trip_fare);
  assertEquals(a.airport_charge, b.airport_charge);
  assertEquals(a.pricing_mode, b.pricing_mode);
});
