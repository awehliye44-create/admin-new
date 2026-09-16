/**
 * Recover intermediate stops from payment-session fare_quote_id fingerprints.
 *
 * Customer quote fingerprints look like:
 *   pickup=…;dest=…;stops=ChIJ…:52.00,-0.79|place:51.99,-0.80;mode=now;sched=
 *
 * Incomplete draft stops may appear as `stop-<ms>:na` when Plan adds a placeholder
 * before the customer picks a place. Those must still count toward total_stops so
 * the Driver +N chip shows, while coordinate recovery prefers body.stops.
 */

export type FareQuoteStop = {
  address: string;
  lat: number;
  lng: number;
  place_id?: string;
};

function fareQuoteStopsSegment(
  fareQuoteId: string | null | undefined,
): string {
  if (typeof fareQuoteId !== "string" || !fareQuoteId.trim()) return "";
  const stopsSeg = fareQuoteId
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.toLowerCase().startsWith("stops="));
  if (!stopsSeg) return "";
  return stopsSeg.slice(stopsSeg.indexOf("=") + 1).trim();
}

/** Count declared via tokens in the fingerprint (including incomplete `:na`). */
export function countDeclaredFareQuoteStops(
  fareQuoteId: string | null | undefined,
): number {
  const raw = fareQuoteStopsSegment(fareQuoteId);
  if (!raw) return 0;
  let n = 0;
  for (const token of raw.split("|")) {
    const t = token.trim();
    if (!t || t === "none") continue;
    n += 1;
  }
  return n;
}

export function parseStopsFromFareQuoteId(
  fareQuoteId: string | null | undefined,
): FareQuoteStop[] {
  const raw = fareQuoteStopsSegment(fareQuoteId);
  if (!raw) return [];

  const out: FareQuoteStop[] = [];
  for (const token of raw.split("|")) {
    const t = token.trim();
    if (!t || t === "none") continue;
    const colon = t.lastIndexOf(":");
    if (colon < 0) continue;
    const placeId = t.slice(0, colon).trim();
    const coord = t.slice(colon + 1).trim();
    if (!coord || coord.toLowerCase() === "na") continue;
    const [latRaw, lngRaw] = coord.split(",");
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.push({
      address: placeId && placeId !== "none" ? placeId : "Stop",
      lat,
      lng,
      ...(placeId && placeId !== "none" ? { place_id: placeId } : {}),
    });
  }
  return out;
}

export function normalizeBookingStops(
  stops: unknown,
): Array<{ address: string; lat: number; lng: number }> {
  if (!Array.isArray(stops)) return [];
  const out: Array<{ address: string; lat: number; lng: number }> = [];
  for (const item of stops) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const lat = Number(row.lat ?? row.latitude);
    const lng = Number(row.lng ?? row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const address = String(row.address ?? row.name ?? row.title ?? "Stop").trim() ||
      "Stop";
    out.push({ address, lat, lng });
  }
  return out;
}

/**
 * Prefer explicit booking body stops; fall back to fare_quote_id vias with coords.
 */
export function resolveBookingIntermediateStops(args: {
  bodyStops: unknown;
  fareQuoteId?: string | null;
}): Array<{ address: string; lat: number; lng: number }> {
  const fromBody = normalizeBookingStops(args.bodyStops);
  if (fromBody.length > 0) return fromBody;
  return parseStopsFromFareQuoteId(args.fareQuoteId).map((s) => ({
    address: s.address,
    lat: s.lat,
    lng: s.lng,
  }));
}

export function totalStopsFromIntermediateCount(viaCount: number): number {
  const n = Number.isFinite(viaCount) && viaCount > 0 ? Math.floor(viaCount) : 0;
  return 2 + Math.max(0, n);
}

/**
 * total_stops for trip insert: body vias → parsed coords → declared fingerprint slots.
 * Declared `:na` placeholders still bump the count so Driver can show +N.
 */
export function resolveBookingTotalStops(args: {
  bodyStops: unknown;
  fareQuoteId?: string | null;
}): {
  intermediateStops: Array<{ address: string; lat: number; lng: number }>;
  totalStops: number;
} {
  const intermediateStops = resolveBookingIntermediateStops(args);
  if (intermediateStops.length > 0) {
    return {
      intermediateStops,
      totalStops: totalStopsFromIntermediateCount(intermediateStops.length),
    };
  }
  const declared = countDeclaredFareQuoteStops(args.fareQuoteId);
  return {
    intermediateStops: [],
    totalStops: totalStopsFromIntermediateCount(declared),
  };
}
