/**
 * Customer trip-lifecycle push — single producer path via send-trip-notification.
 *
 * Canonical events: driver_assigned | driver_arrived | trip_started |
 * trip_completed | trip_cancelled.
 *
 * Do not send trip_cancelled for searching_new_driver rematch.
 * Do not fan out tokens here — send-trip-notification uses the authoritative
 * Customer device-token resolver.
 */

export const CUSTOMER_TRIP_LIFECYCLE_EVENTS = [
  "driver_assigned",
  "driver_arrived",
  "trip_started",
  "trip_completed",
  "trip_cancelled",
] as const;

export type CustomerTripLifecycleEvent =
  (typeof CUSTOMER_TRIP_LIFECYCLE_EVENTS)[number];

/** Per-event versioned Android channels — one sound per channel. */
export const CUSTOMER_ANDROID_CHANNEL_BY_EVENT: Record<string, string> = {
  driver_assigned: "onecab_driver_assigned_v1",
  trip_accepted: "onecab_driver_assigned_v1",
  new_driver_assigned: "onecab_driver_assigned_v1",
  stacked_driver_assigned: "onecab_driver_assigned_v1",
  driver_approaching: "onecab_driver_assigned_v1",
  driver_arrived: "onecab_driver_arrived_v1",
  waiting_started: "onecab_driver_arrived_v1",
  trip_started: "onecab_trip_started_v1",
  trip_completed: "onecab_trip_completed_v1",
  rating_request: "onecab_trip_completed_v1",
  trip_cancelled: "onecab_trip_cancelled_v1",
  no_show: "onecab_trip_cancelled_v1",
  customer_new_message: "onecab_customer_messages_v1",
  customer_new_fare_offer: "onecab_customer_general_v1",
  driver_accepted_counter: "onecab_customer_general_v1",
  finding_another_driver_updated_fare: "onecab_customer_general_v1",
  negotiation_offer_expired: "onecab_customer_general_v1",
  driver_cancelled: "onecab_customer_general_v1",
  payment_success: "onecab_customer_general_v1",
  payment_failed: "onecab_customer_general_v1",
  fare_updated: "onecab_customer_general_v1",
  traffic_delay: "onecab_customer_updates_v1",
  route_changed: "onecab_customer_updates_v1",
  safety_reminder: "onecab_customer_updates_v1",
  lost_item_followup: "onecab_customer_general_v1",
  high_demand: "onecab_customer_general_v1",
};

/** Android res/raw name (no extension) for FCM notification.sound. */
export const CUSTOMER_ANDROID_SOUND_BY_EVENT: Record<string, string> = {
  driver_assigned: "driver_assigned",
  trip_accepted: "driver_assigned",
  new_driver_assigned: "driver_assigned",
  stacked_driver_assigned: "driver_assigned",
  driver_approaching: "driver_assigned",
  driver_arrived: "driver_arrived",
  waiting_started: "driver_arrived",
  trip_started: "trip_started",
  trip_completed: "trip_completed",
  rating_request: "trip_completed",
  trip_cancelled: "trip_cancelled",
  no_show: "trip_cancelled",
  customer_new_message: "message_received",
  customer_new_fare_offer: "general_notification",
  driver_accepted_counter: "general_notification",
  finding_another_driver_updated_fare: "general_notification",
  negotiation_offer_expired: "general_notification",
  driver_cancelled: "general_notification",
  payment_success: "general_notification",
  payment_failed: "general_notification",
  fare_updated: "general_notification",
  traffic_delay: "general_notification",
  route_changed: "general_notification",
  safety_reminder: "general_notification",
  lost_item_followup: "general_notification",
  high_demand: "general_notification",
};

/** Exact iOS bundled WAV filename for aps.sound. */
export const CUSTOMER_IOS_SOUND_BY_EVENT: Record<string, string> = {
  driver_assigned: "driver_assigned.wav",
  trip_accepted: "driver_assigned.wav",
  new_driver_assigned: "driver_assigned.wav",
  stacked_driver_assigned: "driver_assigned.wav",
  driver_approaching: "driver_assigned.wav",
  driver_arrived: "driver_arrived.wav",
  waiting_started: "driver_arrived.wav",
  trip_started: "trip_started.wav",
  trip_completed: "trip_completed.wav",
  rating_request: "trip_completed.wav",
  trip_cancelled: "trip_cancelled.wav",
  no_show: "trip_cancelled.wav",
  customer_new_message: "message_received.wav",
  customer_new_fare_offer: "general_notification.wav",
  driver_accepted_counter: "general_notification.wav",
  finding_another_driver_updated_fare: "general_notification.wav",
  negotiation_offer_expired: "general_notification.wav",
  driver_cancelled: "general_notification.wav",
  payment_success: "general_notification.wav",
  payment_failed: "general_notification.wav",
  fare_updated: "general_notification.wav",
  traffic_delay: "general_notification.wav",
  route_changed: "general_notification.wav",
  safety_reminder: "general_notification.wav",
  lost_item_followup: "general_notification.wav",
  high_demand: "general_notification.wav",
};

/** iOS UNNotificationCategory identifiers (must match Customer registry). */
export const CUSTOMER_IOS_CATEGORY_BY_EVENT: Record<string, string> = {
  driver_assigned: "ONECAB_DRIVER_ASSIGNED",
  trip_accepted: "ONECAB_DRIVER_ASSIGNED",
  new_driver_assigned: "ONECAB_DRIVER_ASSIGNED",
  stacked_driver_assigned: "ONECAB_DRIVER_ASSIGNED",
  driver_approaching: "ONECAB_DRIVER_ASSIGNED",
  driver_arrived: "ONECAB_DRIVER_ARRIVED",
  waiting_started: "ONECAB_DRIVER_ARRIVED",
  trip_started: "ONECAB_TRIP_STARTED",
  trip_completed: "ONECAB_TRIP_COMPLETED",
  rating_request: "ONECAB_TRIP_COMPLETED",
  trip_cancelled: "ONECAB_TRIP_CANCELLED",
  no_show: "ONECAB_TRIP_CANCELLED",
  customer_new_message: "ONECAB_MESSAGE_RECEIVED",
};

