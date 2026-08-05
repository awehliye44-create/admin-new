/**
 * SSOT for trip modification stop hydration (edge functions).
 * Prefer trip_stops rows; fall back to trips.stops JSON when intermediates are missing.
 */

export type ModifyTripStopRow = {
  stop_index: number;
  address: string;
  lat: number;
  lng: number;
  type: string;
  status: string;
};

type TripStopInput = {
  stop_index: number;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  type?: string | null;
  status?: string | null;
};

type JsonStop = {
  address: string;
  lat?: number | null;
  lng?: number | null;
};

const isIntermediateType = (type?: string | null): boolean =>
  (type ?? "").trim().toLowerCase() === "stop";

function mapRow(stop: TripStopInput): ModifyTripStopRow {
  return {
    stop_index: stop.stop_index,
    address: stop.address ?? "",
    lat: stop.lat ?? 0,
    lng: stop.lng ?? 0,
    type: stop.type ?? "stop",
    status: stop.status ?? "pending",
  };
}

function parseTripStopsJson(stops: unknown): JsonStop[] {
  if (!Array.isArray(stops)) return [];
  return stops.filter(
    (stop): stop is JsonStop =>
      Boolean(stop) &&
      typeof stop === "object" &&
      typeof (stop as JsonStop).address === "string" &&
      (stop as JsonStop).address.trim().length > 0,
  );
}

function synthesizeIntermediateStops(jsonStops: JsonStop[]): ModifyTripStopRow[] {
  return jsonStops.map((stop, index) => ({
    stop_index: index + 1,
    address: stop.address,
    lat: stop.lat ?? 0,
    lng: stop.lng ?? 0,
    type: "stop",
    status: "pending",
  }));
}

function mergePickupIntermediatesDropoff(
  tableRows: ModifyTripStopRow[],
  jsonStops: JsonStop[],
): ModifyTripStopRow[] {
  const pickup = tableRows.find((stop) => (stop.type ?? "").toLowerCase() === "pickup") ?? null;
  const dropoff = tableRows.find((stop) => (stop.type ?? "").toLowerCase() === "dropoff") ?? null;
  const intermediates = synthesizeIntermediateStops(jsonStops);
  const merged: ModifyTripStopRow[] = [];

  if (pickup) merged.push(pickup);
  merged.push(...intermediates);

  if (dropoff) {
    const nextIndex =
      intermediates.length > 0
        ? Math.max(...intermediates.map((stop) => stop.stop_index)) + 1
        : (pickup?.stop_index ?? 0) + 1;
    merged.push({ ...dropoff, stop_index: nextIndex });
  }

  return merged.length > 0 ? merged : intermediates;
}

export function resolveModifyTripCurrentStops(input: {
  tripStopsRows?: TripStopInput[] | null;
  tripStopsJson?: unknown;
}): ModifyTripStopRow[] {
  const fromTable = (input.tripStopsRows ?? []).map(mapRow);
  const hasIntermediateRows = fromTable.some((stop) => isIntermediateType(stop.type));
  if (hasIntermediateRows) return fromTable;

  const jsonStops = parseTripStopsJson(input.tripStopsJson);
  if (jsonStops.length === 0) return fromTable;

  if (fromTable.length === 0) {
    return synthesizeIntermediateStops(jsonStops);
  }

  return mergePickupIntermediatesDropoff(fromTable, jsonStops);
}
