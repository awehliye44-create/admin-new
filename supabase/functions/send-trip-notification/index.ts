/**
 * send-trip-notification — Edge Function
 *
 * Sends FCM/APNs push notifications to a customer for trip lifecycle events.
 * Called by other backend edge functions (e.g., update-trip-status, finalize-trip)
 * using the service role key.
 *
 * Payload structure follows TripPushPayload from tripNotificationTypes.ts.
 *
 * Supports:
 * - FCM HTTP v1 API for Android
 * - FCM HTTP v1 API for iOS (APNs via FCM)
 * - Android notification channels
 * - iOS critical alerts / categories
 * - Android notification tag + APNs collapse-id use notificationId (presentation only).
 * - Durable send-once for scheduled traffic_delay is owned by
 *   customer_trip_notification_deliveries (#79A) — not this tag alone.
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  resolveAlertSound,
  TRIP_EVENT_SOUND_MAP,
} from "./lib/alertSoundResolver.ts";
import {
  canonicalizeCustomerTripNotificationEvent,
  customerAndroidChannelIdForEvent,
  customerAndroidSoundForEvent,
  customerIosCategoryIdForEvent,
  customerIosInterruptionLevelForEvent,
  customerIosSoundFileForEvent,
} from "../_shared/customerTripLifecycleNotify.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import {
  fcmProjectIdFromServiceAccount,
  getFcmHttpV1AccessToken,
  readFcmServiceAccountJson,
} from "../_shared/fcmHttpV1.ts";
import { TRAFFIC_DELAY_DEDUPE_PREFIX } from "../scheduled-dispatch/lib/scheduledPostActivationLatenessSSOT.ts";
import { isSn1LifecycleNotificationId } from "../_shared/customerLifecycleNotifyDurableSSOT.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ============================================================================
// TYPES
// ============================================================================

interface SendTripNotificationRequest {
  /** User ID (auth.users.id) of the customer */
  userId: string;
  /** Trip ID for deep linking */
  tripId: string;
  /** Notification event type */
  event: string;
  /** Optional overrides */
  title?: string;
  body?: string;
  /** Absolute negotiation deadline (ISO). Clients tick remaining time from this. */
  expiresAt?: string;
  negotiationExpiresAt?: string;
  /** Driver name for personalization */
  driverName?: string;
  /** Fare in display format */
  fareDisplay?: string;
  /** Intermediate stop index (hint only). */
  stopIndex?: number;
  stop_index?: number;
  /**
   * Stable event id — used as Android tag + APNs collapse-id.
   * Scheduled traffic_delay also requires a durable ledger claim (#79A).
   */
  notificationId?: string;
}

// ── Notification copy (mirrors frontend tripNotificationTypes.ts) ──────────