const EVENT_ALIASES: Record<string, string> = {
  trip_accepted: "driver_assigned",
  new_driver_assigned: "driver_assigned",
  stacked_driver_assigned: "driver_assigned",
  no_show: "trip_cancelled",
};

export function canonicalizeCustomerTripNotificationEvent(event: string): string {
  const trimmed = event.trim();
  return EVENT_ALIASES[trimmed] ?? trimmed;
}

export function customerAndroidChannelIdForEvent(event: string): string {
  const canonical = canonicalizeCustomerTripNotificationEvent(event);
  return (
    CUSTOMER_ANDROID_CHANNEL_BY_EVENT[event] ??
    CUSTOMER_ANDROID_CHANNEL_BY_EVENT[canonical] ??
    "onecab_customer_updates_v1"
  );
}

export function customerAndroidSoundForEvent(event: string): string {
  const canonical = canonicalizeCustomerTripNotificationEvent(event);
  return (
    CUSTOMER_ANDROID_SOUND_BY_EVENT[event] ??
    CUSTOMER_ANDROID_SOUND_BY_EVENT[canonical] ??
    "general_notification"
  );
}

export function customerIosSoundFileForEvent(event: string): string {
  const canonical = canonicalizeCustomerTripNotificationEvent(event);
  return (
    CUSTOMER_IOS_SOUND_BY_EVENT[event] ??
    CUSTOMER_IOS_SOUND_BY_EVENT[canonical] ??
    "general_notification.wav"
  );
}

export function customerIosCategoryIdForEvent(event: string): string | null {
  const canonical = canonicalizeCustomerTripNotificationEvent(event);
  return (
    CUSTOMER_IOS_CATEGORY_BY_EVENT[event] ??
    CUSTOMER_IOS_CATEGORY_BY_EVENT[canonical] ??
    null
  );
}

type InvokeClient = {
  functions: {
    invoke: (
      name: string,
      opts: { body: Record<string, unknown> },
    ) => Promise<unknown>;
  };
};

type ExpireNotifyClient = InvokeClient & {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: string,
      ) => {
        maybeSingle: () => Promise<{
          data: { passenger_id?: string | null } | null;
        }>;
      };
    };
  };
};

/**
 * Fire-and-forget Customer lifecycle push after authoritative DB success.
 * Failures must not roll back the trip mutation.
 */
export async function notifyCustomerTripLifecycle(
  supabase: InvokeClient,
  input: {
    userId?: string | null;
    passengerId?: string | null;
    tripId: string;
    event: CustomerTripLifecycleEvent | string;
    title?: string;
    body?: string;
    fareDisplay?: string;
    driverName?: string;
    /** Override default `${canonicalEvent}-${tripId}` when a second alert for same trip is required. */
    notificationId?: string;
  },
): Promise<void> {
  const userId = (input.userId ?? input.passengerId ?? "").trim();
  const tripId = input.tripId.trim();
  if (!userId || !tripId) return;
  const event = canonicalizeCustomerTripNotificationEvent(input.event);
  try {
    await supabase.functions.invoke("send-trip-notification", {
      body: {
        userId,
        tripId,
        event,
        notificationId: (input.notificationId ?? `${event}-${tripId}`).trim(),
        ...(input.title ? { title: input.title } : {}),
        ...(input.body ? { body: input.body } : {}),
        ...(input.fareDisplay ? { fareDisplay: input.fareDisplay } : {}),
        ...(input.driverName ? { driverName: input.driverName } : {}),
      },
    });
  } catch (error) {
    console.warn("[notifyCustomerTripLifecycle] send-trip-notification failed", {
      event,
      trip_id: tripId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * SSOT search-exhaust expire + Customer trip_cancelled notify.
 * Use wherever expire_trip_when_search_exhausted runs so Edge RPC sites
 * cannot mute the Customer cancelled WAV.
 */
export async function expireTripWhenSearchExhaustedAndNotifyCustomer(
  supabase: ExpireNotifyClient,
  input: { tripId: string; passengerId?: string | null },
): Promise<{ expired: boolean; rpcError?: string }> {
  const tripId = input.tripId.trim();
  if (!tripId) return { expired: false, rpcError: "missing_trip_id" };

  const { data, error } = await supabase.rpc("expire_trip_when_search_exhausted", {
    p_trip_id: tripId,
  });
  if (error) {
    return { expired: false, rpcError: error.message ?? "expire_rpc_failed" };
  }
  if (data !== true) {
    return { expired: false };
  }

  let passengerId =
    typeof input.passengerId === "string" && input.passengerId.trim()
      ? input.passengerId.trim()
      : null;
  if (!passengerId) {
    try {
      const { data: trip } = await supabase
        .from("trips")
        .select("passenger_id")
        .eq("id", tripId)
        .maybeSingle();
      if (typeof trip?.passenger_id === "string" && trip.passenger_id.trim()) {
        passengerId = trip.passenger_id.trim();
      }
    } catch {
      // non-fatal — expire already succeeded
    }
  }

  if (passengerId) {
    await notifyCustomerTripLifecycle(supabase, {
      passengerId,
      tripId,
      event: "trip_cancelled",
      title: "ONECAB TRIP CANCELLED",
      body: "No drivers were available. Your trip has ended.",
    });
  }

  return { expired: true };
}
