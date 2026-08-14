/**
 * Unit tests for dispatch sequence / wave cycle helpers.
 * Run: deno test supabase/functions/_shared/dispatchSequence.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchRoundFromSequence,
  effectiveOfferExpirySeconds,
  effectiveRadiusMeters,
  maxBroadcastSequences,
  resolveWaveCommission,
  waveIndexFromSequence,
  waveOfferExpirySeconds,
} from "./dispatch-settings.ts";
import { resolveDispatchBroadcastRound } from "./dispatchSearchWindow.ts";

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

Deno.test("effective radius uses wave-in-cycle (round 2 wave 1 restarts)", () => {
  const settings = {
    search_radius_start_km: 3,
    search_radius_expand_km: 5,
    search_radius_max_km: 8,
  };
  assertEquals(effectiveRadiusMeters(settings, 1), 3000);
  assertEquals(effectiveRadiusMeters(settings, 4), 3000); // R2W1
  assertEquals(effectiveRadiusMeters(settings, 3), 8000);
  assertEquals(effectiveRadiusMeters(settings, 6), 8000); // R2W3
});

Deno.test("wave commission reductions are percentage points with floor", () => {
  const settings = {
    base_driver_commission_percent: 15,
    wave1_commission_reduction_percent: 0,
    wave2_commission_reduction_percent: 3,
    wave3_commission_reduction_percent: 6,
  };
  assertEquals(resolveWaveCommission({ settings, sequence: 1 }).effectivePercent, 15);
  assertEquals(resolveWaveCommission({ settings, sequence: 2 }).effectivePercent, 12);
  assertEquals(resolveWaveCommission({ settings, sequence: 3 }).effectivePercent, 9);
  // Round 2 Wave 1 keeps Wave 3 floor
  assertEquals(
    resolveWaveCommission({ settings, sequence: 4, floorReductionPercent: 6 }).effectivePercent,
    9,
  );
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
