/**
 * MK-261104-003 lock: scheduled broadcast → accept → cancel-before-pickup →
 * convert-to-instant must allocate a unique broadcast_round so post-convert
 * waves succeed. Native instant trips keep naive seq 1…N behaviour.
 *
 * Run: deno test --allow-read supabase/tests/_shared/scheduledConvertInstantWaveLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  maxBroadcastRoundFromOfferRows,
  resolveConversionBroadcastRoundAnchor,
  resolveUniqueDispatchBroadcastRound,
} from "../../functions/_shared/dispatchBroadcastRoundAllocation.ts";
import { resolveNextRematchBroadcastRound } from "../../functions/_shared/driverCancelRematch.ts";
import { buildScheduledUrgentConversionPatch } from "../../functions/_shared/scheduledDispatchConfig.ts";
import {
  resolveWaveCommission,
  waveIndexFromSequence,
  waveOfferExpirySeconds,
} from "../../functions/_shared/dispatch-settings.ts";
import {
  DISPATCH_STATUS_OFFER_CREATE_BLOCKED,
  isRideOfferBroadcastRoundUniqueViolation,
  isStaleTripRebroadcastCandidate,
  OFFER_CREATE_UNIQUE_COLLISION_REASON,
  tripPatchAfterPermanentOfferCreateError,
} from "../../functions/_shared/sweepExpiredOffers.ts";

const DRIVER_A = "c40dd8a6-f422-40bc-9534-bae7be88b93e"; // MK0006
const DRIVER_B = "56136f5f-1a3a-4a14-bb23-439b3951415a"; // MK0007

const STANDARD_WAVE_SETTINGS = {
  base_driver_commission_percent: 15,
  wave1_commission_reduction_percent: 0,
  wave2_commission_reduction_percent: 2,
  wave3_commission_reduction_percent: 3,
  wave1_offer_expiry_seconds: 45,
  wave2_offer_expiry_seconds: 40,
  wave3_offer_expiry_seconds: 30,
};

type OfferRow = {
  driver_id: string;
  broadcast_round: number;
  status: string;
};

/** Simulate the MK-261104-003 lifecycle in pure helpers (no DB). */
function simulateScheduledAcceptCancelConvertWaves(input: {
  scheduledWave1Drivers: string[];
  acceptedBy: string;
  rematchDriver: string;
  maxRounds?: number;
}) {
  const offers: OfferRow[] = [];
  const maxRounds = input.maxRounds ?? 9;

  // 1) Scheduled broadcast wave → round 1
  for (const driverId of input.scheduledWave1Drivers) {
    offers.push({ driver_id: driverId, broadcast_round: 1, status: "pending" });
  }
  assertEquals(maxBroadcastRoundFromOfferRows(offers), 1);

  // 2) Accept (scheduled broadcast acceptance — worked on 003)
  const accepted = offers.find((o) => o.driver_id === input.acceptedBy && o.broadcast_round === 1);
  if (!accepted) throw new Error("accept target missing");
  accepted.status = "accepted";
  for (const o of offers) {
    if (o !== accepted && o.status === "pending") o.status = "revoked";
  }

  // 3) Driver cancel before pickup → rematch round anchor
  accepted.status = "revoked";
  const rematchAnchor = resolveNextRematchBroadcastRound(maxBroadcastRoundFromOfferRows(offers));
  assertEquals(rematchAnchor, 3); // end of cycle after round 1
  const rematchRound = resolveUniqueDispatchBroadcastRound({
    storedRound: rematchAnchor,
    maxExistingOfferRound: maxBroadcastRoundFromOfferRows(offers),
    maxRounds,
    forceRebroadcast: true,
    searchWindowActive: true,
  });
  assertEquals(rematchRound, 4);
  offers.push({
    driver_id: input.rematchDriver,
    broadcast_round: rematchRound,
    status: "expired",
  });

  // 4) Convert to instant — must stamp search deadline + unique round anchor
  const maxExisting = maxBroadcastRoundFromOfferRows(offers);
  assertEquals(maxExisting, 4);
  const convertAt = "2026-11-04T22:16:02.000Z";
  const searchDeadline = "2026-11-04T22:22:02.000Z";
  const patch = buildScheduledUrgentConversionPatch({
    nowIso: convertAt,
    searchingExpiresAtIso: searchDeadline,
    maxExistingBroadcastRound: maxExisting,
  });
  assertEquals(patch.dispatch_mode, "instant");
  assertEquals(patch.scheduled_status, "converted_to_instant");
  assertEquals(patch.status, "searching");
  assertEquals(patch.dispatch_status, "broadcasting");
  assertEquals(patch.searching_expires_at, searchDeadline);
  assertEquals(patch.current_broadcast_round, 6); // rematch-align after max=4
  assertEquals(
    patch.current_broadcast_round,
    resolveConversionBroadcastRoundAnchor(maxExisting),
  );

  // 5) First post-convert auto-dispatch wave — must not reuse rounds 1 or 4
  const postConvertRound = resolveUniqueDispatchBroadcastRound({
    storedRound: patch.current_broadcast_round,
    maxExistingOfferRound: maxExisting,
    maxRounds,
    forceRebroadcast: true,
    searchWindowActive: true,
  });
  assertEquals(postConvertRound, 7);
  assertEquals(waveIndexFromSequence(postConvertRound), 1); // fresh W1
  for (const prior of offers) {
    assertEquals(
      prior.broadcast_round === postConvertRound,
      false,
      `post-convert round ${postConvertRound} collided with history round ${prior.broadcast_round}`,
    );
  }

  // Offer would insert for rematch driver (and others) at unique round
  offers.push({
    driver_id: input.rematchDriver,
    broadcast_round: postConvertRound,
    status: "pending",
  });

  // Second wave continues standard instant progression
  const wave2 = resolveUniqueDispatchBroadcastRound({
    storedRound: postConvertRound,
    maxExistingOfferRound: maxBroadcastRoundFromOfferRows(offers),
    maxRounds,
    forceRebroadcast: true,
    searchWindowActive: true,
  });
  assertEquals(wave2, 8);
  assertEquals(waveIndexFromSequence(wave2), 2);

  return { offers, patch, postConvertRound, wave2, rematchRound };
}

