/**
 * Admin Active Trips route display — consumes authoritative trip_stops / trips.stops.
 * Does not invent progression; maps backend stop sequence for list + detail.
 */

export type AdminTripStopRow = {
  id?: string;
  stop_index: number;
  type: string;
  address: string;
  status: string | null;
};

export type AdminActiveTripRouteModel = {
  pickupAddress: string;
  intermediateStops: AdminTripStopRow[];
  dropoffAddress: string;
  /** pickup + intermediates + dropoff */
  totalStops: number;
  intermediateCount: number;
  currentStopIndex: number | null;
  /** Human label for the active leg (stop address or final destination). */
  activeLegLabel: string;
  nextDestinationAddress: string;
  isMultiStop: boolean;
};

type JsonVia = { address: string; lat?: number; lng?: number };

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeType(type: string | null | undefined): string {
  return (type ?? "").trim().toLowerCase();
}

function parseTripsStopsJson(stops: unknown): JsonVia[] {
  if (!Array.isArray(stops)) return [];
  const out: JsonVia[] = [];
  for (const item of stops) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const address =
      readString(row.address) ||
      readString(row.formatted_address) ||
      readString(row.name);
    if (!address) continue;
    out.push({
      address,
      lat: readNumber(row.lat ?? row.latitude) ?? undefined,
      lng: readNumber(row.lng ?? row.longitude) ?? undefined,
    });
  }
  return out;
}

function intermediatesFromTripStops(
  rows: AdminTripStopRow[] | null | undefined,
): AdminTripStopRow[] {
  return (rows ?? [])
    .filter((row) => normalizeType(row.type) === "stop")
    .slice()
    .sort((a, b) => a.stop_index - b.stop_index);
}

function intermediatesFromTripsJson(stopsJson: unknown): AdminTripStopRow[] {
  return parseTripsStopsJson(stopsJson).map((via, index) => ({
    id: `via-${index + 1}`,
    stop_index: index + 1,
    type: "stop",
    address: via.address,
    status: "pending",
  }));
}

/**
 * Prefer trip_stops intermediate rows; if missing, reconstruct from trips.stops JSON.
 * Never treat missing workflow rows as proof the trip is single A→B when vias exist.
 */
export function resolveAdminIntermediateStops(input: {
  trip_stops?: AdminTripStopRow[] | null;
  stops?: unknown;
}): AdminTripStopRow[] {
  const fromTable = intermediatesFromTripStops(input.trip_stops);
  if (fromTable.length > 0) return fromTable;
  return intermediatesFromTripsJson(input.stops);
}

export function resolveAdminActiveTripRouteModel(input: {
  pickup_address?: string | null;
  dropoff_address?: string | null;
  modified_dropoff_address?: string | null;
  current_stop_index?: number | null;
  total_stops?: number | null;
  stops?: unknown;
  trip_stops?: AdminTripStopRow[] | null;
}): AdminActiveTripRouteModel {
  const pickupAddress = readString(input.pickup_address) || "Pickup";
  const dropoffAddress =
    readString(input.modified_dropoff_address) ||
    readString(input.dropoff_address) ||
    "Dropoff";
  const intermediateStops = resolveAdminIntermediateStops({
    trip_stops: input.trip_stops,
    stops: input.stops,
  });
  const intermediateCount = intermediateStops.length;
  const totalStops =
    readNumber(input.total_stops) ?? intermediateCount + 2;
  const currentStopIndex = readNumber(input.current_stop_index);

  let activeLegLabel = dropoffAddress;
  let nextDestinationAddress = dropoffAddress;

  if (currentStopIndex != null && intermediateCount > 0) {
    const maxIntermediate = Math.max(
      ...intermediateStops.map((s) => s.stop_index),
    );
    if (currentStopIndex <= maxIntermediate) {
      const active =
        intermediateStops.find((s) => s.stop_index === currentStopIndex) ??
        intermediateStops.find((s) => s.stop_index >= currentStopIndex) ??
        null;
      if (active) {
        activeLegLabel = active.address || `Stop ${active.stop_index}`;
        nextDestinationAddress = activeLegLabel;
      }
    }
  } else if (intermediateCount > 0 && currentStopIndex == null) {
    const firstPending =
      intermediateStops.find((s) => {
        const status = (s.status ?? "").toLowerCase();
        return (
          status === "current" ||
          status.includes("arrived") ||
          status === "pending" ||
          !status
        );
      }) ?? intermediateStops[0];
    if (firstPending) {
      activeLegLabel = firstPending.address || `Stop ${firstPending.stop_index}`;
      nextDestinationAddress = activeLegLabel;
    }
  }

  return {
    pickupAddress,
    intermediateStops,
    dropoffAddress,
    totalStops: Math.max(totalStops, intermediateCount + 2),
    intermediateCount,
    currentStopIndex,
    activeLegLabel,
    nextDestinationAddress,
    isMultiStop: intermediateCount > 0,
  };
}

/** Compact list-cell lines: pickup, each via, dropoff — never pickup→dropoff only when vias exist. */
export function formatAdminActiveTripRouteLines(
  model: AdminActiveTripRouteModel,
): string[] {
  const lines = [model.pickupAddress];
  for (const stop of model.intermediateStops) {
    lines.push(stop.address || `Stop ${stop.stop_index}`);
  }
  lines.push(model.dropoffAddress);
  return lines;
}
