/**
 * Admin Auto-Dispatch Rules (global_dispatch_settings) helpers.
 * Values must come from the saved SSOT row — never invent Admin UI numbers here.
 */

export type DispatchRadiusMeters = {
  startMeters: number;
  expandMeters: number;
  maxMeters: number;
};

/**
 * Absolute radii per wave (Admin: Start / Expand / Max).
 * Round 1 = start, round 2 = expand, round 3+ = max.
 */
export function radiusMetersForDispatchRound(
  round: number,
  radii: DispatchRadiusMeters,
): number {
  const start = Math.max(0, Number(radii.startMeters) || 0);
  const expand = Math.max(0, Number(radii.expandMeters) || 0);
  const max = Math.max(0, Number(radii.maxMeters) || 0);
  if (round <= 1) return start > 0 ? start : expand || max;
  if (round === 2) return expand > 0 ? expand : Math.max(start, max);
  return max > 0 ? max : Math.max(start, expand);
}

export function waveOfferExpirySecondsForRound(
  round: number,
  waves: {
    wave1?: number | null;
    wave2?: number | null;
    wave3?: number | null;
  },
): number | null {
  const w1 = Number(waves.wave1);
  const w2 = Number(waves.wave2);
  const w3 = Number(waves.wave3);
  if (round <= 1) return Number.isFinite(w1) && w1 > 0 ? w1 : null;
  if (round === 2) return Number.isFinite(w2) && w2 > 0 ? w2 : null;
  return Number.isFinite(w3) && w3 > 0 ? w3 : null;
}

export function waveBatchSizeForRound(
  round: number,
  waves: {
    wave1?: number | null;
    wave2?: number | null;
    wave3?: number | null;
  },
): number | null {
  const w1 = Number(waves.wave1);
  const w2 = Number(waves.wave2);
  const w3 = Number(waves.wave3);
  if (round <= 1) return Number.isFinite(w1) && w1 > 0 ? w1 : null;
  if (round === 2) return Number.isFinite(w2) && w2 > 0 ? w2 : null;
  return Number.isFinite(w3) && w3 > 0 ? w3 : null;
}

export type DispatchScoreInput = {
  distanceMeters: number;
  waitingMinutes: number;
  categoryPriority?: number;
  distancePenaltyPerMeter: number;
  waitingBonusPerMinute: number;
  maxWaitingBonusMinutes: number;
  fairnessBoostScore: number;
  fairnessIdleMinutes: number;
};

/**
 * Admin formula:
 * score = category_priority + (waiting_min * waiting_bonus) + fairness_boost
 *       - (distance_km * distance_penalty_per_km)
 * where distance_penalty_per_km = distance_penalty_per_meter * 1000
 */
export function computeDispatchScore(input: DispatchScoreInput): number {
  const distanceKm = Math.max(0, input.distanceMeters) / 1000;
  const distancePenaltyPerKm = Number(input.distancePenaltyPerMeter) * 1000;
  const cappedWait = Math.min(
    Math.max(0, input.waitingMinutes),
    Math.max(0, Number(input.maxWaitingBonusMinutes) || 0),
  );
  const waitingBonus = cappedWait * (Number(input.waitingBonusPerMinute) || 0);
  const fairness =
    cappedWait >= (Number(input.fairnessIdleMinutes) || Infinity)
      ? Number(input.fairnessBoostScore) || 0
      : 0;
  const category = Number(input.categoryPriority) || 0;
  return category + waitingBonus + fairness - distanceKm * distancePenaltyPerKm;
}
