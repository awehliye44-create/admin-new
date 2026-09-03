import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  isValidAction,
  sanitizeString,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { buildRideOfferClientPushData } from "../_shared/rideOfferClientPushData.ts";
import { RIDE_OFFER_IOS_ALERT_SOUND } from "../_shared/rideOfferPushCopy.ts";
import {
  evaluateRideOfferPushGate,
  revokeRideOfferNonDriverFault,
} from "../_shared/rideOfferDriverEligibility.ts";
import { buildTokenDeactivatePatch } from "../_shared/driverPushToken.ts";
import { resolveDriverAuthoritativeToken } from "../_shared/authoritativeDevicePush.ts";
import {
  notificationChannelForPlatform,
  recordBookingDeliveryPhaseBestEffort,
  recordFcmPushOutcomeBestEffort,
  resolveBookingIdFromPushData,
  resolveOfferIdFromPushData,
  type FcmAttemptResult,
} from "../_shared/fcmPushDeliveryInstrumentation.ts";

interface NotificationPayload {
  driverId: string;
  type: 'RIDE_OFFER' | 'RIDE_STOP' | 'TRIP_UPDATE' | 'SYSTEM_ALERT';
  title: string;
  body: string;
  data?: Record<string, string>;
}

const VALID_NOTIFICATION_TYPES = [
  'RIDE_OFFER',
  'RIDE_STOP',
  'TRIP_UPDATE',
  'SYSTEM_ALERT',
  'NEGOTIATION_UPDATE',
];
const RATE_LIMIT_CONFIG = { limit: 200, windowMs: 60000, keyPrefix: 'send-notification' };

// ─── FCM v1 OAuth2 helpers ───

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlStr(str: string): string {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function createSignedJwt(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  };

  const headerB64 = base64urlStr(JSON.stringify(header));
  const payloadB64 = base64urlStr(JSON.stringify(payload));
  const unsigned = `${headerB64}.${payloadB64}`;

  const keyData = pemToArrayBuffer(sa.private_key);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );

  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const jwt = await createSignedJwt(sa);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth2 token exchange failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

function tryParseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    if (typeof parsed === 'string') {
      const nested = JSON.parse(parsed);
      if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
    }
  } catch {
    // continue
  }
  return null;
}

function isServiceAccount(value: Record<string, unknown>): value is Record<string, unknown> & ServiceAccount {
  return (
    typeof value.project_id === 'string' &&
    typeof value.client_email === 'string' &&
    typeof value.private_key === 'string'
  );
}

function parseServiceAccount(raw: string): ServiceAccount | null {
  const trimmed = raw.trim();
  const unwrapped = trimmed.replace(/^['"]|['"]$/g, '');
  const candidates = [raw, trimmed, unwrapped];

  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed && isServiceAccount(parsed)) {
      return {
        ...parsed,
        private_key: parsed.private_key.replace(/\\n/g, '\n'),
      };
    }

    try {
      const decoded = atob(candidate);
      const parsedDecoded = tryParseJsonObject(decoded);
      if (parsedDecoded && isServiceAccount(parsedDecoded)) {
        return {
          ...parsedDecoded,
          private_key: parsedDecoded.private_key.replace(/\\n/g, '\n'),
        };
      }
    } catch {
      // not base64, continue
    }
  }

  return null;
}

