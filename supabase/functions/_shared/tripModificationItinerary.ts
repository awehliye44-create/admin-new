/**
 * Canonical itinerary rebuild for trip modifications.
 * Order is always: pickup (0) → intermediate stops (1..n) → dropoff (n+1).
 * Never append an intermediate after dropoff.
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

function asType(stop: ItineraryStop): string {
  return String(stop.type ?? "stop").toLowerCase().replace(/-/g, "_");
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
 * Rebuild a contiguous itinerary. Intermediates are always inserted before dropoff.
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
}): { ok: true; stops: ItineraryStop[] } | { ok: false; reason: "not_found" | "locked" } {
  const parts = partitionItineraryStops(args.stops);
  const target = parts.intermediates.find(
    (s) => (s.stop_index ?? -1) === args.stopIndexToRemove,
  );
  if (!target) return { ok: false, reason: "not_found" };
  const status = String(target.status ?? "").toLowerCase();
  if (status === "completed" || status === "skipped" || status === "arrived") {
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
