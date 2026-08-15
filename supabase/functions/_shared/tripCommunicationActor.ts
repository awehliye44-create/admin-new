/**
 * Resolve Driver/Customer actor for trip-communication Edges.
 * Looks up profiles with service role, then applies shared participant SSOT.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveTripCommunicationParticipant } from "../../../shared/tripCommunicationSsot.ts";

export type TripCommunicationActor = {
  role: "driver" | "customer";
  assignedDriverId: string | null;
};

export async function resolveTripCommunicationActor(
  admin: SupabaseClient,
  trip: {
    confirmed_driver_id?: string | null;
    driver_id?: string | null;
    passenger_id?: string | null;
  },
  authUserId: string,
): Promise<TripCommunicationActor | null> {
  const uid = String(authUserId ?? "").trim();
  if (!uid) return null;

  const { data: driverRow } = await admin
    .from("drivers")
    .select("id, user_id")
    .eq("user_id", uid)
    .maybeSingle();

  const { data: customerRow } = await admin
    .from("customers")
    .select("id, user_id")
    .eq("user_id", uid)
    .maybeSingle();

  const passengerRef = String(trip.passenger_id ?? "").trim();
  const customerOwnsTrip = Boolean(
    passengerRef &&
      (passengerRef === uid ||
        (customerRow?.id && passengerRef === customerRow.id) ||
        (customerRow?.user_id && passengerRef === customerRow.user_id)),
  );

  const participant = resolveTripCommunicationParticipant({
    authUserId: uid,
    driverProfileId: driverRow?.id ?? null,
    trip: {
      ...trip,
      // Shared SSOT matches passenger_id === authUserId only.
      passenger_id: customerOwnsTrip ? uid : trip.passenger_id,
    },
  });

  if (!participant.ok) return null;
  return {
    role: participant.role,
    assignedDriverId: participant.assignedDriverId,
  };
}
