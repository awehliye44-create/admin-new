import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildRideOfferRemotePushCopy } from "./rideOfferRemotePushCopy.ts";

Deno.test("remote push uses driver-net and approved hierarchy", () => {
  const copy = buildRideOfferRemotePushCopy({
    driverNetPence: 2150,
    currencyCode: "GBP",
    distanceMeters: 1931, // ~1.2 mi
    etaSeconds: 240, // 4 min
    pickupSummary: "Milton Keynes Central Station",
  });
  assertEquals(copy.title, "ONECAB DRIVER");
  assertEquals(copy.headline, "New ride offer · £21.50");
  assertEquals(copy.detail.includes("1.2 mi"), true);
  assertEquals(copy.detail.includes("4 min to pickup"), true);
  assertEquals(copy.detail.includes("Milton Keynes Central Station"), true);
  assertEquals(copy.body.includes("£21.50"), true);
});

Deno.test("stacked + multiple stops + card flags", () => {
  const copy = buildRideOfferRemotePushCopy({
    driverNetPence: 1200,
    currencyCode: "GBP",
    distanceMeters: 800,
    etaSeconds: 180,
    pickupSummary: "CentreMK",
    isStacked: true,
    hasMultipleStops: true,
    paymentMethod: "card",
    isScheduled: true,
  });
  assertEquals(copy.headline.includes("New ride after current trip"), true);
  assertEquals(copy.headline.includes("+ multiple stops"), true);
  assertEquals(copy.headline.includes("Card"), true);
  assertEquals(copy.headline.includes("Scheduled"), true);
  assertEquals(copy.headline.includes("£12.00"), true);
});

Deno.test("never requires gross fare", () => {
  const copy = buildRideOfferRemotePushCopy({
    driverNetPence: null,
    currencyCode: "GBP",
    distanceMeters: null,
    etaSeconds: null,
    pickupSummary: "Tap to view details",
  });
  assertEquals(copy.fareText, "—");
  assertEquals(copy.body.includes("gross"), false);
});