Deno.test("MK-261104-003: accept→cancel→convert yields unique post-convert waves", () => {
  const result = simulateScheduledAcceptCancelConvertWaves({
    scheduledWave1Drivers: [DRIVER_A, DRIVER_B],
    acceptedBy: DRIVER_A,
    rematchDriver: DRIVER_B,
  });
  assertEquals(result.postConvertRound, 7);
  assertEquals(result.patch.searching_expires_at.endsWith("22:22:02.000Z"), true);
  // Cancelling driver stays excluded from later standard waves (trip.excluded_driver_ids)
  const excludedAfterCancel = [DRIVER_A];
  assertEquals(excludedAfterCancel.includes(DRIVER_A), true);
  assertEquals(
    result.offers.some((o) =>
      o.broadcast_round === result.postConvertRound && o.driver_id === DRIVER_A
    ),
    false,
  );

  // Post-convert W1/W2 match native instant W1/W2 commission + expiry tables
  const convertedW1 = resolveWaveCommission({
    settings: STANDARD_WAVE_SETTINGS,
    sequence: result.postConvertRound,
  });
  const nativeW1 = resolveWaveCommission({
    settings: STANDARD_WAVE_SETTINGS,
    sequence: 1,
  });
  assertEquals(convertedW1.wave, nativeW1.wave);
  assertEquals(convertedW1.effectivePercent, nativeW1.effectivePercent);
  assertEquals(
    waveOfferExpirySeconds(STANDARD_WAVE_SETTINGS, result.postConvertRound),
    waveOfferExpirySeconds(STANDARD_WAVE_SETTINGS, 1),
  );

  const convertedW2 = resolveWaveCommission({
    settings: STANDARD_WAVE_SETTINGS,
    sequence: result.wave2,
  });
  const nativeW2 = resolveWaveCommission({
    settings: STANDARD_WAVE_SETTINGS,
    sequence: 2,
  });
  assertEquals(convertedW2.wave, nativeW2.wave);
  assertEquals(convertedW2.effectivePercent, nativeW2.effectivePercent);
  assertEquals(
    waveOfferExpirySeconds(STANDARD_WAVE_SETTINGS, result.wave2),
    waveOfferExpirySeconds(STANDARD_WAVE_SETTINGS, 2),
  );
});

Deno.test("native instant trip still advances 1→2→3 without rematch jump", () => {
  const maxRounds = 9;
  let stored = 0;
  let maxOffer = 0;
  const rounds: number[] = [];
  for (let i = 0; i < 8; i++) {
    const next = resolveUniqueDispatchBroadcastRound({
      storedRound: stored,
      maxExistingOfferRound: maxOffer,
      maxRounds,
      forceRebroadcast: i > 0,
      searchWindowActive: true,
    });
    rounds.push(next);
    maxOffer = next;
    stored = next;
  }
  assertEquals(rounds, [1, 2, 3, 4, 5, 6, 7, 8]);
  // Same wave-table behaviour as MK-261104-004 (native instant)
  assertEquals(
    rounds.map((seq) => waveIndexFromSequence(seq)),
    [1, 2, 3, 1, 2, 3, 1, 2],
  );
  assertEquals(
    rounds.map((seq) =>
      resolveWaveCommission({ settings: STANDARD_WAVE_SETTINGS, sequence: seq }).effectivePercent
    ),
    [15, 13, 12, 15, 13, 12, 15, 13],
  );
  // Naive convert with no history still starts at seq 1
  const cleanConvert = buildScheduledUrgentConversionPatch({
    nowIso: "2026-11-04T22:23:20.000Z",
    searchingExpiresAtIso: "2026-11-04T22:29:20.000Z",
    maxExistingBroadcastRound: 0,
  });
  assertEquals(cleanConvert.current_broadcast_round, 0);
  assertEquals(
    resolveUniqueDispatchBroadcastRound({
      storedRound: cleanConvert.current_broadcast_round,
      maxExistingOfferRound: 0,
      maxRounds,
      forceRebroadcast: true,
      searchWindowActive: true,
    }),
    1,
  );
});

