/**
 * Terminal trip guard — once expired/cancelled/completed, never re-dispatch.
 * Used by scheduled-dispatch, auto-dispatch, expire-offers, and reminder loops.
 */ export const TERMINAL_TRIP_STATUSES_FOR_DISPATCH = new Set([
  "cancelled",
  "customer_cancelled",
  "expired",
  "expired_no_driver",
  "completed",
  "declined"
]);
export const TERMINAL_SCHEDULED_STATUSES_FOR_DISPATCH = new Set([
  "cancelled",
  "expired",
  "no_driver_found"
]);
export const TERMINAL_DISPATCH_STATUSES_FOR_DISPATCH = new Set([
  "expired",
  "cancelled"
]);
export function isTripTerminalForDispatch(trip) {
  if (!trip) return false;
  const status = String(trip.status ?? "").toLowerCase();
  if (status && TERMINAL_TRIP_STATUSES_FOR_DISPATCH.has(status)) {
    return true;
  }
  const scheduledStatus = String(trip.scheduled_status ?? "").toLowerCase();
  if (scheduledStatus && TERMINAL_SCHEDULED_STATUSES_FOR_DISPATCH.has(scheduledStatus)) {
    return true;
  }
  const dispatchStatus = String(trip.dispatch_status ?? "").toLowerCase();
  if (dispatchStatus && TERMINAL_DISPATCH_STATUSES_FOR_DISPATCH.has(dispatchStatus)) {
    return true;
  }
  return false;
}
export function blockedTerminalTripLogPayload(trip, context, extra = {}) {
  return {
    event: "blocked_terminal_trip",
    context,
    trip_status: trip.status ?? null,
    scheduled_status: trip.scheduled_status ?? null,
    dispatch_status: trip.dispatch_status ?? null,
    ...extra
  };
}
/** Pure filter when trip rows are already loaded. */ export function filterNonTerminalTrips(trips) {
  return trips.filter((trip)=>!isTripTerminalForDispatch(trip));
}
/** Pure filter for trip id lists when status map is available. */ export function filterNonTerminalTripIds(tripIds, tripById) {
  return tripIds.filter((id)=>{
    const trip = tripById.get(id);
    return trip ? !isTripTerminalForDispatch(trip) : true;
  });
}
/** Load terminal fields for trip ids and drop terminal trips from rebroadcast/recovery lists. */ export async function filterTripIdsExcludingTerminal(supabase, tripIds) {
  const uniqueIds = [
    ...new Set(tripIds.filter(Boolean))
  ];
  if (uniqueIds.length === 0) return [];
  const { data, error } = await supabase.from("trips").select("id, status, scheduled_status, dispatch_status").in("id", uniqueIds);
  if (error) {
    console.warn("[tripTerminalDispatch] terminal filter query failed:", error);
    return uniqueIds;
  }
  const tripById = new Map();
  for (const row of data ?? []){
    const typed = row;
    if (typed.id) tripById.set(typed.id, typed);
  }
  return filterNonTerminalTripIds(uniqueIds, tripById);
}
/** Revoke live pending offers when a trip enters terminal dispatch state. */ export async function revokePendingOffersForTerminalTrip(supabase, tripId, revokedReason = "trip_terminal") {
  const { error } = await supabase.from("ride_offers").update({
    status: "revoked",
    revoked_reason: revokedReason,
    updated_at: new Date().toISOString()
  }).eq("trip_id", tripId).eq("status", "pending");
  if (error) {
    console.warn("[tripTerminalDispatch] revoke pending offers failed:", tripId, error);
    return 0;
  }
  return 1;
}
