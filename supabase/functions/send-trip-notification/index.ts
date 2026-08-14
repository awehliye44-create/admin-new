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
 * - Deduplication via notificationId
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import {
  resolveAlertSound,
  TRIP_EVENT_SOUND_MAP,
} from "../_shared/alertSoundResolver.ts";

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
  /** Stable dedupe id (trip + event + version) */
  notificationId?: string;
}

// ── Notification copy (mirrors frontend tripNotificationTypes.ts) ──────────

const NOTIFICATION_COPY: Record<string, { title: string; body: string }> = {
  trip_accepted:      { title: 'ONECAB DRIVER ASSIGNED',    body: 'Your driver is on the way.' },
  driver_approaching: { title: 'ONECAB DRIVER ARRIVING',      body: 'Your driver is arriving soon.' },
  driver_arrived:     { title: 'ONECAB DRIVER ARRIVED',     body: 'Your driver has arrived.' },
  waiting_started:    { title: 'Waiting Time',       body: 'Waiting time charges may apply soon.' },
  trip_started:       { title: 'ONECAB TRIP STARTED',       body: 'Your trip has started.' },
  traffic_delay:      { title: 'Traffic Update',     body: 'Traffic detected — arrival may be slightly delayed.' },
  route_changed:      { title: 'Route Changed',      body: 'Your route has changed. Tap to review.' },
  safety_reminder:    { title: 'Safety Reminder',    body: 'Share your live trip for extra safety.' },
  fare_updated:       { title: 'Fare Updated',       body: 'Your fare was updated due to trip changes.' },
  trip_completed:     { title: 'ONECAB TRIP COMPLETED',       body: "You've arrived. Thanks for riding with ONECAB." },
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
};

// ── Event → Android channel mapping ────────────────────────────────────────

const EVENT_CHANNEL: Record<string, string> = {
  trip_accepted: 'trip_updates',
  driver_approaching: 'trip_updates',
  driver_arrived: 'critical_alerts',
  waiting_started: 'critical_alerts',
  trip_started: 'critical_alerts',
  traffic_delay: 'trip_updates',
  route_changed: 'trip_updates',
  safety_reminder: 'critical_alerts',
  fare_updated: 'payment_alerts',
  trip_completed: 'trip_updates',
  rating_request: 'post_trip',
  payment_success: 'payment_alerts',
  payment_failed: 'critical_alerts',
  lost_item_followup: 'post_trip',
  customer_new_fare_offer: 'critical_alerts',
  driver_accepted_counter: 'critical_alerts',
  finding_another_driver_updated_fare: 'trip_updates',
  negotiation_offer_expired: 'trip_updates',
  new_driver_assigned: 'trip_updates',
  driver_cancelled: 'critical_alerts',
  customer_new_message: 'trip_updates',
  high_demand: 'trip_updates',
};

// ── Event → priority ───────────────────────────────────────────────────────

const EVENT_PRIORITY: Record<string, 'high' | 'normal'> = {
  trip_accepted: 'high',
  driver_approaching: 'normal',
  driver_arrived: 'high',
  waiting_started: 'high',
  trip_started: 'high',
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
  high_demand: 'high',
};

// ── Event → deep link screen ───────────────────────────────────────────────

const EVENT_SCREEN: Record<string, string> = {
  trip_accepted: '/ride-tracking',
  driver_approaching: '/ride-tracking',
  driver_arrived: '/ride-tracking',
  waiting_started: '/ride-tracking',
  trip_started: '/ride-tracking',
  traffic_delay: '/ride-tracking',
  route_changed: '/ride-tracking',
  safety_reminder: '/ride-tracking',
  fare_updated: '/ride-tracking',
  trip_completed: '/rate-driver',
  rating_request: '/rate-driver',
  payment_success: '/wallet',
  payment_failed: '/wallet',
  lost_item_followup: '/lost-property',
  customer_new_fare_offer: '/booking/finding-drivers',
  driver_accepted_counter: '/booking/driver-accepted',
  finding_another_driver_updated_fare: '/booking/finding-drivers',
  negotiation_offer_expired: '/booking/finding-drivers',
  new_driver_assigned: '/ride-tracking',
  driver_cancelled: '/ride-tracking',
  customer_new_message: '/ride-tracking',
  high_demand: '/book-ride',
};

// ============================================================================
// FCM HTTP v1 SENDER
// ============================================================================

/**
 * Get OAuth2 access token from service account JSON for FCM v1 API.
 * Falls back to legacy API if service account not available.
 */