const NOTIFICATION_COPY: Record<string, { title: string; body: string }> = {
  driver_assigned:    { title: 'ONECAB DRIVER ASSIGNED',    body: 'Your driver is on the way.' },
  trip_accepted:      { title: 'ONECAB DRIVER ASSIGNED',    body: 'Your driver is on the way.' },
  driver_approaching: { title: 'ONECAB DRIVER ARRIVING',      body: 'Your driver is arriving soon.' },
  driver_arrived:     { title: 'ONECAB DRIVER ARRIVED',     body: 'Your driver has arrived.' },
  waiting_started:    { title: 'Waiting Time',       body: 'Waiting time charges may apply soon.' },
  trip_started:       { title: 'ONECAB TRIP STARTED',       body: 'Your trip has started.' },
  intermediate_stop_arrived: {
    title: 'ONECAB ARRIVED AT STOP',
    body: 'Your driver has arrived at a stop.',
  },
  next_leg_started: {
    title: 'ONECAB CONTINUING TRIP',
    body: 'Your driver is continuing to the next destination.',
  },
  traffic_delay:      { title: 'Traffic Update',     body: 'Traffic detected — arrival may be slightly delayed.' },
  route_changed:      { title: 'Route Changed',      body: 'Your route has changed. Tap to review.' },
  safety_reminder:    { title: 'Safety Reminder',    body: 'Share your live trip for extra safety.' },
  fare_updated:       { title: 'Fare Updated',       body: 'Your fare was updated due to trip changes.' },
  trip_completed:     { title: 'ONECAB TRIP COMPLETED',       body: "You've arrived. Thanks for riding with ONECAB." },
  trip_cancelled:     { title: 'ONECAB TRIP CANCELLED',      body: 'Your trip has been cancelled.' },
  rating_request:     { title: 'Rate Your Trip',     body: 'How was your trip? Rate your ride.' },
  payment_success:    { title: 'Payment Successful', body: 'Payment successful.' },
  payment_failed:     { title: 'Payment Failed',     body: 'Payment failed. Please update your payment method.' },
  lost_item_followup: { title: 'Left Something?',    body: 'Left something behind? Contact your driver.' },
  customer_new_fare_offer: {
    title: 'New fare offer',
    body: 'Driver offered a new fare — respond before it expires.',
  },
  driver_accepted_counter: {
    title: 'Counter accepted',
    body: 'Driver accepted your counter offer.',
  },
  finding_another_driver_updated_fare: {
    title: 'Finding another driver',
    body: "We're finding another driver at your updated fare.",
  },
  negotiation_offer_expired: {
    title: 'ONECAB FARE OFFER EXPIRED',
    body: 'The fare offer timed out. Waiting for the next update.',
  },
  new_driver_assigned: {
    title: 'ONECAB NEW DRIVER ASSIGNED',
    body: 'A new driver has been assigned to your trip.',
  },
  driver_cancelled: {
    title: 'ONECAB DRIVER CANCELLED',
    body: "We're finding another driver for you.",
  },
  customer_new_message: {
    title: 'ONECAB NEW MESSAGE',
    body: 'You have a new message from your driver.',
  },
  high_demand: {
    title: 'ONECAB HIGH DEMAND',
    body: 'High demand in your area — fares may be higher than usual.',
  },
  scheduled_booking_confirmed: {
    title: 'Scheduled ride booked',
    body: "Your ride is booked. We'll notify you when a driver confirms.",
  },
};

// ── Event → Android channel mapping (native per-event versioned IDs) ──────
// SSOT: customerTripLifecycleNotify.ts — never trip_updates / critical_alerts / post_trip.

// ── Event → priority ───────────────────────────────────────────────────────

const EVENT_PRIORITY: Record<string, 'high' | 'normal'> = {
  driver_assigned: 'high',
  trip_accepted: 'high',
  trip_cancelled: 'high',
  driver_approaching: 'normal',
  driver_arrived: 'high',
  waiting_started: 'high',
  trip_started: 'high',
  intermediate_stop_arrived: 'high',
  next_leg_started: 'high',
  traffic_delay: 'normal',
  route_changed: 'high',
  safety_reminder: 'normal',
  fare_updated: 'normal',
  trip_completed: 'high',
  rating_request: 'normal',
  payment_success: 'normal',
  payment_failed: 'high',
  lost_item_followup: 'normal',
  customer_new_fare_offer: 'high',
  driver_accepted_counter: 'high',
  finding_another_driver_updated_fare: 'high',
  negotiation_offer_expired: 'normal',
  new_driver_assigned: 'high',
  driver_cancelled: 'high',
  customer_new_message: 'high',
  scheduled_booking_confirmed: 'high',
  high_demand: 'high',
};

// ── Event → deep link screen ───────────────────────────────────────────────

const EVENT_SCREEN: Record<string, string> = {
  driver_assigned: '/booking/driver-accepted',
  trip_accepted: '/booking/driver-accepted',
  driver_approaching: '/booking/driver-accepted',
  driver_arrived: '/booking/driver-accepted',
  waiting_started: '/booking/driver-accepted',
  trip_started: '/booking/driver-accepted',
  intermediate_stop_arrived: '/booking/driver-accepted',
  next_leg_started: '/booking/driver-accepted',
  traffic_delay: '/booking/driver-accepted',
  route_changed: '/booking/driver-accepted',
  safety_reminder: '/booking/driver-accepted',
  fare_updated: '/booking/driver-accepted',
  trip_completed: '/booking/rate-trip',
  trip_cancelled: '/',
  rating_request: '/booking/rate-trip',
  payment_success: '/wallet',
  payment_failed: '/wallet',
  lost_item_followup: '/lost-property',
  customer_new_fare_offer: '/booking/finding-drivers',
  driver_accepted_counter: '/booking/driver-accepted',
  finding_another_driver_updated_fare: '/booking/finding-drivers',
  negotiation_offer_expired: '/booking/finding-drivers',
  new_driver_assigned: '/booking/driver-accepted',
  driver_cancelled: '/booking/finding-drivers',
  customer_new_message: '/booking/trip-chat',
  high_demand: '/',
  scheduled_booking_confirmed: '/account/rides',
};

