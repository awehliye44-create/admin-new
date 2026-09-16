/**
 * Recover intermediate stops from payment-session fare_quote_id fingerprints.
 *
 * Customer quote fingerprints look like:
 *   pickup=…;dest=…;stops=ChIJ…:52.00,-0.79|place:51.99,-0.80;mode=now;sched=
 *
 * Booking historically dropped body.stops while the charged quote still encoded
 * vias — trips then landed with stops=[] / total_stops=0 and Driver cards hid
 * the +N chip (MK-260916).
 */

export type FareQuoteStop = {
  address: string;
  lat: number;
  lng: number;
  place_id?: string;
};

export function parseStopsFromFareQuoteId(
  fareQuoteId: string | null | undefined,
): FareQuoteStop[] {
  if (typeof fareQuoteId !== "string" || !fareQuoteId.trim()) return [];
  const stopsSeg = fareQuoteId
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.toLowerCase().startsWith("stops="));
  if (!stopsSeg) return [];
  const raw = stopsSeg.slice(stopsSeg.indexOf("=") + 1).trim();
  if (!raw) return [];

  const out: FareQuoteStop[] = [];
  for (const token of raw.split("|")) {
    const t = token.trim();
    if (!t || t === "none") continue;
    const colon = t.lastIndexOf(":");
    if (colon < 0) continue;
    const placeId = t.slice(0, colon).trim();
    const coord = t.slice(colon + 1).trim();
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
 * Prefer explicit booking body stops; fall back to fare_quote_id vias.
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
