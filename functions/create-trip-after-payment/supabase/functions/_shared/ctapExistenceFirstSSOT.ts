/**
 * create-trip-after-payment existence-first lookup.
 *
 * When create-preauth / confirm / webhook already finalized this booking, CTAP must
 * return that trip before running booking gates or a Revolut GET — but only to the
 * passenger who owns it. Ownership is trips.passenger_id ∈ customers.id for the caller
 * (trips has no customer_id column).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export const CTAP_EXISTING_TRIP_COLUMNS =
  "id, trip_code, status, special_instructions, passenger_id, client_action_id, provider_order_id";

export type CtapExistingTripRow = {
  id: string;
  trip_code?: string | null;
  status?: string | null;
  special_instructions?: string | null;
  passenger_id?: string | null;
  client_action_id?: string | null;
  provider_order_id?: string | null;
};

export type CallerOwnedTripPick =
  | { kind: "owned"; trip: CtapExistingTripRow; by: "client_action_id" | "provider_order_id" }
  | { kind: "foreign"; tripId: string; by: "client_action_id" | "provider_order_id" }
  | { kind: "none" };

export function isTripOwnedByCaller(
  trip: Pick<CtapExistingTripRow, "passenger_id"> | null | undefined,
  callerCustomerIds: readonly string[],
): boolean {
  const passengerId = String(trip?.passenger_id ?? "").trim();
  return passengerId !== "" && callerCustomerIds.includes(passengerId);
}

export function pickCallerOwnedBookingTrip(args: {
  byClientAction: CtapExistingTripRow | null | undefined;
  byProviderOrder: CtapExistingTripRow | null | undefined;
  callerCustomerIds: readonly string[];
}): CallerOwnedTripPick {
  const candidates: Array<[CtapExistingTripRow | null | undefined, "client_action_id" | "provider_order_id"]> = [
    [args.byClientAction, "client_action_id"],
    [args.byProviderOrder, "provider_order_id"],
  ];
  let foreign: CallerOwnedTripPick | null = null;
  for (const [trip, by] of candidates) {
    if (!trip?.id) continue;
    if (isTripOwnedByCaller(trip, args.callerCustomerIds)) return { kind: "owned", trip, by };
    foreign ??= { kind: "foreign", tripId: trip.id, by };
  }
  return foreign ?? { kind: "none" };
}

/** Three indexed reads in parallel; never throws (a failed read means "continue full path"). */
export async function lookupCallerOwnedBookingTrip(
  supabase: SupabaseClient,
  args: { userId: string; clientActionId: string | null | undefined; providerOrderId: string | null | undefined },
): Promise<CallerOwnedTripPick> {
  const clientActionId = String(args.clientActionId ?? "").trim();
  const providerOrderId = String(args.providerOrderId ?? "").trim();
  if (!args.userId || (!clientActionId && !providerOrderId)) return { kind: "none" };
  try {
    const [customersRes, byCaRes, byOrderRes] = await Promise.all([
      supabase.from("customers").select("id").eq("user_id", args.userId).limit(5),
      clientActionId
        ? supabase.from("trips").select(CTAP_EXISTING_TRIP_COLUMNS).eq("client_action_id", clientActionId).limit(1)
        : Promise.resolve({ data: [], error: null }),
      providerOrderId
        ? supabase.from("trips").select(CTAP_EXISTING_TRIP_COLUMNS).eq("provider_order_id", providerOrderId).limit(1)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (customersRes.error || byCaRes.error || byOrderRes.error) return { kind: "none" };
    const callerCustomerIds = ((customersRes.data ?? []) as Array<{ id: string }>).map((r) => String(r.id));
    return pickCallerOwnedBookingTrip({
      byClientAction: (byCaRes.data as CtapExistingTripRow[] | null)?.[0] ?? null,
      byProviderOrder: (byOrderRes.data as CtapExistingTripRow[] | null)?.[0] ?? null,
      callerCustomerIds,
    });
  } catch {
    return { kind: "none" };
  }
}
