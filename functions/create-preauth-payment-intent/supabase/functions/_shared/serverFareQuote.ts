/**
 * Server-authoritative fare quote for payment authorisation.
 * Calls estimate-fare (service role) from the booking route — never trusts a
 * client-supplied fare amount.
 */
type Loc = { lat?: unknown; lng?: unknown };

export type ServerFareQuoteResult =
  | { ok: true; totalFarePence: number }
  | { ok: false; reason: string };

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function quoteFareServerSide(input: {
  serviceAreaId: string | null;
  vehicleTypeId: string | null;
  bookingSnapshot: Record<string, unknown> | null;
}): Promise<ServerFareQuoteResult> {
  const snap = input.bookingSnapshot ?? {};
  const pickup = (snap.pickup ?? {}) as Loc;
  const dropoff = (snap.dropoff ?? {}) as Loc;
  const stops = Array.isArray(snap.stops) ? (snap.stops as Loc[]) : [];
  const vehicleTypeId = String(input.vehicleTypeId ?? snap.vehicle_type_id ?? snap.selected_service_id ?? "").trim();
  const serviceAreaId = String(input.serviceAreaId ?? snap.service_area_id ?? "").trim();

  const pLat = num(pickup.lat), pLng = num(pickup.lng), dLat = num(dropoff.lat), dLng = num(dropoff.lng);
  if (!serviceAreaId || !vehicleTypeId || pLat == null || pLng == null || dLat == null || dLng == null) {
    return { ok: false, reason: "BOOKING_ROUTE_INCOMPLETE" };
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { ok: false, reason: "SERVER_MISCONFIGURED" };

  const waypoints = stops
    .map((s) => ({ lat: num(s.lat), lng: num(s.lng) }))
    .filter((s) => s.lat != null && s.lng != null);

  try {
    const res = await fetch(`${url}/functions/v1/estimate-fare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({
        service_area_id: serviceAreaId,
        vehicle_type_id: vehicleTypeId,
        pickup_lat: pLat,
        pickup_lng: pLng,
        dropoff_lat: dLat,
        dropoff_lng: dLng,
        stops_count: waypoints.length,
        waypoints,
      }),
    });
    if (!res.ok) return { ok: false, reason: `QUOTE_HTTP_${res.status}` };
    const data = await res.json() as { totalFarePence?: unknown };
    const total = Math.round(Number(data.totalFarePence));
    if (!Number.isFinite(total) || total <= 0) return { ok: false, reason: "QUOTE_INVALID" };
    return { ok: true, totalFarePence: total };
  } catch (e) {
    return { ok: false, reason: `QUOTE_FAILED:${String(e).slice(0, 120)}` };
  }
}
