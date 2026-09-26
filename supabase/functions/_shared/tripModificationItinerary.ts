/**
 * Canonical itinerary rebuild for trip modifications.
 * Order is always: pickup (0) → intermediate stops (1..n) → dropoff (n+1).
 * Never append an intermediate after dropoff.
 *
 * Past stops are immutable. Modifications only change the remaining route:
 * future (unlocked) intermediates + final drop-off.
 */

export type ItineraryStop = {
  address: string;
  lat: number;
  lng: number;
  type?: string;
  stop_index?: number;
  status?: string;
};

export type ItineraryDropoff = {
  address: string;
  lat: number;
  lng: number;
};

const STATUS_LOCKED = new Set(["completed", "skipped", "arrived", "departed"]);

const PRE_PICKUP_STATUSES = new Set([
  "accepted",
  "confirmed",
  "driver_assigned",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
]);

function hasValidCoords(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    !(lat === 0 && lng === 0)
  );
}

function asType(stop: ItineraryStop): string {
  return String(stop.type ?? "stop").toLowerCase().replace(/-/g, "_");
}

function isIntermediateType(type: string): boolean {
  return type === "stop" || type === "via" || type === "intermediate" || type === "";
}

/** Status-based lock (completed / arrived / skipped / departed). */
export function isStatusLockedStop(stop: ItineraryStop): boolean {
  return STATUS_LOCKED.has(String(stop.status ?? "").toLowerCase());
}

/** Current navigation target index (pickup pre-trip, else first unlocked non-pickup). */
export function resolveNavStopIndex(
  stops: ItineraryStop[],
  tripStatus: string,
): number | null {
  const sorted = [...stops].sort((a, b) => (a.stop_index ?? 0) - (b.stop_index ?? 0));
  const status = String(tripStatus ?? "").toLowerCase();
  if (PRE_PICKUP_STATUSES.has(status)) {
    const pickup = sorted.find((s) => asType(s) === "pickup");
    return pickup?.stop_index ?? 0;
  }
  const nav =
    sorted.find((s) => asType(s) !== "pickup" && !isStatusLockedStop(s)) ??
    sorted.find((s) => {
      const t = asType(s);
      return t === "dropoff" || t === "drop_off" || t === "destination";
    });
  return nav?.stop_index ?? null;
}

/**
 * Past intermediate = status-locked OR behind the current navigation index.
 * Only future intermediates + final drop-off are mutable.
 */
export function isPastIntermediateStop(
  stop: ItineraryStop,
  allStops: ItineraryStop[],
  tripStatus: string,
): boolean {
  if (!isIntermediateType(asType(stop))) return false;
  if (isStatusLockedStop(stop)) return true;
  const navIdx = resolveNavStopIndex(allStops, tripStatus);
  if (navIdx == null) return false;
  return (stop.stop_index ?? -1) < navIdx;
}

/** Split a flat stop list into pickup / intermediates / dropoff. */
export function partitionItineraryStops(stops: ItineraryStop[]): {
  pickup: ItineraryStop | null;
  intermediates: ItineraryStop[];
  dropoff: ItineraryStop | null;
} {
  let pickup: ItineraryStop | null = null;
  let dropoff: ItineraryStop | null = null;
  const intermediates: ItineraryStop[] = [];
  for (const stop of stops) {
    const t = asType(stop);
    if (t === "pickup") pickup = stop;
    else if (t === "dropoff" || t === "drop_off" || t === "destination") dropoff = stop;
    else intermediates.push(stop);
  }
  return { pickup, intermediates, dropoff };
}

/**
 * Final intended route must include a valid dropoff waypoint.
 * Stops are optional; destination is mandatory.
 */
export function assertFinalDropoffRequired(args: {
  dropoff: { address?: string | null; lat?: number | null; lng?: number | null } | null | undefined;
  stops: ItineraryStop[];
}): { ok: true } | { ok: false; error: string; code: "DROPOFF_REQUIRED" } {
  const address = String(args.dropoff?.address ?? "").trim();
  if (!address || !hasValidCoords(args.dropoff?.lat, args.dropoff?.lng)) {
    return {
      ok: false,
      error: "Final drop-off is required. Please choose a destination.",
      code: "DROPOFF_REQUIRED",
    };
  }

  const parts = partitionItineraryStops(args.stops);
  if (
    !parts.dropoff ||
    !String(parts.dropoff.address ?? "").trim() ||
    !hasValidCoords(parts.dropoff.lat, parts.dropoff.lng)
  ) {
    return {
      ok: false,
      error: "Final drop-off is required. Please choose a destination.",
      code: "DROPOFF_REQUIRED",
    };
  }

  const sorted = [...args.stops].sort((a, b) => (a.stop_index ?? 0) - (b.stop_index ?? 0));
  const last = sorted[sorted.length - 1];
  const lastType = asType(last ?? { address: "", lat: 0, lng: 0, type: "" });
  if (!last || (lastType !== "dropoff" && lastType !== "drop_off" && lastType !== "destination")) {
    return {
      ok: false,
      error: "Final drop-off is required. Please choose a destination.",
      code: "DROPOFF_REQUIRED",
    };
  }

  return { ok: true };
}

