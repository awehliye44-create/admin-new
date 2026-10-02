/**
 * Authoritative trip_stops reconstruction for stop-workflow.
 *
 * When workflow rows are missing, rebuild from trips pickup / trips.stops vias /
 * dropoff — never interpret an empty trip_stops table as "single A→B trip".
 *
 * DB SSOT mutator: public.ensure_trip_stops_for_assignment(p_trip_id).
 * This module is the pure shape + gate used by Edge + lock tests.
 */

export type AuthoritativeViaStop = {
  address: string;
  lat: number;
  lng: number;
};

export type AuthoritativeTripStopRow = {
  trip_id: string;
  stop_index: number;
  type: "pickup" | "stop" | "dropoff";
  address: string;
  lat: number;
  lng: number;
  status: "pending";
};

export type AuthoritativeTripGeometry = {
  id: string;
  pickup_address?: string | null;
  pickup_latitude?: number | null;
  pickup_longitude?: number | null;
  dropoff_address?: string | null;
  dropoff_latitude?: number | null;
  dropoff_longitude?: number | null;
  stops?: unknown;
  total_stops?: number | null;
  current_stop_index?: number | null;
};

type ExistingStopRow = {
  type?: string | null;
  stop_index?: number | null;
};

function numOrZero(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

/** Declared via count from trips.stops — proves multi-stop intent even before geometry parse. */
export function countAuthoritativeViaDeclarations(stopsJson: unknown): number {
  if (!Array.isArray(stopsJson)) return 0;
  return stopsJson.filter((stop) => Boolean(stop) && typeof stop === "object").length;
}

function readFiniteCoord(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ordered intermediate vias from trips.stops JSON (authoritative booking snapshot).
 * Matches ensure_trip_stops_for_assignment: skip entries without finite lat/lng.
 */
export function parseAuthoritativeViaStops(stopsJson: unknown): AuthoritativeViaStop[] {
  if (!Array.isArray(stopsJson)) return [];

  const vias: AuthoritativeViaStop[] = [];
  for (let i = 0; i < stopsJson.length; i += 1) {
    const raw = stopsJson[i];
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const lat = readFiniteCoord(row.lat ?? row.latitude);
    const lng = readFiniteCoord(row.lng ?? row.longitude);
    if (lat == null || lng == null) continue;
    let address = firstNonEmpty(
      row.address,
      row.formatted_address,
      row.name,
      `Stop ${i + 1}`,
    );
    if (/^ChIJ/i.test(address)) {
      address = `Stop ${i + 1}`;
    }
    vias.push({ address, lat, lng });
  }
  return vias;
}

export function hasIntermediateTripStopRows(
  rows: ExistingStopRow[] | null | undefined,
): boolean {
  return (rows ?? []).some(
    (row) => (row.type ?? "").trim().toLowerCase() === "stop",
  );
}

/**
 * True when trip_stops must be seeded/repaired from trips.stops + pickup/dropoff.
 * Empty workflow rows are NOT proof the trip has no intermediate stops.
 */
export function needsTripStopsReconstruction(input: {
  existingRows?: ExistingStopRow[] | null;
  stopsJson?: unknown;
}): boolean {
  const rows = input.existingRows ?? [];
  if (rows.length === 0) return true;
  if (countAuthoritativeViaDeclarations(input.stopsJson) === 0) return false;
  return !hasIntermediateTripStopRows(rows);
}

/**
 * Pure insert payload: pickup → vias (order preserved) → dropoff.
 * Matches ensure_trip_stops_for_assignment empty-seed semantics.
 */
export function buildAuthoritativeTripStopRows(
  trip: AuthoritativeTripGeometry,
): AuthoritativeTripStopRow[] {
  const tripId = trip.id;
  const vias = parseAuthoritativeViaStops(trip.stops);
  const rows: AuthoritativeTripStopRow[] = [
    {
      trip_id: tripId,
      stop_index: 0,
      type: "pickup",
      address: firstNonEmpty(trip.pickup_address, "Pickup"),
      lat: numOrZero(trip.pickup_latitude),
      lng: numOrZero(trip.pickup_longitude),
      status: "pending",
    },
  ];

  for (let i = 0; i < vias.length; i += 1) {
    const via = vias[i];
    rows.push({
      trip_id: tripId,
      stop_index: i + 1,
      type: "stop",
      address: via.address,
      lat: via.lat,
      lng: via.lng,
      status: "pending",
    });
  }

  rows.push({
    trip_id: tripId,
    stop_index: vias.length + 1,
    type: "dropoff",
    address: firstNonEmpty(trip.dropoff_address, "Dropoff"),
    lat: numOrZero(trip.dropoff_latitude),
    lng: numOrZero(trip.dropoff_longitude),
    status: "pending",
  });

  return rows;
}

/** Expected total_stops after reconstruction (pickup + vias + dropoff). */
export function authoritativeTotalStops(stopsJson: unknown): number {
  return 2 + parseAuthoritativeViaStops(stopsJson).length;
}

/**
 * Idempotency fingerprint for reconstructed rows — same vias → same ordered types/addresses.
 * Used to prove repeated initialization does not invent a second sequence.
 */
export function tripStopsSequenceFingerprint(
  rows: Array<{ type?: string | null; address?: string | null; stop_index?: number | null }>,
): string {
  return [...rows]
    .sort((a, b) => (a.stop_index ?? 0) - (b.stop_index ?? 0))
    .map((row) => `${row.stop_index}:${row.type}:${row.address ?? ""}`)
    .join("|");
}
