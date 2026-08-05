import { describe, expect, it } from "vitest";
import {
  computeDispatchScore,
  radiusMetersForDispatchRound,
  waveBatchSizeForRound,
  waveOfferExpirySecondsForRound,
} from "../dispatchAdminSsot.ts";

describe("radiusMetersForDispatchRound", () => {
  const radii = { startMeters: 7000, expandMeters: 9000, maxMeters: 13000 };

  it("uses absolute Admin start/expand/max per wave", () => {
    expect(radiusMetersForDispatchRound(1, radii)).toBe(7000);
    expect(radiusMetersForDispatchRound(2, radii)).toBe(9000);
    expect(radiusMetersForDispatchRound(3, radii)).toBe(13000);
    expect(radiusMetersForDispatchRound(4, radii)).toBe(13000);
  });
});

describe("waveOfferExpirySecondsForRound", () => {
  it("reads per-wave SSOT without inventing defaults", () => {
    expect(
      waveOfferExpirySecondsForRound(1, { wave1: 45, wave2: 30, wave3: 30 }),
    ).toBe(45);
    expect(
      waveOfferExpirySecondsForRound(2, { wave1: 45, wave2: 30, wave3: 30 }),
    ).toBe(30);
    expect(waveOfferExpirySecondsForRound(1, { wave1: null, wave2: 30, wave3: 30 })).toBeNull();
  });
});

describe("waveBatchSizeForRound", () => {
  it("reads wave sizes from SSOT", () => {
    expect(waveBatchSizeForRound(1, { wave1: 11, wave2: 14, wave3: 18 })).toBe(11);
    expect(waveBatchSizeForRound(2, { wave1: 11, wave2: 14, wave3: 18 })).toBe(14);
    expect(waveBatchSizeForRound(3, { wave1: 11, wave2: 14, wave3: 18 })).toBe(18);
  });
});

describe("computeDispatchScore", () => {
  it("applies Admin distance / waiting / fairness weights", () => {
    const base = {
      distanceMeters: 1000,
      waitingMinutes: 12,
      distancePenaltyPerMeter: 0.003, // 3 per km
      waitingBonusPerMinute: 2,
      maxWaitingBonusMinutes: 15,
      fairnessBoostScore: 15,
      fairnessIdleMinutes: 10,
      categoryPriority: 0,
    };
    // waiting 12*2=24 + fairness 15 - 1km*3 = 36
    expect(computeDispatchScore(base)).toBe(36);
    expect(computeDispatchScore({ ...base, waitingMinutes: 5 })).toBe(10 - 3);
  });
});
