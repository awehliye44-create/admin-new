/**
 * Stale / accepted-elsewhere ride-offer push gate.
 * Rehydrates from ride_offers — never trusts notification fare as authority.
 */

// deno-lint-ignore no-explicit-any
type Sb = any;

export type RideOfferPushIds = {
  offerId: string;
  tripId: string;
  expiresAtHint: string | null;
};

export type RideOfferPushGate = {
  allowed: boolean;
  reason?: string;
  offerId?: string | null;
  tripId?: string | null;
};

export function extractOfferPushIds(
  data: Record<string, unknown> | null | undefined,
): RideOfferPushIds {
  const d = data ?? {};
  const offerId = String(
    d.offerId ?? d.offer_id ?? d.requestId ?? d.request_id ?? "",
  ).trim();
  const tripId = String(
    d.tripId ?? d.trip_id ?? d.bookingId ?? d.booking_id ?? "",
  ).trim();
  const expiresAtHintRaw = d.expires_at ?? d.expiresAt ?? null;
  const expiresAtHint =
    typeof expiresAtHintRaw === "string" && expiresAtHintRaw.trim()
      ? expiresAtHintRaw.trim()
      : null;
  return { offerId, tripId, expiresAtHint };
}

export async function validateRideOfferPushEligibility(
  supabase: Sb,
  input: {
    driverId: string;
    offerId: string;
    tripId: string;
    expiresAtHint?: string | null;
    verifyDriverState?: boolean;
  },
): Promise<RideOfferPushGate> {
  if (!input.offerId && !input.tripId) {
    return { allowed: false, reason: "missing_offer_ids" };
  }

  let query = supabase
    .from("ride_offers")
    .select("id, trip_id, driver_id, status, expires_at")
    .eq("driver_id", input.driverId)
    .limit(1);

  if (input.offerId) {
    query = query.eq("id", input.offerId);
  } else {
    query = query.eq("trip_id", input.tripId).eq("status", "pending");
  }

  const { data: offer, error } = await query.maybeSingle();
  if (error) {
    console.error("[rideOfferPushEligibility] lookup failed", error.message);
    return { allowed: false, reason: "offer_lookup_failed" };
  }
  if (!offer) {
    return {
      allowed: false,
      reason: "offer_not_found_or_not_owned",
      offerId: input.offerId || null,
      tripId: input.tripId || null,
    };
  }

  const status = String(offer.status ?? "").toLowerCase();
  if (status !== "pending") {
    return {
      allowed: false,
      reason: status === "accepted" || status === "accepted_by_other"
        ? "accepted_by_another_or_self"
        : `offer_status:${status || "unknown"}`,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  const expiresAt = offer.expires_at
    ? new Date(offer.expires_at).getTime()
    : input.expiresAtHint
    ? new Date(input.expiresAtHint).getTime()
    : null;

  if (expiresAt != null && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    return {
      allowed: false,
      reason: "offer_expired",
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  return {
    allowed: true,
    offerId: offer.id,
    tripId: offer.trip_id,
  };
}

export function logRideOfferPushBlocked(
  source: string,
  info: {
    driverId: string;
    offerId?: string | null;
    tripId?: string | null;
    reason?: string;
    notificationType?: string;
  },
): void {
  console.warn(
    `[${source}] ride_offer_push_blocked driver=${info.driverId} offer=${info.offerId ?? "n/a"} trip=${info.tripId ?? "n/a"} reason=${info.reason ?? "unknown"} type=${info.notificationType ?? ""}`,
  );
}
