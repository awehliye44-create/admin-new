import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type CustomerCounterBroadcastPayload = {
  id: string;
  trip_id: string;
  driver_id: string;
  status: string;
  negotiation_status: string;
  customer_counter_fare: number;
  driver_offer_fare?: number | null;
  driver_respond_by: string;
  negotiation_expires_at?: string | null;
  expires_at?: string | null;
  offer_options?: number[] | null;
  customer_respond_by?: string | null;
  grace_window_expires_at?: string | null;
};


async function broadcastOnChannel(
  supabase: SupabaseClient,
  channelName: string,
  event: string,
  payload: Record<string, unknown>,
  logTag: string,
): Promise<boolean> {
  const channel = supabase.channel(channelName);
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      resolve(delivered);
    };

    const timeout = setTimeout(() => {
      console.warn(`[${logTag}] subscribe timeout`, channelName);
      void supabase.removeChannel(channel);
      finish(false);
    }, 3000);

    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      clearTimeout(timeout);
      void channel
        .send({ type: "broadcast", event, payload })
        .then(() => {
          console.log(`[${logTag}] sent`, { channel: channelName, event, payload });
          finish(true);
        })
        .catch((e) => {
          console.warn(`[${logTag}] send failed:`, e);
          finish(false);
        })
        .finally(() => {
          void supabase.removeChannel(channel);
        });
    });
  });
}

export type CustomerDeclinedBroadcastPayload = {
  id: string;
  trip_id: string;
  driver_id: string;
  negotiation_status: string;
  grace_window_expires_at: string;
  negotiation_expires_at: string;
};

/**
 * Realtime broadcast when customer rejects driver's preset (driver grace window).
 * Channel: driver-negotiation:{driverId}, event: customer_declined_driver_offer
 */
export async function broadcastCustomerDeclinedOffer(
  supabase: SupabaseClient,
  payload: CustomerDeclinedBroadcastPayload,
): Promise<void> {
  const driverId = payload.driver_id;
  if (!driverId) return;

  const channelName = `driver-negotiation:${driverId}`;
  const channel = supabase.channel(channelName);

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("[driverNegotiationBroadcast] decline subscribe timeout", channelName);
      void supabase.removeChannel(channel);
      resolve();
    }, 3000);

    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      clearTimeout(timeout);
      void channel
        .send({
          type: "broadcast",
          event: "customer_declined_driver_offer",
          payload: {
            ...payload,
            message: "Rider declined your offer",
          },
        })
        .then(() => {
          console.log("[driverNegotiationBroadcast] REALTIME_TO_DRIVER", {
            event: "customer_declined_driver_offer",
            negotiation_id: payload.id,
            ride_id: payload.trip_id,
            driver_id: driverId,
          });
        })
        .catch((e) => {
          console.warn("[driverNegotiationBroadcast] decline send failed:", e);
        })
        .finally(() => {
          void supabase.removeChannel(channel);
          resolve();
        });
    });
  });
}

/**
 * Realtime broadcast to the locked driver (complements postgres_changes on ride_offers).
 * Channel: driver-negotiation:{driverId}, event: customer_counter_offer_received
 */
export async function broadcastCustomerCounterOffer(
  supabase: SupabaseClient,
  payload: CustomerCounterBroadcastPayload,
): Promise<boolean> {
  const driverId = payload.driver_id;
  if (!driverId) return false;

  const channelName = `driver-negotiation:${driverId}`;
  const delivered = await broadcastOnChannel(
    supabase,
    channelName,
    "customer_counter_offer_received",
    payload as unknown as Record<string, unknown>,
    "driverNegotiationBroadcast",
  );
  if (delivered) {
    console.log("DRIVER_COUNTER_BROADCAST_SENT", {
      event: "customer_counter_offer_received",
      channel: channelName,
      negotiation_id: payload.id,
      ride_id: payload.trip_id,
      driver_id: driverId,
      counter_fare: payload.customer_counter_fare,
      driver_respond_by: payload.driver_respond_by,
    });
  }
  return delivered;
}
