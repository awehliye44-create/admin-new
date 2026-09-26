/**
 * Observability-only get-active-trip Edge timing.
 * Never changes waiting / ownership / fare semantics.
 */

export type GetActiveTripPurpose = "full" | "waiting_fare";

export type GetActiveTripEdgeTimingFlat = {
  gat_auth_ms: number | null;
  gat_identity_ms: number | null;
  gat_trip_ms: number | null;
  gat_stops_ms: number | null;
  gat_waiting_ms: number | null;
  gat_driver_ms: number | null;
  gat_region_ms: number | null;
  gat_secondary_ms: number | null;
  gat_response_ms: number | null;
  gat_edge_total_ms: number;
  gat_known_trip_id: boolean;
  gat_known_trip_hit: boolean | null;
  gat_purpose: GetActiveTripPurpose;
  gat_skipped_full_enrich: boolean;
};

export type GetActiveTripEdgeTiming = {
  readonly t0: number;
  markAuthStart: () => void;
  markAuthEnd: () => void;
  markIdentityStart: () => void;
  markIdentityEnd: () => void;
  markTripStart: () => void;
  markTripEnd: () => void;
  markStopsStart: () => void;
  markStopsEnd: () => void;
  markWaitingStart: () => void;
  markWaitingEnd: () => void;
  markDriverStart: () => void;
  markDriverEnd: () => void;
  markRegionStart: () => void;
  markRegionEnd: () => void;
  markSecondaryStart: () => void;
  markSecondaryEnd: () => void;
  markResponseStart: () => void;
  setKnownTripId: (present: boolean) => void;
  setKnownTripHit: (hit: boolean | null) => void;
  setPurpose: (purpose: GetActiveTripPurpose) => void;
  setSkippedFullEnrich: (skipped: boolean) => void;
  toFlatFields: () => GetActiveTripEdgeTimingFlat;
};

function delta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return Math.max(0, Math.round(b - a));
}

export function createGetActiveTripEdgeTiming(
  startedAtMs = Date.now(),
): GetActiveTripEdgeTiming {
  const t0 = startedAtMs;
  let authStart: number | null = null;
  let authEnd: number | null = null;
  let identityStart: number | null = null;
  let identityEnd: number | null = null;
  let tripStart: number | null = null;
  let tripEnd: number | null = null;
  let stopsStart: number | null = null;
  let stopsEnd: number | null = null;
  let waitingStart: number | null = null;
  let waitingEnd: number | null = null;
  let driverStart: number | null = null;
  let driverEnd: number | null = null;
  let regionStart: number | null = null;
  let regionEnd: number | null = null;
  let secondaryStart: number | null = null;
  let secondaryEnd: number | null = null;
  let responseStart: number | null = null;
  let knownTripId = false;
  let knownTripHit: boolean | null = null;
  let purpose: GetActiveTripPurpose = "full";
  let skippedFullEnrich = false;

  return {
    t0,
    markAuthStart: () => {
      authStart = Date.now();
    },
    markAuthEnd: () => {
      authEnd = Date.now();
    },
    markIdentityStart: () => {
      identityStart = Date.now();
    },
    markIdentityEnd: () => {
      identityEnd = Date.now();
    },
    markTripStart: () => {
      tripStart = Date.now();
    },
    markTripEnd: () => {
      tripEnd = Date.now();
    },
    markStopsStart: () => {
      stopsStart = Date.now();
    },
    markStopsEnd: () => {
      stopsEnd = Date.now();
    },
    markWaitingStart: () => {
      waitingStart = Date.now();
    },
    markWaitingEnd: () => {
      waitingEnd = Date.now();
    },
    markDriverStart: () => {
      driverStart = Date.now();
    },
    markDriverEnd: () => {
      driverEnd = Date.now();
    },
    markRegionStart: () => {
      regionStart = Date.now();
    },
    markRegionEnd: () => {
      regionEnd = Date.now();
    },
    markSecondaryStart: () => {
      secondaryStart = Date.now();
    },
    markSecondaryEnd: () => {
      secondaryEnd = Date.now();
    },
    markResponseStart: () => {
      responseStart = Date.now();
    },
    setKnownTripId: (present) => {
      knownTripId = present === true;
    },
    setKnownTripHit: (hit) => {
      knownTripHit = hit;
    },
    setPurpose: (value) => {
      purpose = value;
    },
    setSkippedFullEnrich: (skipped) => {
      skippedFullEnrich = skipped === true;
    },
    toFlatFields: () => ({
      gat_auth_ms: delta(authStart, authEnd),
      gat_identity_ms: delta(identityStart, identityEnd),
      gat_trip_ms: delta(tripStart, tripEnd),
      gat_stops_ms: delta(stopsStart, stopsEnd),
      gat_waiting_ms: delta(waitingStart, waitingEnd),
      gat_driver_ms: delta(driverStart, driverEnd),
      gat_region_ms: delta(regionStart, regionEnd),
      gat_secondary_ms: delta(secondaryStart, secondaryEnd),
      gat_response_ms: delta(responseStart, Date.now()),
      gat_edge_total_ms: Math.max(0, Math.round(Date.now() - t0)),
      gat_known_trip_id: knownTripId,
      gat_known_trip_hit: knownTripHit,
      gat_purpose: purpose,
      gat_skipped_full_enrich: skippedFullEnrich,
    }),
  };
}

/** Safe attach — never throws into waiting/payment path. */
export function attachGetActiveTripTiming<T extends Record<string, unknown>>(
  body: T,
  timing: GetActiveTripEdgeTiming,
): T & GetActiveTripEdgeTimingFlat {
  try {
    return { ...body, ...timing.toFlatFields() };
  } catch {
    return body as T & GetActiveTripEdgeTimingFlat;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isGetActiveTripKnownTripIdShape(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function parseGetActiveTripPurpose(value: unknown): GetActiveTripPurpose {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "waiting_fare" || raw === "waiting") return "waiting_fare";
  return "full";
}