/**
 * Rebuild a contiguous itinerary. Intermediates are always inserted before dropoff.
 * Preserves each intermediate's status when provided (past completed stays completed).
 */
export function rebuildItineraryStops(args: {
  pickup: ItineraryStop;
  intermediates: ItineraryStop[];
  dropoff: ItineraryDropoff;
}): ItineraryStop[] {
  const intermediates = args.intermediates.map((stop, index) => ({
    address: stop.address,
    lat: stop.lat,
    lng: stop.lng,
    type: "stop",
    status: stop.status ?? "pending",
    stop_index: index + 1,
  }));
  return [
    {
      address: args.pickup.address,
      lat: args.pickup.lat,
      lng: args.pickup.lng,
      type: "pickup",
      status: args.pickup.status ?? "pending",
      stop_index: 0,
    },
    ...intermediates,
    {
      address: args.dropoff.address,
      lat: args.dropoff.lat,
      lng: args.dropoff.lng,
      type: "dropoff",
      status: "pending",
      stop_index: intermediates.length + 1,
    },
  ];
}

/**
 * Authoritative remaining-route rebuild:
 * past intermediates from `beforeStops` stay immutable; only `futureIntermediates`
 * + dropoff may change.
 */
export function rebuildRemainingRouteItinerary(args: {
  beforeStops: ItineraryStop[];
  futureIntermediates: ItineraryStop[];
  dropoff: ItineraryDropoff;
  tripStatus: string;
  pickupFallback?: ItineraryDropoff;
}): ItineraryStop[] {
  const parts = partitionItineraryStops(args.beforeStops);
  const pickup = parts.pickup ?? {
    address: args.pickupFallback?.address ?? "",
    lat: args.pickupFallback?.lat ?? 0,
    lng: args.pickupFallback?.lng ?? 0,
    type: "pickup",
    status: "pending",
    stop_index: 0,
  };
  const past = parts.intermediates.filter((s) =>
    isPastIntermediateStop(s, args.beforeStops, args.tripStatus),
  );
  return rebuildItineraryStops({
    pickup,
    intermediates: [
      ...past.map((s) => ({
        address: s.address,
        lat: s.lat,
        lng: s.lng,
        type: "stop",
        status: s.status ?? "completed",
      })),
      ...args.futureIntermediates.map((s) => ({
        address: s.address,
        lat: s.lat,
        lng: s.lng,
        type: "stop",
        status: "pending",
      })),
    ],
    dropoff: args.dropoff,
  });
}

/** Insert new intermediate stops before dropoff and reindex. */
export function appendIntermediateStops(args: {
  stops: ItineraryStop[];
  pickupFallback: ItineraryDropoff;
  dropoffFallback: ItineraryDropoff;
  toAdd: ItineraryStop[];
}): ItineraryStop[] {
  const parts = partitionItineraryStops(args.stops);
  const pickup = parts.pickup ?? {
    ...args.pickupFallback,
    type: "pickup",
    status: "pending",
    stop_index: 0,
  };
  const dropoff = parts.dropoff
    ? { address: parts.dropoff.address, lat: parts.dropoff.lat, lng: parts.dropoff.lng }
    : args.dropoffFallback;
  return rebuildItineraryStops({
    pickup,
    intermediates: [...parts.intermediates, ...args.toAdd],
    dropoff,
  });
}

/** Remove one intermediate by stop_index and reindex contiguously. */
export function removeIntermediateStop(args: {
  stops: ItineraryStop[];
  stopIndexToRemove: number;
  pickupFallback: ItineraryDropoff;
  dropoffFallback: ItineraryDropoff;
  tripStatus?: string;
}): { ok: true; stops: ItineraryStop[] } | { ok: false; reason: "not_found" | "locked" } {
  const parts = partitionItineraryStops(args.stops);
  const target = parts.intermediates.find(
    (s) => (s.stop_index ?? -1) === args.stopIndexToRemove,
  );
  if (!target) return { ok: false, reason: "not_found" };
  if (
    isPastIntermediateStop(target, args.stops, args.tripStatus ?? "") ||
    isStatusLockedStop(target)
  ) {
    return { ok: false, reason: "locked" };
  }
  const pickup = parts.pickup ?? {
    ...args.pickupFallback,
    type: "pickup",
    status: "pending",
    stop_index: 0,
  };
  const dropoff = parts.dropoff
    ? { address: parts.dropoff.address, lat: parts.dropoff.lat, lng: parts.dropoff.lng }
    : args.dropoffFallback;
  return {
    ok: true,
    stops: rebuildItineraryStops({
      pickup,
      intermediates: parts.intermediates.filter(
        (s) => (s.stop_index ?? -1) !== args.stopIndexToRemove,
      ),
      dropoff,
    }),
  };
}
