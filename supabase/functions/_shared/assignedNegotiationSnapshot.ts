/**
 * Authoritative assigned-trip fields returned after fare agreement.
 * Driver and Customer must render this SSOT — never invent assigned state.
 */

export const ASSIGNED_NEGOTIATION_TRIP_SELECT =
  "id, status, dispatch_status, driver_id, confirmed_driver_id, negotiation_owner_driver_id, fare, gross_fare_pence, final_fare_pence, final_customer_fare_pence, fare_locked, commission_pence, driver_net_pence, driver_tier_commission_percent, fare_snapshot_json";

export type AssignedNegotiationSnapshot = {
  id: string;
  trip_id: string;
  status: string;
  dispatch_status: string | null;
  driver_id: string | null;
  confirmed_driver_id: string | null;
  negotiation_owner_driver_id: string | null;
  fare: number | null;
  gross_fare_pence: number | null;
  final_fare_pence: number | null;
  final_customer_fare_pence: number | null;
  fare_locked: boolean | null;
  commission_pence: number | null;
  driver_net_pence: number | null;
  driver_tier_commission_percent: number | null;
  fare_source: string | null;
  negotiation_status: "closed";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildAssignedNegotiationSnapshot(
  tripAfter: Record<string, unknown> | null | undefined,
  extras?: { fareSource?: string | null; tripId?: string },
): AssignedNegotiationSnapshot | null {
  if (!tripAfter) return null;
  const id = asString(tripAfter.id) ?? asString(extras?.tripId);
  if (!id) return null;
  const snapshotJson = asRecord(tripAfter.fare_snapshot_json);
  const fareSource =
    asString(snapshotJson?.fare_source) ??
    asString(extras?.fareSource) ??
    null;
  return {
    id,
    trip_id: id,
    status: asString(tripAfter.status) ?? "driver_assigned",
    dispatch_status: asString(tripAfter.dispatch_status),
    driver_id: asString(tripAfter.driver_id),
    confirmed_driver_id: asString(tripAfter.confirmed_driver_id) ?? asString(tripAfter.driver_id),
    negotiation_owner_driver_id: asString(tripAfter.negotiation_owner_driver_id),
    fare: asNumber(tripAfter.fare),
    gross_fare_pence: asNumber(tripAfter.gross_fare_pence),
    final_fare_pence: asNumber(tripAfter.final_fare_pence),
    final_customer_fare_pence: asNumber(tripAfter.final_customer_fare_pence),
    fare_locked: typeof tripAfter.fare_locked === "boolean" ? tripAfter.fare_locked : null,
    commission_pence: asNumber(tripAfter.commission_pence),
    driver_net_pence: asNumber(tripAfter.driver_net_pence),
    driver_tier_commission_percent: asNumber(tripAfter.driver_tier_commission_percent),
    fare_source: fareSource,
    negotiation_status: "closed",
  };
}

export function assignedNegotiationSuccessBody(args: {
  tripId: string;
  offerId: string;
  driverId: string;
  snapshot: AssignedNegotiationSnapshot | null;
  fallbackFarePence: number;
  fallbackFareSource: string;
}): Record<string, unknown> {
  const trip: AssignedNegotiationSnapshot = args.snapshot ?? {
    id: args.tripId,
    trip_id: args.tripId,
    status: "driver_assigned",
    dispatch_status: "assigned",
    driver_id: args.driverId,
    confirmed_driver_id: args.driverId,
    negotiation_owner_driver_id: null,
    fare: null,
    gross_fare_pence: args.fallbackFarePence,
    final_fare_pence: args.fallbackFarePence,
    final_customer_fare_pence: args.fallbackFarePence,
    fare_locked: true,
    commission_pence: null,
    driver_net_pence: null,
    driver_tier_commission_percent: null,
    fare_source: args.fallbackFareSource,
    negotiation_status: "closed",
  };
  return {
    success: true,
    action: "ACCEPTED",
    trip_id: trip.trip_id,
    offer_id: args.offerId,
    status: trip.status,
    dispatch_status: trip.dispatch_status,
    driver_id: trip.driver_id ?? args.driverId,
    confirmed_driver_id: trip.confirmed_driver_id ?? args.driverId,
    final_fare_pence: trip.final_fare_pence ?? args.fallbackFarePence,
    final_customer_fare_pence: trip.final_customer_fare_pence ??
      trip.final_fare_pence ??
      args.fallbackFarePence,
    driver_net_pence: trip.driver_net_pence,
    commission_pence: trip.commission_pence,
    fare_source: trip.fare_source ?? args.fallbackFareSource,
    negotiation_status: "closed",
    trip,
  };
}
