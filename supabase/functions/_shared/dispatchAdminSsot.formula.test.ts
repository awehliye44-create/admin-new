/**
 * Pure tests for Admin Dispatch Scoring & Execution helpers.
 * Proves absolute radii + formula math; does not claim Edge wiring is complete.
 */
import {
  computeDispatchScore,
  radiusMetersForDispatchRound,
  waveBatchSizeForRound,
  waveOfferExpirySecondsForRound,
} from "./dispatchAdminSsot.ts";

const RADII = { startMeters: 9000, expandMeters: 11000, maxMeters: 15000 };

Deno.test("absolute radius: wave1=9km wave2=11km wave3=15km", () => {
  if (radiusMetersForDispatchRound(1, RADII) !== 9000) throw new Error("w1");
  if (radiusMetersForDispatchRound(2, RADII) !== 11000) throw new Error("w2");
  if (radiusMetersForDispatchRound(3, RADII) !== 15000) throw new Error("w3");
  if (radiusMetersForDispatchRound(4, RADII) !== 15000) throw new Error("w4+");
});

Deno.test("wave sizes 11/14/18", () => {
  const w = { wave1: 11, wave2: 14, wave3: 18 };
  if (waveBatchSizeForRound(1, w) !== 11) throw new Error("s1");
  if (waveBatchSizeForRound(2, w) !== 14) throw new Error("s2");
  if (waveBatchSizeForRound(3, w) !== 18) throw new Error("s3");
});

Deno.test("wave expiry 45/30/30", () => {
  const w = { wave1: 45, wave2: 30, wave3: 30 };
  if (waveOfferExpirySecondsForRound(1, w) !== 45) throw new Error("e1");
  if (waveOfferExpirySecondsForRound(2, w) !== 30) throw new Error("e2");
  if (waveOfferExpirySecondsForRound(3, w) !== 30) throw new Error("e3");
});

const base = {
  distancePenaltyPerMeter: 0.003, // 3 / km
  waitingBonusPerMinute: 2,
  maxWaitingBonusMinutes: 15,
  fairnessBoostScore: 15,
  fairnessIdleMinutes: 10,
  categoryPriority: 0,
};

Deno.test("A distance only: 1km nearer = +3 points", () => {
  const far = computeDispatchScore({ ...base, distanceMeters: 5000, waitingMinutes: 0 });
  const near = computeDispatchScore({ ...base, distanceMeters: 4000, waitingMinutes: 0 });
  if (Math.abs((near - far) - 3) > 1e-9) throw new Error(`${near - far}`);
});

Deno.test("B waiting 5 vs 8 → Δ6", () => {
  const a = computeDispatchScore({ ...base, distanceMeters: 1000, waitingMinutes: 5 });
  const b = computeDispatchScore({ ...base, distanceMeters: 1000, waitingMinutes: 8 });
  if (Math.abs((b - a) - 6) > 1e-9) throw new Error(`${b - a}`);
});

Deno.test("C waiting cap 15 vs 25 → same waiting component", () => {
  const a = computeDispatchScore({ ...base, distanceMeters: 1000, waitingMinutes: 15 });
  const b = computeDispatchScore({ ...base, distanceMeters: 1000, waitingMinutes: 25 });
  // both capped wait=15 → both get fairness (15>=10) + waiting 30
  if (a !== b) throw new Error(`${a} vs ${b}`);
});

Deno.test("D fairness threshold 9 vs 10", () => {
  const a = computeDispatchScore({ ...base, distanceMeters: 1000, waitingMinutes: 9 });
  const b = computeDispatchScore({ ...base, distanceMeters: 1000, waitingMinutes: 10 });
  if (Math.abs((b - a) - (2 + 15)) > 1e-9) {
    // +2 waiting +15 fairness
    throw new Error(`${b - a}`);
  }
});

Deno.test("E category priority difference", () => {
  const a = computeDispatchScore({ ...base, distanceMeters: 1000, waitingMinutes: 0, categoryPriority: 10 });
  const b = computeDispatchScore({ ...base, distanceMeters: 1000, waitingMinutes: 0, categoryPriority: 40 });
  if (Math.abs((b - a) - 30) > 1e-9) throw new Error(`${b - a}`);
});

Deno.test("G combined independent calculation", () => {
  // cat=20, idle=12 → wait=min(12,15)*2=24, fairness=15, dist=3.5km*3=10.5
  // score = 20+24+15-10.5 = 48.5
  const s = computeDispatchScore({
    ...base,
    categoryPriority: 20,
    waitingMinutes: 12,
    distanceMeters: 3500,
  });
  if (Math.abs(s - 48.5) > 1e-9) throw new Error(String(s));
});

Deno.test("helper omits degraded penalty (Edge gap documented)", () => {
  // computeDispatchScore has no degraded param — Edge must subtract separately (currently does not)
  const s = computeDispatchScore({ ...base, distanceMeters: 0, waitingMinutes: 0 });
  if (s !== 0) throw new Error(String(s));
});
