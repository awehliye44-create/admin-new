/**
 * Fire-and-forget active-trip high-priority push via send-trip-notification.
 * Deduped server-side by stable notificationId = tripId:event.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type CustomerActiveTripNotifyEvent =
  | "driver_assigned"
  | "driver_arrived"
  | "trip_cancelled"
  | "trip_completed"
  | "payment_action_required";

async function resolveCustomerUserId(
  supabase: SupabaseClient,
  tripId: string,
): Promise<string | null> {
  const { data: trip } = await supabase
    .from("trips")
    .select("passenger_id")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip?.passenger_id) return null;
  const { data: cust } = await supabase
    .from("customers")
    .select("user_id")
    .eq("id", trip.passenger_id)
    .maybeSingle();
  return cust?.user_id ?? trip.passenger_id ?? null;
}

export async function notifyCustomerActiveTripEvent(
  supabase: SupabaseClient,
  input: {
    tripId: string;
    event: CustomerActiveTripNotifyEvent;
    userId?: string | null;
    driverName?: string;
    fareDisplay?: string;
  },
): Promise<void> {
  try {
    const userId =
      input.userId ?? (await resolveCustomerUserId(supabase, input.tripId));
    if (!userId) {
      console.warn("[active-trip-notify] no userId", {
        trip_id: input.tripId,
        event: input.event,
      });
      return;
    }
    await supabase.functions.invoke("send-trip-notification", {
      body: {
        userId,
        tripId: input.tripId,
        event: input.event,
        notificationId: `${input.tripId}:${input.event}`,
        driverName: input.driverName,
        fareDisplay: input.fareDisplay,
      },
    });
    console.log("[active-trip-notify] invoked", {
      trip_id: input.tripId,
      event: input.event,
      user_id: userId,
    });
  } catch (e) {
    console.warn("[active-trip-notify] failed", {
      trip_id: input.tripId,
      event: input.event,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