// ─── Main handler ───

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handleCORSPreflight();
  }

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SA_JSON_RAW = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");

    if (!SA_JSON_RAW) {
      console.error("[send-driver-notification] GOOGLE_SERVICE_ACCOUNT_JSON not configured");
      return errorResponse("FCM_NOT_CONFIGURED", "FCM service account not configured", 500);
    }

    const serviceAccount = parseServiceAccount(SA_JSON_RAW);
    if (!serviceAccount) {
      console.error("[send-driver-notification] Invalid GOOGLE_SERVICE_ACCOUNT_JSON format");
      return errorResponse("FCM_CONFIG_INVALID", "Invalid service account JSON format", 500);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const payload: NotificationPayload = await req.json();

    console.log("[send-driver-notification] Request:", {
      driverId: payload.driverId,
      type: payload.type,
      title: payload.title,
    });

    // Input validation
    const validationErrors: Record<string, string> = {};
    if (!payload.driverId) {
      validationErrors.driverId = "driverId is required";
    } else if (!isValidUUID(payload.driverId)) {
      validationErrors.driverId = "driverId must be a valid UUID";
    }
    if (!payload.type) {
      validationErrors.type = "type is required";
    } else if (!isValidAction(payload.type, VALID_NOTIFICATION_TYPES)) {
      validationErrors.type = `type must be one of: ${VALID_NOTIFICATION_TYPES.join(', ')}`;
    }
    if (!payload.title) validationErrors.title = "title is required";
    if (!payload.body) validationErrors.body = "body is required";
    if (Object.keys(validationErrors).length > 0) {
      return validationErrorResponse(validationErrors);
    }

    const sanitizedTitle = sanitizeString(payload.title, 100) || 'Notification';
    const sanitizedBody = sanitizeString(payload.body, 500) || '';

    const isRideOffer = payload.type === 'RIDE_OFFER';
    const isRideStop = payload.type === 'RIDE_STOP';
    const isNegotiationUpdate = payload.type === 'NEGOTIATION_UPDATE';
    const incomingDataType = String(
      payload.data?.type || payload.data?.notification_type || "",
    ).toLowerCase();
    const isTripModified =
      payload.type === 'TRIP_UPDATE' && incomingDataType === 'trip_modified';

    // ── RIDE_OFFER: revalidate committed offer + driver before every push ──
    // Never trust presence.app_state=foreground to skip OS notification.
    // Never send after expiry. Push only tokens owned by ride_offers.driver_id.
    if (isRideOffer) {
      const offerId =
        payload.data?.offer_id ||
        payload.data?.offerId ||
        payload.data?.request_id ||
        payload.data?.requestId ||
        null;

      // Auto-accept confirmation uses type RIDE_OFFER with ride_auto_accepted —
      // skip offer push-gate (not a new-offer heads-up).
      const dataType = String(payload.data?.type || "").toLowerCase();
      const isNewRideOfferHeadsUp =
        dataType !== "ride_auto_accepted" &&
        dataType !== "auto_accepted";

      if (isNewRideOfferHeadsUp) {
        const gate = await evaluateRideOfferPushGate(supabase, {
          driverId: payload.driverId,
          offerId,
        });
        if (!gate.ok) {
          console.warn("[send-driver-notification] ride_offer_push_gate_skip", {
            driverId: payload.driverId,
            offerId,
            reason: gate.reason,
            revoke: gate.revoke,
          });
          if (gate.revoke && gate.offerId) {
            await revokeRideOfferNonDriverFault(supabase, {
              offerId: gate.offerId,
              reason: `ineligible_before_push:${gate.reason}`,
              deliveryPhase: "delivery_ineligible",
              extraTrace: {
                layer: "send_driver_notification",
                gate_reason: gate.reason,
              },
            });
          }
          return errorResponse(
            "DRIVER_INELIGIBLE",
            `Ride-offer push blocked: ${gate.reason}`,
            409,
            { sent: 0, reason: gate.reason, revoked: !!gate.revoke },
          );
        }
      }
    }

    // ─── Resolve push token ───
    // Sole authoritative device only (driver_active_devices → matching push_tokens).
    // NEVER fan out to historical is_active tokens / presence hints alone.
    const authoritative = await resolveDriverAuthoritativeToken(
      supabase,
      payload.driverId,
    );
    const tokens: { token: string; platform: string }[] = authoritative
      ? [{ token: authoritative.token, platform: authoritative.platform }]
      : [];

    const pushDataEarly = (payload.data ?? {}) as Record<string, unknown>;
    const instrumentationBookingIdEarly = resolveBookingIdFromPushData(pushDataEarly);
    // trip_modified must NOT write change_request_id into offer_id (ride_offers FK).
    const instrumentationOfferIdEarly = isTripModified
      ? null
      : resolveOfferIdFromPushData(pushDataEarly);
    const tripModifiedChangeRequestId = (() => {
      const raw =
        pushDataEarly.change_request_id ?? pushDataEarly.changeRequestId ?? null;
      return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    })();
    const notificationTypeEarly = String(
      pushDataEarly.type || pushDataEarly.notification_type || payload.type || "UNKNOWN",
    );

    if (tokens.length === 0) {
      console.log(
        "[send-driver-notification] No authoritative token for driver:",
        payload.driverId,
      );
      // Observability only — modification commit must not depend on this.
      // Scope new enqueue metrics to trip_modified so ride-offer postgres
      // push_enqueued is not double-written from this edge.
      if (isTripModified) {
        await recordBookingDeliveryPhaseBestEffort(supabase, {
          bookingId: instrumentationBookingIdEarly,
          driverId: payload.driverId,
          offerId: null,
          phase: "push_enqueued_skip_no_token",
          detail: {
            reason: "no_authoritative_push_token",
            notification_type: notificationTypeEarly,
            event_type: "trip_modified",
            change_request_id: tripModifiedChangeRequestId,
            modification_version:
              typeof pushDataEarly.modification_version === "string"
                ? pushDataEarly.modification_version
                : null,
          },
        });
      }
      return errorResponse("NO_TOKENS", "No push tokens found", 404, { sent: 0 });
    }

    // Enqueue metric before FCM — trip_modified only (ride offers use postgres trigger).
    if (isTripModified && instrumentationBookingIdEarly) {
      await recordBookingDeliveryPhaseBestEffort(supabase, {
        bookingId: instrumentationBookingIdEarly,
        driverId: payload.driverId,
        offerId: null,
        phase: "push_enqueued",
        detail: {
          notification_type: notificationTypeEarly,
          event_type: "trip_modified",
          change_request_id: tripModifiedChangeRequestId,
          modification_version:
            typeof pushDataEarly.modification_version === "string"
              ? pushDataEarly.modification_version
              : null,
          platform: authoritative?.platform ?? null,
        },
      });
    }

    // Get OAuth2 access token for FCM v1
    const accessToken = await getAccessToken(serviceAccount);
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;

    console.log(`[send-driver-notification] Sending ${payload.type} to ${tokens.length} device(s) via FCM v1`);

    const pushData = pushDataEarly;
    const instrumentationBookingId = instrumentationBookingIdEarly;
    const instrumentationOfferId = instrumentationOfferIdEarly;

    // Send to all registered devices
    const results: FcmAttemptResult[] = await Promise.all(
      tokens.map(async ({ token, platform }): Promise<FcmAttemptResult> => {
        const incomingData = payload.data ?? {};

        const offerId = incomingData.offerId || incomingData.offer_id || incomingData.requestId || incomingData.request_id || '';
        const tripId = incomingData.tripId || incomingData.trip_id || '';
        const pickupAddress = incomingData.pickupAddress || incomingData.pickup_address || incomingData.pickup || '';
        const dropoffAddress = incomingData.dropoffAddress || incomingData.dropoff_address || incomingData.dropoff || '';
        const majorFareAmount = incomingData.fareAmount || incomingData.estimated_fare || incomingData.estimatedFare || incomingData.fare || '';
        const penceFareAmount = incomingData.estimated_fare_pence || incomingData.estimated_total_pence || incomingData.gross_fare_pence || incomingData.base_fare_pence || '';
        const fareAmount = majorFareAmount || penceFareAmount || '';
        const currencyCode = incomingData.currencyCode || incomingData.currency_code || incomingData.currency || 'GBP';
        const stopReason = incomingData.stopReason || incomingData.stop_reason || '';

        let expirySeconds = incomingData.expirySeconds || '';
        if (!expirySeconds && incomingData.expires_at) {
          const secondsLeft = Math.floor((new Date(incomingData.expires_at).getTime() - Date.now()) / 1000);
          if (Number.isFinite(secondsLeft) && secondsLeft > 0) {
            expirySeconds = String(secondsLeft);
          }
        }

        // RIDE_OFFER envelope (payload.type) stays for routing. Driver app data.type
        // must remain NEW_RIDE_OFFER — never overwrite with the envelope name.
        const dataPayload: Record<string, string> = isRideOffer
          ? {
              ...buildRideOfferClientPushData(incomingData as Record<string, unknown>, {
                envelopeType: 'RIDE_OFFER',
              }),
              ...(pickupAddress ? { pickupAddress, pickup: pickupAddress, pickup_address: pickupAddress } : {}),
              ...(dropoffAddress ? { dropoffAddress, dropoff: dropoffAddress, dropoff_address: dropoffAddress } : {}),
              ...(fareAmount ? { fareAmount, fare: fareAmount, estimated_fare: majorFareAmount || fareAmount } : {}),
              ...(penceFareAmount ? {
                estimated_fare_pence: penceFareAmount,
                estimated_total_pence: penceFareAmount,
                gross_fare_pence: penceFareAmount,
                base_fare_pence: penceFareAmount,
              } : {}),
              ...(currencyCode ? { currencyCode, currency_code: currencyCode, currency: currencyCode } : {}),
              ...(expirySeconds ? { expirySeconds } : {}),
              ...(stopReason ? { stopReason, stop_reason: stopReason } : {}),
            }
          : {
              ...incomingData,
              // Preserve client routing type for trip_modified (Driver parseTripModifiedPushData).
              // Envelope stays TRIP_UPDATE for the allow-list.
              type: isTripModified ? 'trip_modified' : payload.type,
              notificationType:
                incomingData.notificationType ||
                incomingData.notification_type ||
                (isTripModified ? 'trip_modified' : null) ||
                incomingData.type ||
                payload.type,
              ...(offerId ? { offerId, requestId: offerId, offer_id: offerId } : {}),
              ...(tripId ? { tripId, trip_id: tripId } : {}),
              ...(pickupAddress ? { pickupAddress, pickup: pickupAddress, pickup_address: pickupAddress } : {}),
              ...(dropoffAddress ? { dropoffAddress, dropoff: dropoffAddress, dropoff_address: dropoffAddress } : {}),
              ...(fareAmount ? { fareAmount, fare: fareAmount, estimated_fare: majorFareAmount || fareAmount } : {}),
              ...(penceFareAmount ? {
                estimated_fare_pence: penceFareAmount,
                estimated_total_pence: penceFareAmount,
                gross_fare_pence: penceFareAmount,
                base_fare_pence: penceFareAmount,
              } : {}),
              ...(currencyCode ? { currencyCode, currency_code: currencyCode, currency: currencyCode } : {}),
              ...(expirySeconds ? { expirySeconds } : {}),
              ...(stopReason ? { stopReason, stop_reason: stopReason } : {}),
            };

        // Build FCM v1 message
        // deno-lint-ignore no-explicit-any
        const message: Record<string, any> = { token };

        if (platform === 'android') {
          if (isRideOffer) {
            // ── RIDE OFFER: DATA-ONLY — no message.notification ──
            // CRITICAL: If message.notification is present and the app is
            // backgrounded/killed, FCM delivers it directly to the OS system
            // tray, BYPASSING onMessageReceived() entirely. This means our
            // custom heads-up notification, full-screen intent, wake lock,
            // vibration loop, and ALARM-stream sound never fire.
            // Data-only messages ALWAYS trigger onMessageReceived().
            message.data = {
              ...dataPayload,
              title: sanitizedTitle,
              body: sanitizedBody,
            };
            // DO NOT set message.notification here — it breaks background delivery
            message.android = {
              priority: 'HIGH',
              ttl: '30s',
              direct_boot_ok: true, // deliver even before device unlock
            };
          } else if (isRideStop) {
            // ── RIDE STOP: Data-only, silent ──
            message.data = {
              ...dataPayload,
              title: sanitizedTitle,
              body: sanitizedBody,
            };
            message.android = {
              priority: 'HIGH',
              ttl: '10s',
              direct_boot_ok: true,
            };
          } else {
            message.notification = {
              title: sanitizedTitle,
              body: sanitizedBody,
            };
            message.data = {
              ...dataPayload,
              title: sanitizedTitle,
              body: sanitizedBody,
            };
            message.android = {
              priority: isNegotiationUpdate || isTripModified ? 'HIGH' : 'NORMAL',
              ttl: isNegotiationUpdate || isTripModified ? '30s' : '120s',
              notification: {
                channel_id: isTripModified
                  ? 'active_trip_updates'
                  : isNegotiationUpdate
                  ? 'onecab_driver_trip_updates_v1'
                  : 'default',
                sound: 'default',
              },
            };
          }
        } else if (platform === 'ios') {
          if (isRideStop) {
            // ── RIDE STOP on iOS: silent data-only push ──
            message.data = dataPayload;
            message.apns = {
              headers: {
                'apns-priority': '5',
                'apns-push-type': 'background',
              },
              payload: {
                aps: {
                  'content-available': 1,
                },
              },
            };
          } else if (isRideOffer) {
            // ── RIDE OFFER on iOS: PURE ALERT (no content-available) ──
            // CRITICAL FIX: Removed 'content-available': 1 because combining
            // it with alert type causes APNs to classify this as a "background
            // push that also includes an alert." iOS may then apply background-
            // push throttling/power-management rules, delaying or dropping the
            // notification when the device is locked or the app is suspended.
            // 
            // Without content-available, this is a pure alert push:
            // - iOS ALWAYS displays the notification immediately
            // - aps.alert provides the visual notification
            // - aps.sound provides the one-shot alert sound
            // - No background processing needed (display is handled by OS)
            // - willPresent fires if app is in foreground
            // - didReceive fires on notification tap
            //
            // DO NOT add content-available or mutable-content back without
            // verifying background delivery on real devices first.
            message.data = dataPayload;
            message.apns = {
              headers: {
                'apns-priority': '10',
                'apns-push-type': 'alert',
                'apns-expiration': String(Math.floor(Date.now() / 1000) + 30),
                'apns-collapse-id': 'ride_offer',
                'apns-topic': 'com.onecab.driver.app',
              },
              payload: {
                aps: {
                  alert: {
                    title: sanitizedTitle,
                    body: sanitizedBody,
                  },
                  sound: RIDE_OFFER_IOS_ALERT_SOUND,
                  // Never increment the home-screen badge — Driver is not a chat app.
                  badge: 0,
                  // iOS 15+ Focus: must stay so ride offers break through when allowed.
                  // Pairs with app entitlements + UNAuthorizationOptions.timeSensitive — do not remove.
                  'interruption-level': 'time-sensitive',
                },
              },
            };
          } else {
            // ── Other notification types on iOS ──
            message.notification = {
              title: sanitizedTitle,
              body: sanitizedBody,
            };
            message.data = dataPayload;
            message.apns = {
              headers: {
                'apns-priority': '10',
                'apns-push-type': 'alert',
              },
              payload: {
                aps: {
                  alert: {
                    title: sanitizedTitle,
                    body: sanitizedBody,
                  },
                  sound: 'default',
                  // Never increment the home-screen badge — Driver is not a chat app.
                  badge: 0,
                },
              },
            };
          }
        } else {
          message.notification = {
            title: sanitizedTitle,
            body: sanitizedBody,
          };
          message.data = dataPayload;
        }

        const hasTopLevelNotification = !!message.notification;
        console.log(`[send-driver-notification] → ${platform} [${payload.type}] hasNotification=${hasTopLevelNotification}:`, token.substring(0, 20) + "...");
        if (isRideOffer) {
          const apsPayload = message.apns?.payload?.aps;
          console.log(`[send-driver-notification] RIDE_OFFER payload shape: data=${!!message.data}, notification=${hasTopLevelNotification}, android=${!!message.android}, apns=${!!message.apns}`);
          console.log(`[send-driver-notification] RIDE_OFFER details: platform=${platform}, contentAvailable=${apsPayload?.['content-available'] ?? 'none'}, hasApsAlert=${!!apsPayload?.alert}, sound=${apsPayload?.sound ?? 'none'}, androidPriority=${message.android?.priority ?? 'none'}`);
          console.log(`[send-driver-notification] RIDE_OFFER full message JSON:`, JSON.stringify(message).substring(0, 500));
          if (platform === 'ios') {
            const isRealert = !!payload.data?.ios_realert;
            console.log(`[send-driver-notification] ios_apns_payload_has_alert=${!!apsPayload?.alert} ios_apns_sound_name=${apsPayload?.sound ?? 'none'} ios_apns_push_type=${message.apns?.headers?.['apns-push-type']} ios_apns_priority=${message.apns?.headers?.['apns-priority']} ios_interruption_level=${apsPayload?.['interruption-level'] ?? 'none'} ios_reminder_sent=${isRealert}`);
          }
        }
        if (isRideStop) {
          const stopReason = payload.data?.stopReason || payload.data?.reason || 'unknown';
          console.log(`[send-driver-notification] ride_stop_push_dispatched platform=${platform} driver=${payload.driverId} reason=${stopReason} offer=${payload.data?.offerId ?? 'none'} trip=${payload.data?.tripId ?? 'none'}`);
        }

        try {
          const response = await fetch(fcmUrl, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ message }),
          });

          if (response.ok) {
            const result = await response.json();
            console.log(`[send-driver-notification] ✓ ${platform} sent:`, result.name);
            if (platform === 'ios' && isRideOffer) {
              console.log(`[send-driver-notification] ios_push_provider_success driver=${payload.driverId} fcm_name=${result.name}`);
            }
            return {
              platform,
              success: true,
              providerResponse: typeof result?.name === "string" ? result.name : null,
              notificationChannel: notificationChannelForPlatform(platform, isRideOffer),
              error: null,
            };
          }

          const errBody = await response.json().catch(() => ({}));
          const errCode = errBody?.error?.details?.[0]?.errorCode
            ?? errBody?.error?.status
            ?? response.status;

          console.error(`[send-driver-notification] ✗ ${platform}:`, errCode, errBody?.error?.message, 'full:', JSON.stringify(errBody).substring(0, 300));

          // Soft-deactivate invalid tokens (preserve audit trail).
          if (
            errCode === 'UNREGISTERED' ||
            errCode === 'NOT_FOUND' ||
            response.status === 404
          ) {
            console.log(`[send-driver-notification] Deactivating invalid token`);
            await supabase
              .from("push_tokens")
              .update(buildTokenDeactivatePatch(`fcm_${String(errCode)}`))
              .eq("token", token)
              .eq("driver_id", payload.driverId)
              .eq("app_type", "driver")
              .eq("is_active", true);
          }

          return {
            platform,
            success: false,
            error: errBody?.error?.message ?? String(errCode),
            notificationChannel: notificationChannelForPlatform(platform, isRideOffer),
            providerResponse: null,
          };
        } catch (err) {
          console.error(`[send-driver-notification] Network error ${platform}:`, err);
          return {
            platform,
            success: false,
            error: String(err),
            notificationChannel: notificationChannelForPlatform(platform, isRideOffer),
            providerResponse: null,
          };
        }
      })
    );

    const successCount = results.filter(r => r.success).length;
    console.log(`[send-driver-notification] Done: ${successCount}/${tokens.length} sent`);

    // Observability only — never block or retry FCM because metrics write failed.
    // SQL idempotency on push_sent/push_failed (per offer) prevents reminder double-count.
    await recordFcmPushOutcomeBestEffort(supabase, {
      bookingId: instrumentationBookingId,
      driverId: payload.driverId,
      offerId: instrumentationOfferId,
      notificationType:
        String(pushData.type || pushData.notificationType || payload.type || "UNKNOWN"),
      title: sanitizedTitle,
      reminderIndex: (() => {
        const raw = pushData.reminder_index ?? pushData.reminderIndex ?? pushData.ios_realert;
        if (raw === true || raw === "true" || raw === "1") return 1;
        if (typeof raw === "number" && Number.isFinite(raw)) return raw;
        if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
        return null;
      })(),
      results,
      eventType: isTripModified ? "trip_modified" : null,
      changeRequestId: isTripModified ? tripModifiedChangeRequestId : null,
      modificationVersion:
        isTripModified && typeof pushData.modification_version === "string"
          ? pushData.modification_version
          : null,
    });

    return successResponse({
      success: successCount > 0,
      sent: successCount,
      total: tokens.length,
      results,
    });
  } catch (err) {
    console.error("[send-driver-notification] Unexpected error:", err);
    return errorResponse("INTERNAL_ERROR", String(err), 500);
  }
});