// ============================================================================
// FCM HTTP v1 SENDER
// ============================================================================

/**
 * Send FCM v1 message to a device token.
 */
async function sendFCMv1(
  projectId: string,
  accessToken: string,
  token: string,
  platform: string,
  title: string,
  body: string,
  data: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const channelId = data.channelId || customerAndroidChannelIdForEvent(data.type || '');
  const priority = data.priority || 'normal';
  const androidSound = data.androidSound || customerAndroidSoundForEvent(data.type || '');
  const iosSound = data.iosSound || customerIosSoundFileForEvent(data.type || '');
  const iosCategory =
    data.iosCategory || customerIosCategoryIdForEvent(data.type || '') || data.type;

  const message: Record<string, unknown> = {
    token,
    data, // Always send data payload for foreground handling
    notification: {
      title,
      body,
    },
  };

  // Platform-specific config — bundled WAV / per-event channel, never OS "default".
  if (platform === 'android') {
    (message as any).android = {
      priority: priority === 'high' ? 'HIGH' : 'NORMAL',
      notification: {
        channel_id: channelId,
        sound: androidSound,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        tag: data.notificationId,
      },
    };
  } else if (platform === 'ios') {
    const interruptionLevel =
      data.iosInterruptionLevel ||
      customerIosInterruptionLevelForEvent(data.type || '');
    const apsPayload: Record<string, unknown> = {
      alert: { title, body },
      sound: iosSound,
      'thread-id': data.tripId, // Groups notifications by trip
      'mutable-content': 1, // Allows notification service extension
      category: iosCategory,
      // Per-event level (Customer registry). Never blanket high→time-sensitive.
      'interruption-level': interruptionLevel,
    };
    if (priority === 'high') {
      // Wake JS for hydrate when OS allows (background task / content-available).
      apsPayload['content-available'] = 1;
    }
    const apnsHeaders: Record<string, string> = {
      'apns-priority': priority === 'high' ? '10' : '5',
      'apns-push-type': 'alert',
    };
    // Event-scoped collapse (secondary to durable backend idempotency).
    const collapseId = String(data.notificationId || '').trim();
    if (collapseId) {
      apnsHeaders['apns-collapse-id'] = collapseId.slice(0, 64);
    }
    (message as any).apns = {
      headers: apnsHeaders,
      payload: {
        aps: apsPayload,
      },
    };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`FCM send failed (${response.status}):`, errorBody);

      // Token expired/invalid — should be cleaned up
      if (response.status === 404 || response.status === 410 ||
          errorBody.includes('UNREGISTERED') || errorBody.includes('NOT_FOUND')) {
        return { success: false, error: 'TOKEN_INVALID' };
      }

      return { success: false, error: `FCM ${response.status}: ${errorBody.substring(0, 200)}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// HANDLER
// ============================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Service-role only (exact env key or verified service_role JWT).
    const auth = await assertCronOrServiceRoleAuth(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: "Forbidden — service role required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: SendTripNotificationRequest = await req.json();
    const { tripId, driverName, fareDisplay } = body;
    const event = canonicalizeCustomerTripNotificationEvent(body.event ?? "");
    const userId = body.userId;

    if (!userId || !tripId || !event) {
      return new Response(JSON.stringify({ error: "Missing userId, tripId, or event" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve notification content (canonical first, then original alias)
    const copy = NOTIFICATION_COPY[event] ?? NOTIFICATION_COPY[body.event];
    if (!copy) {
      return new Response(JSON.stringify({ error: `Unknown event type: ${event}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const title = body.title || copy.title;
    let notifBody = body.body || copy.body;
    if (driverName) notifBody = notifBody.replace('{driverName}', driverName);
    if (fareDisplay) notifBody = notifBody.replace('{fare}', fareDisplay);

    const notificationId = body.notificationId || `${event}-${tripId}`;

    // #79A defense: scheduled traffic_delay must have a durable claim in
    // customer_trip_notification_deliveries. Terminal rows never re-send.
    const isScheduledTrafficDelay =
      event === "traffic_delay" &&
      notificationId.startsWith(TRAFFIC_DELAY_DEDUPE_PREFIX);
    if (isScheduledTrafficDelay) {
      const supabaseGuard = createClient(supabaseUrl, supabaseServiceKey);
      const { data: delivery } = await supabaseGuard
        .from("customer_trip_notification_deliveries")
        .select("id, status")
        .eq("notification_id", notificationId)
        .maybeSingle();
      const deliveryStatus = String(delivery?.status ?? "").toLowerCase();
      if (!delivery?.id) {
        console.warn(
          `[TripNotif] Refusing scheduled traffic_delay without ledger claim: ${notificationId}`,
        );
        return new Response(
          JSON.stringify({
            success: true,
            sent: 0,
            failed: 0,
            event,
            tripId,
            reason: "missing_delivery_claim",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      if (
        deliveryStatus === "sent" ||
        deliveryStatus === "skipped" ||
        deliveryStatus === "ambiguous"
      ) {
        console.log(
          `[TripNotif] Skip scheduled traffic_delay — ledger ${deliveryStatus}: ${notificationId}`,
        );
        return new Response(
          JSON.stringify({
            success: true,
            sent: 0,
            failed: 0,
            event,
            tripId,
            reason: `already_${deliveryStatus}`,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      // status sending | failed — allow (caller owns reclaim → sending).
    }

    // SN1 defense: scheduled lifecycle ids require a durable claim (pending|sending|failed).
    if (isSn1LifecycleNotificationId(notificationId)) {
      const supabaseGuard = createClient(supabaseUrl, supabaseServiceKey);
      const { data: delivery } = await supabaseGuard
        .from("customer_trip_notification_deliveries")
        .select("id, status")
        .eq("notification_id", notificationId)
        .maybeSingle();
      const deliveryStatus = String(delivery?.status ?? "").toLowerCase();
      if (!delivery?.id) {
        console.warn(
          `[TripNotif] Refusing SN1 lifecycle notify without ledger claim: ${notificationId}`,
        );
        return new Response(
          JSON.stringify({
            success: true,
            sent: 0,
            failed: 0,
            event,
            tripId,
            reason: "missing_delivery_claim",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      if (
        deliveryStatus === "sent" ||
        deliveryStatus === "skipped" ||
        deliveryStatus === "ambiguous"
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            sent: 0,
            failed: 0,
            event,
            tripId,
            reason: `already_${deliveryStatus}`,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      // pending | sending | failed — allow (deliver path owns lease).
    }

    const channelId = customerAndroidChannelIdForEvent(event);
    const androidSound = customerAndroidSoundForEvent(event);
    const iosSound = customerIosSoundFileForEvent(event);
    const iosCategory = customerIosCategoryIdForEvent(event);
    const iosInterruptionLevel = customerIosInterruptionLevelForEvent(event);
    const priority = EVENT_PRIORITY[event] || EVENT_PRIORITY[body.event] || 'high';
    const screen =
      (typeof body.path === "string" && body.path.startsWith("/")
        ? body.path.trim()
        : null) ||
      (typeof body.screen === "string" && body.screen.startsWith("/")
        ? body.screen.trim()
        : null) ||
      EVENT_SCREEN[event] ||
      EVENT_SCREEN[body.event] ||
      '/booking/driver-accepted';

    // Data payload for the app
    const enqueuedAt = new Date().toISOString();
    const dataPayload: Record<string, string> = {
      type: event,
      event,
      event_type: event,
      tripId,
      trip_id: tripId,
      screen,
      path: screen,
      channelId,
      channel_id: channelId,
      androidSound,
      iosSound,
      iosInterruptionLevel,
      notificationId,
      priority,
      timestamp: enqueuedAt,
      enqueued_at: enqueuedAt,
      enqueuedAt,
    };
    if (iosCategory) dataPayload.iosCategory = iosCategory;
    if (driverName) dataPayload.driverName = driverName;
    if (fareDisplay) dataPayload.fareDisplay = fareDisplay;
    const stopIndexRaw = body.stopIndex ?? body.stop_index;
    if (typeof stopIndexRaw === "number" && Number.isFinite(stopIndexRaw)) {
      const stopIndex = String(Math.trunc(stopIndexRaw));
      dataPayload.stop_index = stopIndex;
      dataPayload.stopIndex = stopIndex;
    }
    const negotiationDeadline = body.negotiationExpiresAt || body.expiresAt;
    if (negotiationDeadline) {
      dataPayload.negotiation_expires_at = negotiationDeadline;
      dataPayload.negotiationExpiresAt = negotiationDeadline;
      dataPayload.expires_at = negotiationDeadline;
      dataPayload.expiresAt = negotiationDeadline;
    }

    const alertSoundEvent = TRIP_EVENT_SOUND_MAP[event] ?? TRIP_EVENT_SOUND_MAP[body.event] ?? event;
    if (alertSoundEvent) {
      const resolved = await resolveAlertSound(
        createClient(supabaseUrl, supabaseServiceKey),
        "customer",
        alertSoundEvent,
        supabaseUrl,
      );
      if (resolved?.publicUrl) {
        dataPayload.alert_sound_url = resolved.publicUrl;
        dataPayload.alert_sound_event = alertSoundEvent;
        console.log(`[TripNotif] Resolved admin sound for ${event} → ${alertSoundEvent}`);
      }
    }

    // Get customer's push tokens (passenger_id or auth user id)
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { resolveCustomerAuthoritativeToken } = await import("../_shared/authoritativeDevicePush.ts");
    const authoritative = await resolveCustomerAuthoritativeToken(supabase, userId);
    const tokens = authoritative
      ? [{ token: authoritative.token, platform: authoritative.platform }]
      : [];

    if (tokens.length === 0) {
      console.log(`No authoritative Customer push token for user ${userId} — notification skipped`);
      return new Response(JSON.stringify({ success: true, sent: 0, reason: "no_tokens" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // FCM v1 — same secret chain as Driver / VoIP (incomingCallPush):
    // GOOGLE_SERVICE_ACCOUNT_JSON is the live SA; FCM_SERVICE_ACCOUNT_JSON alone is unset.
    // There is no legacy server-key fallback — Google retired that API.
    const serviceAccountJson = readFcmServiceAccountJson();

    let sent = 0;
    let failed = 0;
    const invalidTokens: string[] = [];

    if (!serviceAccountJson) {
      console.error("[TripNotif] GOOGLE_SERVICE_ACCOUNT_JSON not configured — notification not sent");
    } else {
      try {
        const projectId = fcmProjectIdFromServiceAccount(serviceAccountJson);
        const accessToken = await getFcmHttpV1AccessToken(serviceAccountJson);

        for (const { token: deviceToken, platform } of tokens) {
          const result = await sendFCMv1(
            projectId, accessToken, deviceToken, platform,
            title, notifBody, dataPayload
          );

          if (result.success) {
            sent++;
            console.log(`[TripNotif] Sent ${event} to ${platform} device`);
          } else {
            failed++;
            if (result.error === 'TOKEN_INVALID') {
              invalidTokens.push(deviceToken);
            }
            console.error(`[TripNotif] Failed ${event} to ${platform}:`, result.error);
          }
        }
      } catch (err) {
        console.error("[TripNotif] FCM v1 auth error:", err);
      }
    }

    // Clean up invalid tokens
    if (invalidTokens.length > 0) {
      const { error: deleteError } = await supabase
        .from("customer_push_tokens")
        .delete()
        .in("token", invalidTokens);

      if (deleteError) {
        console.error("[TripNotif] Error cleaning invalid tokens:", deleteError);
      } else {
        console.log(`[TripNotif] Cleaned ${invalidTokens.length} invalid tokens`);
      }
    }

    console.log(`[TripNotif] ${event} for trip ${tripId}: ${sent} sent, ${failed} failed`);

    return new Response(JSON.stringify({
      success: true,
      sent,
      failed,
      event,
      tripId,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[TripNotif] Error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
