/**
 * Customer trip-lifecycle push — single producer path via send-trip-notification.
 *
 * Canonical events: driver_assigned | driver_arrived | trip_started |
 * intermediate_stop_arrived | next_leg_started | trip_completed | trip_cancelled.
 *
 * Do not overload driver_arrived (pickup) or trip_started (initial start).
 * Do not send trip_cancelled for searching_new_driver rematch.
 * Do not fan out tokens here — send-trip-notification uses the authoritative
 * Customer device-token resolver.
 */

export const CUSTOMER_TRIP_LIFECYCLE_EVENTS = [
  "driver_assigned",
  "driver_arrived",
  "trip_started",
  "intermediate_stop_arrived",
  "next_leg_started",
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
  // Intermediate progression — reuse updates channel (no new native WAV required).
  intermediate_stop_arrived: "onecab_customer_updates_v1",
  next_leg_started: "onecab_customer_updates_v1",
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
  intermediate_stop_arrived: "general_notification",
  next_leg_started: "general_notification",
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
  intermediate_stop_arrived: "general_notification.wav",
  next_leg_started: "general_notification.wav",
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

/**
 * Match Customer alertEventRegistry iosInterruptionLevel.
 * Do NOT map every FCM "high" priority to time-sensitive — driver_assigned is
 * `active`. Sending time-sensitive without the iOS entitlement (or against
 * Focus policy for assigned) muted MK-260923-016 background alerts.
 */
export const CUSTOMER_IOS_INTERRUPTION_LEVEL_BY_EVENT: Record<
  string,
  "active" | "time-sensitive"
> = {
  driver_assigned: "active",
  trip_accepted: "active",
  new_driver_assigned: "active",
  stacked_driver_assigned: "active",
  driver_approaching: "active",
  driver_arrived: "time-sensitive",
  waiting_started: "time-sensitive",
  trip_started: "time-sensitive",
  intermediate_stop_arrived: "active",
  next_leg_started: "active",
  trip_completed: "active",
  rating_request: "active",
  trip_cancelled: "time-sensitive",
  no_show: "time-sensitive",
  customer_new_message: "active",
  payment_success: "time-sensitive",
  payment_failed: "time-sensitive",
  payment_action_required: "time-sensitive",
};

export function customerIosInterruptionLevelForEvent(
  event: string,
): "active" | "time-sensitive" {
  const canonical = canonicalizeCustomerTripNotificationEvent(event);
  return (
    CUSTOMER_IOS_INTERRUPTION_LEVEL_BY_EVENT[event] ??
    CUSTOMER_IOS_INTERRUPTION_LEVEL_BY_EVENT[canonical] ??
    "active"
  );
}

/**
 * Kept for call-site compatibility. Push delivery no longer uses
 * `supabase.functions.invoke` — that forwards the *incoming* Edge request
 * Authorization (Driver JWT on accept-offer), and send-trip-notification
 * requires the exact service-role Bearer (MK-260923-017 silent BG assign).
 */
// deno-lint-ignore ban-types
type InvokeClient = object;

type ExpireNotifyClient = {
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

function serviceRoleNotifyHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
  };
}

/**
 * Fire-and-forget Customer lifecycle push after authoritative DB success.
 * Failures must not roll back the trip mutation.
 *
 * Uses explicit service-role fetch (same convention as
 * invokeAutoDispatchWithServiceRole) — never `functions.invoke` from a
 * Driver/Customer-authenticated Edge request.
 */
export async function notifyCustomerTripLifecycle(
  _supabase: InvokeClient,
  input: {
    userId?: string | null;
    passengerId?: string | null;
    tripId: string;
    event: CustomerTripLifecycleEvent | string;
    title?: string;
    body?: string;
    fareDisplay?: string;
    driverName?: string;
    /** Intermediate progression identity (hint only — Customer hydrates from backend). */
    stopIndex?: number | null;
    /** Override default `${canonicalEvent}-${tripId}` when a second alert for same trip is required. */
    notificationId?: string;
    /** Override deep-link path (e.g. scheduled preconfirm → /account/rides). */
    path?: string | null;
  },
): Promise<void> {
  const userId = (input.userId ?? input.passengerId ?? "").trim();
  const tripId = input.tripId.trim();
  if (!userId || !tripId) return;
  const event = canonicalizeCustomerTripNotificationEvent(input.event);
  const stopIndex =
    typeof input.stopIndex === "number" && Number.isFinite(input.stopIndex)
      ? Math.trunc(input.stopIndex)
      : null;
  const pathOverride =
    typeof input.path === "string" && input.path.startsWith("/")
      ? input.path.trim()
      : null;

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    console.warn("[notifyCustomerTripLifecycle] send-trip-notification failed", {
      event,
      trip_id: tripId,
      stop_index: stopIndex,
      message: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing",
    });
    return;
  }

  const body: Record<string, unknown> = {
    userId,
    tripId,
    event,
    notificationId: (input.notificationId ?? `${event}-${tripId}`).trim(),
    ...(input.title ? { title: input.title } : {}),
    ...(input.body ? { body: input.body } : {}),
    ...(input.fareDisplay ? { fareDisplay: input.fareDisplay } : {}),
    ...(input.driverName ? { driverName: input.driverName } : {}),
    ...(stopIndex != null ? { stopIndex, stop_index: stopIndex } : {}),
    ...(pathOverride ? { path: pathOverride, screen: pathOverride } : {}),
  };

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/send-trip-notification`,
      {
        method: "POST",
        headers: serviceRoleNotifyHeaders(serviceRoleKey),
        body: JSON.stringify(body),
      },
    );
    const rawText = await response.text();
    let parsed: Record<string, unknown> | null = null;
    if (rawText) {
      try {
        const json = JSON.parse(rawText);
        parsed = json && typeof json === "object" && !Array.isArray(json)
          ? json as Record<string, unknown>
          : null;
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      console.warn("[notifyCustomerTripLifecycle] send-trip-notification failed", {
        event,
        trip_id: tripId,
        stop_index: stopIndex,
        http_status: response.status,
        message: typeof parsed?.error === "string"
          ? parsed.error
          : rawText.slice(0, 200) || `HTTP ${response.status}`,
      });
      return;
    }

    const sent = typeof parsed?.sent === "number" ? parsed.sent : null;
    console.log("[customer_trip_lifecycle_emitted]", {
      event,
      trip_id: tripId,
      stop_index: stopIndex,
      http_status: response.status,
      sent,
      reason: typeof parsed?.reason === "string" ? parsed.reason : null,
    });
  } catch (error) {
    console.warn("[notifyCustomerTripLifecycle] send-trip-notification failed", {
      event,
      trip_id: tripId,
      stop_index: stopIndex,
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
