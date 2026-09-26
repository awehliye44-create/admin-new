/**
 * Observability-only restore-active-trip Edge timing.
 * Never changes ownership / lifecycle / payload semantics — stamps flat ms fields.
 *
 * Stages:
 *   restore_auth_ms, restore_identity_ms, restore_trip_ms, restore_stops_ms,
 *   restore_driver_ms, restore_vehicle_ms (rolled into enrich), restore_waiting_ms,
 *   restore_modifications_ms (unused / null), restore_secondary_ms,
 *   restore_response_ms, restore_edge_total_ms
 *   restore_known_trip_id (boolean), restore_trigger (passthrough string | null)
 */

export type RestoreEdgeTimingFlat = {
  restore_auth_ms: number | null;
  restore_identity_ms: number | null;
  restore_trip_ms: number | null;
  restore_stops_ms: number | null;
  restore_driver_ms: number | null;
  restore_waiting_ms: number | null;
  restore_modifications_ms: number | null;
  restore_secondary_ms: number | null;
  restore_response_ms: number | null;
  restore_edge_total_ms: number;
  restore_known_trip_id: boolean;
  restore_known_trip_hit: boolean | null;
  restore_trigger: string | null;
};

export type RestoreEdgeTiming = {
  readonly t0: number;
  markAuthStart: () => void;
  markAuthEnd: () => void;
  markIdentityStart: () => void;
  markIdentityEnd: () => void;
  markTripStart: () => void;
  markTripEnd: () => void;
  markStopsStart: () => void;
  markStopsEnd: () => void;
  markEnrichStart: () => void;
  markEnrichEnd: () => void;
  markSecondaryStart: () => void;
  markSecondaryEnd: () => void;
  markResponseStart: () => void;
  setKnownTripId: (present: boolean) => void;
  setKnownTripHit: (hit: boolean | null) => void;
  setTrigger: (trigger: string | null) => void;
  /** Optional sub-marks when enrich splits driver vs waiting. */
  setDriverMs: (ms: number | null) => void;
  setWaitingMs: (ms: number | null) => void;
  toFlatFields: () => RestoreEdgeTimingFlat;
  attachToBody: <T extends Record<string, unknown>>(body: T) => T & RestoreEdgeTimingFlat;
};

function delta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return Math.max(0, Math.round(b - a));
}

export function createRestoreEdgeTiming(startedAtMs = Date.now()): RestoreEdgeTiming {
  const t0 = startedAtMs;
  let authStart: number | null = null;
  let authEnd: number | null = null;
  let identityStart: number | null = null;
  let identityEnd: number | null = null;
  let tripStart: number | null = null;
  let tripEnd: number | null = null;
  let stopsStart: number | null = null;
  let stopsEnd: number | null = null;
  let enrichStart: number | null = null;
  let enrichEnd: number | null = null;
  let secondaryStart: number | null = null;
  let secondaryEnd: number | null = null;
  let responseStart: number | null = null;
  let knownTripId = false;
  let knownTripHit: boolean | null = null;
  let trigger: string | null = null;
  let driverMs: number | null = null;
  let waitingMs: number | null = null;

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
    markEnrichStart: () => {
      enrichStart = Date.now();
    },
    markEnrichEnd: () => {
      enrichEnd = Date.now();
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
    setKnownTripId: (present: boolean) => {
      knownTripId = present === true;
    },
    setKnownTripHit: (hit: boolean | null) => {
      knownTripHit = hit;
    },
    setTrigger: (value: string | null) => {
      trigger =
        typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : null;
    },
    setDriverMs: (ms: number | null) => {
      driverMs = ms == null ? null : Math.max(0, Math.round(ms));
    },
    setWaitingMs: (ms: number | null) => {
      waitingMs = ms == null ? null : Math.max(0, Math.round(ms));
    },
    toFlatFields: () => {
      const now = Date.now();
      const enrichMs = delta(enrichStart, enrichEnd);
      return {
        restore_auth_ms: delta(authStart, authEnd),
        restore_identity_ms: delta(identityStart, identityEnd),
        restore_trip_ms: delta(tripStart, tripEnd),
        restore_stops_ms: delta(stopsStart, stopsEnd),
        restore_driver_ms: driverMs ?? enrichMs,
        restore_waiting_ms: waitingMs,
        restore_modifications_ms: null,
        restore_secondary_ms: delta(secondaryStart, secondaryEnd),
        restore_response_ms: delta(responseStart, now),
        restore_edge_total_ms: Math.max(0, Math.round(now - t0)),
        restore_known_trip_id: knownTripId,
        restore_known_trip_hit: knownTripHit,
        restore_trigger: trigger,
      };
    },
    attachToBody: <T extends Record<string, unknown>>(body: T) => {
      try {
        return { ...body, ...{
          restore_auth_ms: delta(authStart, authEnd),
          restore_identity_ms: delta(identityStart, identityEnd),
          restore_trip_ms: delta(tripStart, tripEnd),
          restore_stops_ms: delta(stopsStart, stopsEnd),
          restore_driver_ms: driverMs ?? delta(enrichStart, enrichEnd),
          restore_waiting_ms: waitingMs,
          restore_modifications_ms: null,
          restore_secondary_ms: delta(secondaryStart, secondaryEnd),
          restore_response_ms: delta(responseStart, Date.now()),
          restore_edge_total_ms: Math.max(0, Math.round(Date.now() - t0)),
          restore_known_trip_id: knownTripId,
          restore_known_trip_hit: knownTripHit,
          restore_trigger: trigger,
        } satisfies RestoreEdgeTimingFlat };
      } catch {
        return body as T & RestoreEdgeTimingFlat;
      }
    },
  };
}

/** Safe attach — never throws into payment/restore path. */
export function attachRestoreTiming<T extends Record<string, unknown>>(
  body: T,
  timing: RestoreEdgeTiming,
): T & RestoreEdgeTimingFlat {
  try {
    return { ...body, ...timing.toFlatFields() };
  } catch {
    return body as T & RestoreEdgeTimingFlat;
  }
}