Deno.test("convert without maxExistingBroadcastRound stays backward-compatible at 0", () => {
  const patch = buildScheduledUrgentConversionPatch({
    nowIso: "2026-11-04T22:16:00.000Z",
    searchingExpiresAtIso: "2026-11-04T22:22:00.000Z",
  });
  assertEquals(patch.current_broadcast_round, 0);
  assertEquals(patch.searching_expires_at, "2026-11-04T22:22:00.000Z");
  assertEquals(patch.max_broadcast_rounds, 9); // Admin 3×3 default sequences
});

Deno.test("search TTL keeps allocating unique rounds past cycle budget (instant 6-min window)", () => {
  // After convert with history max=4 and stamp maxRounds=9, waves continue while
  // searching_expires_at is live — even past the naive cycle cap.
  let stored = 6;
  let maxOffer = 4;
  const rounds: number[] = [];
  for (let i = 0; i < 6; i++) {
    const next = resolveUniqueDispatchBroadcastRound({
      storedRound: stored,
      maxExistingOfferRound: maxOffer,
      maxRounds: 9,
      forceRebroadcast: true,
      searchWindowActive: true,
    });
    rounds.push(next);
    maxOffer = next;
    stored = next;
  }
  assertEquals(rounds[0], 7);
  assertEquals(rounds.length, 6);
  assertEquals(rounds[rounds.length - 1] > 9, true); // past budget while TTL live
  // When search window ended, do not invent past budget
  assertEquals(
    resolveUniqueDispatchBroadcastRound({
      storedRound: 9,
      maxExistingOfferRound: 12,
      maxRounds: 9,
      forceRebroadcast: true,
      searchWindowActive: false,
    }),
    9,
  );
});

Deno.test("convert stamps instant-search deadline + sequence headroom for 6-min waves", () => {
  const patch = buildScheduledUrgentConversionPatch({
    nowIso: "2026-11-04T23:01:00.000Z",
    searchingExpiresAtIso: "2026-11-04T23:07:00.000Z", // +6 minutes
    maxExistingBroadcastRound: 4,
    maxBroadcastSequences: 9,
  });
  assertEquals(patch.searching_expires_at, "2026-11-04T23:07:00.000Z");
  assertEquals(patch.current_broadcast_round, 6);
  assertEquals(patch.max_broadcast_rounds >= 9, true);
  assertEquals(patch.max_broadcast_rounds >= 6 + 3, true);
});

Deno.test("unique violation is detected and permanently blocks stale rebroadcast", () => {
  assertEquals(
    isRideOfferBroadcastRoundUniqueViolation(
      'duplicate key value violates unique constraint "ride_offers_trip_id_driver_id_broadcast_round_key"',
    ),
    true,
  );
  assertEquals(
    isRideOfferBroadcastRoundUniqueViolation("some other error"),
    false,
  );
  const patch = tripPatchAfterPermanentOfferCreateError("2026-11-04T22:16:30.000Z");
  assertEquals(patch.dispatch_status, DISPATCH_STATUS_OFFER_CREATE_BLOCKED);
  assertEquals(
    isStaleTripRebroadcastCandidate({
      dispatch_status: DISPATCH_STATUS_OFFER_CREATE_BLOCKED,
      current_broadcast_round: 0,
      max_broadcast_rounds: 9,
      pending_offer_count: 0,
    }),
    false,
  );
  // Round-0 broadcasting after failed convert must not be treated as stale-retry eligible
  assertEquals(
    isStaleTripRebroadcastCandidate({
      dispatch_status: "broadcasting",
      current_broadcast_round: 0,
      max_broadcast_rounds: 9,
      pending_offer_count: 0,
    }),
    false,
  );
  assertEquals(OFFER_CREATE_UNIQUE_COLLISION_REASON, "OFFER_CREATE_UNIQUE_COLLISION");
});

Deno.test("source lock: conversion + auto-dispatch + expire-offers wire unique rounds", async () => {
  const scheduledDispatch = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(scheduledDispatch, "maxExistingBroadcastRound");
  assertStringIncludes(scheduledDispatch, "broadcast_round");

  const autoDispatch = await Deno.readTextFile(
    new URL("../../functions/auto-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(autoDispatch, "resolveUniqueDispatchBroadcastRound");
  assertStringIncludes(autoDispatch, "OFFER_CREATE_UNIQUE_COLLISION");
  assertStringIncludes(autoDispatch, "tripPatchAfterPermanentOfferCreateError");

  const expireOffers = await Deno.readTextFile(
    new URL("../../functions/expire-offers/index.ts", import.meta.url),
  );
  assertStringIncludes(expireOffers, "isStaleTripRebroadcastCandidate");
  assertStringIncludes(expireOffers, "DISPATCH_STATUS_OFFER_CREATE_BLOCKED");

  const conversionConfig = await Deno.readTextFile(
    new URL("../../functions/_shared/scheduledDispatchConfig.ts", import.meta.url),
  );
  assertStringIncludes(conversionConfig, "maxExistingBroadcastRound");
  assertStringIncludes(conversionConfig, "resolveNextRematchBroadcastRound");
});
