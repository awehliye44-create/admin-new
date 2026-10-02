/**
 * Unit tests for dispatch sequence / wave cycle helpers.
 * Run: deno test supabase/functions/_shared/dispatchSequence.test.ts
 */
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BookingDispatchRadiusConfigError,
  destinationMatchRadiusMeters,
  dispatchRoundFromSequence,
  effectiveOfferExpirySeconds,
  effectiveRadiusMeters,
  mergeDispatchRow,
  overlayGlobalDispatchSettings,
  maxBroadcastSequences,
  resolveWaveCommission,
  waveIndexFromSequence,
  waveOfferExpirySeconds,
} from "../../functions/_shared/dispatch-settings.ts";
import { resolveDispatchBroadcastRound } from "../../functions/_shared/dispatchSearchWindow.ts";

Deno.test("waveIndexFromSequence cycles every 3", () => {
  assertEquals(waveIndexFromSequence(1), 1);
  assertEquals(waveIndexFromSequence(2), 2);
  assertEquals(waveIndexFromSequence(3), 3);
  assertEquals(waveIndexFromSequence(4), 1);
  assertEquals(waveIndexFromSequence(6), 3);
  assertEquals(waveIndexFromSequence(7), 1);
});

Deno.test("dispatchRoundFromSequence is full 3-wave cycles", () => {
  assertEquals(dispatchRoundFromSequence(1), 1);
  assertEquals(dispatchRoundFromSequence(3), 1);
  assertEquals(dispatchRoundFromSequence(4), 2);
  assertEquals(dispatchRoundFromSequence(9), 3);
});

Deno.test("maxBroadcastSequences = max_dispatch_rounds × 3", () => {
  assertEquals(maxBroadcastSequences({ max_dispatch_rounds: 3 }, null), 9);
  assertEquals(maxBroadcastSequences({ max_dispatch_rounds: 3 }, 9), 9);
  assertEquals(maxBroadcastSequences({}, null), 9);
});

Deno.test("resolveDispatchBroadcastRound advances past wave 3 into next cycle", () => {
  assertEquals(
    resolveDispatchBroadcastRound({
      storedRound: 3,
      maxRounds: 9,
      forceRebroadcast: true,
      searchWindowActive: true,
    }),
    4,
  );
  assertEquals(
    resolveDispatchBroadcastRound({
      storedRound: 9,
      maxRounds: 9,
      forceRebroadcast: true,
      searchWindowActive: true,
    }),
    9,
  );
});

Deno.test("effective radius uses absolute Admin wave radii per wave-in-cycle (round 2 wave 1 restarts)", () => {
  const settings = {
    start_radius_meters: 13000,
    expand_radius_meters: 17000,
    max_radius_meters: 29000,
  };
  assertEquals(effectiveRadiusMeters(settings, 1), 13000);
  assertEquals(effectiveRadiusMeters(settings, 2), 17000); // not min(13000 + 17000, 29000)
  assertEquals(effectiveRadiusMeters(settings, 3), 29000);
  assertEquals(effectiveRadiusMeters(settings, 4), 13000); // R2W1
  assertEquals(effectiveRadiusMeters(settings, 5), 17000); // R2W2
  assertEquals(effectiveRadiusMeters(settings, 6), 29000); // R2W3
});

Deno.test("effective radius ignores per-area km columns and fails closed without Admin radii", () => {
  const stale = { search_radius_meters: 3000, search_radius_start_km: 3, search_radius_expand_km: 5, search_radius_max_km: 8 };
  assertThrows(() => effectiveRadiusMeters(stale, 1), BookingDispatchRadiusConfigError);
  assertEquals(
    effectiveRadiusMeters({ ...stale, start_radius_meters: 9000, expand_radius_meters: 9000, max_radius_meters: 9000 }, 2),
    9000,
  );
});

Deno.test("global overlay supplies wave radii; towards-destination and customer map radius stay separate", () => {
  const merged = overlayGlobalDispatchSettings(
    mergeDispatchRow({ search_radius_start_km: 3, search_radius_expand_km: 5, search_radius_max_km: 8 }),
    {
      start_radius_meters: 13000,
      expand_radius_meters: 17000,
      max_radius_meters: 29000,
      towards_destination_match_radius_meters: 11000,
      customer_nearby_drivers_radius_meters: 25000,
    },
  );
  assertEquals([1, 2, 3].map((w) => effectiveRadiusMeters(merged, w)), [13000, 17000, 29000]);
  assertEquals(destinationMatchRadiusMeters(merged), 11000);
  assertEquals("customer_nearby_drivers_radius_meters" in merged, false);
});

Deno.test("wave radius is capped at Wave 3 (SQL LEAST parity)", () => {
  // valid_radii prevents this in Postgres; the cap mirrors dispatch_trip_offers anyway.
  const settings = { start_radius_meters: 5000, expand_radius_meters: 40000, max_radius_meters: 30000 };
  assertEquals(effectiveRadiusMeters(settings, 2), 30000);
});

Deno.test("wave commission reductions follow Admin per-wave table (no floor pin)", () => {
  const settings = {
    base_driver_commission_percent: 15,
    wave1_commission_reduction_percent: 15,
    wave2_commission_reduction_percent: 12,
    wave3_commission_reduction_percent: 9,
  };
  assertEquals(resolveWaveCommission({ settings, sequence: 1 }).effectivePercent, 0);
  assertEquals(resolveWaveCommission({ settings, sequence: 2 }).effectivePercent, 3);
  assertEquals(resolveWaveCommission({ settings, sequence: 3 }).effectivePercent, 6);
  // Round 2 Wave 1 uses W1 table again — not pinned to W1's 15pp floor
  assertEquals(
    resolveWaveCommission({ settings, sequence: 4, floorReductionPercent: 15 }).effectivePercent,
    0,
  );
  assertEquals(resolveWaveCommission({ settings, sequence: 5 }).effectivePercent, 3);
  assertEquals(resolveWaveCommission({ settings, sequence: 6 }).effectivePercent, 6);
});

Deno.test("effectiveOfferExpirySeconds caps at remaining TTL", () => {
  const settings = {
    wave3_offer_expiry_seconds: 30,
  };
  assertEquals(
    effectiveOfferExpirySeconds({ settings, sequence: 3, remainingTripTtlSeconds: 12 }),
    12,
  );
  assertEquals(
    waveOfferExpirySeconds(settings, 3),
    30,
  );
});