async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  // Build JWT
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const enc = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const headerB64 = enc(JSON.stringify(header));
  const payloadB64 = enc(JSON.stringify(payload));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  // Import RSA private key
  const pemContents = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');
  const keyBuffer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const signatureB64 = enc(String.fromCharCode(...new Uint8Array(signature)));
  const jwt = `${unsignedToken}.${signatureB64}`;

  // Exchange JWT for access token
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    throw new Error(`Failed to get FCM access token: ${err}`);
  }

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

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
  const channelId = data.channelId || 'trip_updates';
  const priority = data.priority || 'normal';

  const message: Record<string, unknown> = {
    token,
    data, // Always send data payload for foreground handling
    notification: {
      title,
      body,
    },
  };

  // Platform-specific config
  if (platform === 'android') {
    (message as any).android = {
      priority: priority === 'high' ? 'HIGH' : 'NORMAL',
      notification: {
        channel_id: channelId,
        sound: priority === 'high' ? 'default' : undefined,
        click_action: 'FLUTTER_NOTIFICATION_CLICK', // For deep linking
        tag: data.notificationId, // Replaces previous notification with same tag
      },
    };
  } else if (platform === 'ios') {
    const apsPayload: Record<string, unknown> = {
      alert: { title, body },
      sound: priority === 'high' ? 'default' : undefined,
      'thread-id': data.tripId, // Groups notifications by trip
      'mutable-content': 1, // Allows notification service extension
      category: data.type, // Maps to UNNotificationCategory
    };
    if (priority === 'high') {
      // iOS 15+ Focus: pairs with com.apple.developer.usernotifications.time-sensitive entitlement.
      apsPayload['interruption-level'] = 'time-sensitive';
    }
    (message as any).apns = {
      headers: {
        'apns-priority': priority === 'high' ? '10' : '5',
        'apns-push-type': 'alert',
      },
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

    // Only allow service-role calls (backend → backend)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    if (token !== supabaseServiceKey) {
      return new Response(JSON.stringify({ error: "Forbidden — service role required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: SendTripNotificationRequest = await req.json();
    const { userId, tripId, event, driverName, fareDisplay } = body;

    if (!userId || !tripId || !event) {
      return new Response(JSON.stringify({ error: "Missing userId, tripId, or event" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve notification content
    const copy = NOTIFICATION_COPY[event];
    if (!copy) {
      return new Response(JSON.stringify({ error: `Unknown event type: ${event}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const title = body.title || copy.title;
    let notifBody = body.body || copy.body;
    if (driverName) notifBody = notifBody.replace('{driverName}', driverName);
    if (fareDisplay) notifBody = notifBody.replace('{fare}', fareDisplay);

    const notificationId = body.notificationId || `${event}-${tripId}-${Date.now()}`;
    const channelId = EVENT_CHANNEL[event] || 'trip_updates';
    const priority = EVENT_PRIORITY[event] || 'normal';
    const screen = EVENT_SCREEN[event] || '/ride-tracking';

    // Data payload for the app
    const dataPayload: Record<string, string> = {
      type: event,
      tripId,
      trip_id: tripId,
      screen,
      path: screen,
      channelId,
      notificationId,
      priority,
      timestamp: new Date().toISOString(),
    };
    if (driverName) dataPayload.driverName = driverName;
    if (fareDisplay) dataPayload.fareDisplay = fareDisplay;
    const negotiationDeadline = body.negotiationExpiresAt || body.expiresAt;
    if (negotiationDeadline) {
      dataPayload.negotiation_expires_at = negotiationDeadline;
      dataPayload.negotiationExpiresAt = negotiationDeadline;
      dataPayload.expires_at = negotiationDeadline;
      dataPayload.expiresAt = negotiationDeadline;
    }

    const alertSoundEvent = TRIP_EVENT_SOUND_MAP[event] ?? null;
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

    // Get customer's push tokens
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data: tokens, error: tokenError } = await supabase
      .from("customer_push_tokens")
      .select("token, platform")
      .eq("user_id", userId)
      .eq("app_type", "customer");

    if (tokenError) {
      console.error("Error fetching push tokens:", tokenError);
      return new Response(JSON.stringify({ error: "Failed to fetch tokens" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!tokens || tokens.length === 0) {
      console.log(`No push tokens for user ${userId} — notification skipped`);
      return new Response(JSON.stringify({ success: true, sent: 0, reason: "no_tokens" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get FCM service account for v1 API
    const serviceAccountJson = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
    const fcmServerKey = Deno.env.get("FCM_SERVER_KEY"); // Legacy fallback

    let sent = 0;
    let failed = 0;
    const invalidTokens: string[] = [];

    if (serviceAccountJson) {
      // FCM v1 API (preferred)
      try {
        const sa = JSON.parse(serviceAccountJson);
        const projectId = sa.project_id;
        const accessToken = await getAccessToken(serviceAccountJson);

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
        // Fall through to legacy if available
      }
    }

    if (sent === 0 && fcmServerKey) {
      // Legacy FCM API fallback
      for (const { token: deviceToken, platform } of tokens) {
        try {
          const response = await fetch("https://fcm.googleapis.com/fcm/send", {
            method: "POST",
            headers: {
              "Authorization": `key=${fcmServerKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              to: deviceToken,
              notification: { title, body: notifBody, sound: "default" },
              data: dataPayload,
              priority: priority === 'high' ? 'high' : 'normal',
              ...(platform === 'android' ? { android: { notification: { channel_id: channelId } } } : {}),
            }),
          });

          if (response.ok) {
            const result = await response.json();
            if (result.success === 1) {
              sent++;
            } else {
              failed++;
              // Check for invalid token
              if (result.results?.[0]?.error === 'NotRegistered' ||
                  result.results?.[0]?.error === 'InvalidRegistration') {
                invalidTokens.push(deviceToken);
              }
            }
          } else {
            failed++;
          }
        } catch (err) {
          failed++;
          console.error("[TripNotif] Legacy FCM error:", err);
        }
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
