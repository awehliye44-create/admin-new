/** Server-side route + fare pricing SSOT for bookings (never trust client fares). */
export async function resolveAuthoritativeFare(
  supabaseUrl: string,
  invokeHeaders: Record<string, string>,
  input: {
    serviceAreaId: string;
    vehicleTypeId: string;
    pickupLat: number;
    pickupLng: number;
    dropoffLat: number;
    dropoffLng: number;
    stops: Array<{ lat: number; lng: number }>;
  },
): Promise<{ amountPence: number; distanceKm: number; durationMin: number } | { error: string }> {
  const routeRes = await fetch(`${supabaseUrl}/functions/v1/calculate-route`, {
    method: "POST",
    headers: invokeHeaders,
    body: JSON.stringify({
      originLat: input.pickupLat,
      originLng: input.pickupLng,
      destLat: input.dropoffLat,
      destLng: input.dropoffLng,
      intermediateStops: input.stops,
    }),
  });
  const route = await routeRes.json().catch(() => ({})) as {
    success?: boolean;
    distanceKm?: number;
    durationMinutes?: number;
    error?: string;
  };
  if (!routeRes.ok || route.success === false || typeof route.distanceKm !== "number") {
    return { error: route.error || "Route could not be priced" };
  }
  const fareRes = await fetch(`${supabaseUrl}/functions/v1/calculate-fare`, {
    method: "POST",
    headers: invokeHeaders,
    body: JSON.stringify({
      service_area_id: input.serviceAreaId,
      estimated_distance_km: route.distanceKm,
      estimated_duration_min: route.durationMinutes ?? 0,
      vehicle_type_id: input.vehicleTypeId,
      pickup: { lat: input.pickupLat, lng: input.pickupLng },
      dropoff: { lat: input.dropoffLat, lng: input.dropoffLng },
      stops: input.stops,
    }),
  });
  const fare = await fareRes.json().catch(() => ({})) as {
    success?: boolean;
    error?: string;
    vehicleFares?: Array<{
      vehicleTypeId?: string;
      fare?: { totalFarePence?: number };
    }>;
  };
  if (!fareRes.ok || fare.success === false) {
    return { error: fare.error || "Fare could not be calculated" };
  }
  const match = (fare.vehicleFares ?? []).find((row) => row.vehicleTypeId === input.vehicleTypeId);
  const amountPence = match?.fare?.totalFarePence;
  if (typeof amountPence !== "number" || amountPence < 50) {
    return { error: "Selected vehicle has no payable fare" };
  }
  return {
    amountPence: Math.round(amountPence),
    distanceKm: route.distanceKm,
    durationMin: route.durationMinutes ?? 0,
  };
}
