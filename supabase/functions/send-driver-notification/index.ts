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
import { resolveAlertSound } from "../_shared/alertSoundResolver.ts";
import { RIDE_OFFER_IOS_ALERT_SOUND } from "../_shared/rideOfferPushCopy.ts";
import { DRIVER_NEW_RIDE_OFFER_TITLE } from "../_shared/negotiationPushCopy.ts";
import {
  canReceiveOffersByDriverId,
  logDriverEligibilityBlocked,
} from "../_shared/driverEligibility.ts";
import {
  extractOfferPushIds,
  logRideOfferPushBlocked,
  validateRideOfferPushEligibility,
} from "../_shared/rideOfferPushEligibility.ts";
import {
  buildTokenDeactivatePatch,
  isApnsDeviceToken,
  isInvalidProviderTokenError,
  tokenFingerprint,
} from "../_shared/driverPushToken.ts";

interface NotificationPayload {
  driverId: string;
  type: 'RIDE_OFFER' | 'RIDE_OFFER_REMINDER' | 'RIDE_STOP' | 'TRIP_UPDATE' | 'SYSTEM_ALERT' | 'NEGOTIATION_UPDATE';
  title: string;
  body: string;
  data?: Record<string, string>;
  /** When set, only deliver to devices registered on this platform (reminder workers). */
  targetPlatform?: 'ios' | 'android';
}

const VALID_NOTIFICATION_TYPES = ['RIDE_OFFER', 'RIDE_OFFER_REMINDER', 'RIDE_STOP', 'TRIP_UPDATE', 'SYSTEM_ALERT', 'NEGOTIATION_UPDATE'];
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

/** iOS lock screen: use authoritative server body when present (Phase 3 SSOT). */
function buildIosRideOfferAlertText(inputs: {
  serverTitle: string;
  serverBody: string;
  pickupAddress: string;
  fareMajor: string;
  farePence: string;
  currencyCode: string;
}): { title: string; body: string } {
  const title = DRIVER_NEW_RIDE_OFFER_TITLE;

  const serverBody = sanitizeString(inputs.serverBody, 500) ?? "";
  // Prefer SQL/Edge SSOT body: "New ride offer · £X\n1.2 mi · 4 min…\nPickup"
  if (
    serverBody.includes("New ride offer") ||
    serverBody.includes("New ride after current trip")
  ) {
    return { title: title.trim(), body: serverBody };
  }

  const pickupRaw = String(inputs.pickupAddress ?? "").split(/\r?\n/).map((s) => s.trim()).find((s) => s !== "") ??
    "";
  const firstPickupLine = sanitizeString(pickupRaw, 180) ?? "";

  const cur = String(inputs.currencyCode ?? "GBP").toUpperCase();
  let sym = `${cur} `;
  switch (cur) {
    case "GBP":
      sym = "£";
      break;
    case "EUR":
      sym = "€";
      break;
    case "USD":
      sym = "$";
      break;
    default:
      break;
  }

  let farePart = sanitizeString(String(inputs.fareMajor ?? "").trim(), 52) ?? "";
  if (!farePart) {
    const pRaw = String(inputs.farePence ?? "").trim();
    if (/^\d+$/.test(pRaw)) {
      const pNum = Number(pRaw);
      if (Number.isFinite(pNum) && pNum > 0) {
        const majors = pNum >= 500 ? pNum / 100 : pNum;
        farePart = sanitizeString(`${sym}${majors.toFixed(2)}`, 52) ?? "";
      }
    }
  } else if (!/^[$£€]/.test(farePart) && /^\d+(\.\d+)?$/.test(farePart)) {
    const n = Number(farePart);
    if (Number.isFinite(n))
      farePart = sanitizeString(`${sym}${n.toFixed(2)}`, 52) ?? "";
  }

  const parts: string[] = [];
  if (farePart) parts.push(`New ride offer · ${farePart}`);
  if (firstPickupLine) parts.push(firstPickupLine);

  let body =
    parts.length > 0
      ? (sanitizeString(parts.join("\n"), 240) ?? "")
      : serverBody;

  if (!body && firstPickupLine) body = firstPickupLine;
  if (!body && farePart) body = `New ride offer · ${farePart}`;
  if (!body) body = "Tap to respond";

  return { title: title.trim(), body };
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

    const OFFER_PUSH_TYPES = new Set(["RIDE_OFFER", "RIDE_OFFER_REMINDER"]);
    if (OFFER_PUSH_TYPES.has(payload.type)) {
      const offerEligibility = await canReceiveOffersByDriverId(supabase, payload.driverId);
      if (!offerEligibility.allowed) {
        logDriverEligibilityBlocked("send-driver-notification", payload.driverId, offerEligibility);
        return successResponse({
          skipped: true,
          reason: "driver_not_eligible",
          auth_state: offerEligibility.state,
          blocked_reasons: offerEligibility.blocked_reasons,
          sent: 0,
          total: 0,
        });
      }
    }

    const STALE_HEARTBEAT_SECONDS = 90;

    const { data: driverRow } = await supabase
      .from("drivers")
      .select("is_online")
      .eq("id", payload.driverId)
      .maybeSingle();

    const { data: presenceRow } = await supabase
      .from("driver_presence")
      .select("status, last_heartbeat_at")
      .eq("driver_id", payload.driverId)
      .maybeSingle();

    const presenceActive =
      presenceRow?.status === "online" || presenceRow?.status === "on_trip";

    const hbAt = presenceRow?.last_heartbeat_at;
    const heartbeatStale =
      typeof hbAt === "string"
      && (Date.now() - new Date(hbAt).getTime()) / 1000 > STALE_HEARTBEAT_SECONDS;

    const ineligibleForPush =
      driverRow?.is_online !== true
      || !presenceActive
      || heartbeatStale;

    if (ineligibleForPush) {
      console.log("[send-driver-notification] Skipped — driver not active for push:", {
        driverId: payload.driverId,
        type: payload.type,
        is_online: driverRow?.is_online,
        presence_status: presenceRow?.status ?? null,
        heartbeatStale,
      });
      return successResponse({
        skipped: true,
        reason: "driver_not_active",
        sent: 0,
        total: 0,
      });
    }

    if (OFFER_PUSH_TYPES.has(payload.type)) {
      const { offerId, tripId, expiresAtHint } = extractOfferPushIds(payload.data);
      const offerGate = await validateRideOfferPushEligibility(supabase, {
        driverId: payload.driverId,
        offerId,
        tripId,
        expiresAtHint,
        verifyDriverState: false,
      });

      if (!offerGate.allowed) {
        logRideOfferPushBlocked("send-driver-notification", {
          driverId: payload.driverId,
          offerId: offerGate.offerId ?? offerId,
          tripId: offerGate.tripId ?? tripId,
          reason: offerGate.reason,
          notificationType: payload.type,
        });
        return successResponse({
          skipped: true,
          reason: offerGate.reason,
          offer_id: offerGate.offerId ?? (offerId || null),
          trip_id: offerGate.tripId ?? (tripId || null),
          sent: 0,
          total: 0,
        });
      }
    }

    const sanitizedTitle = sanitizeString(payload.title, 100) || 'Notification';
    const sanitizedBody = sanitizeString(payload.body, 500) || '';

    // ─── Resolve push token ───
    // SOURCE OF TRUTH: push_tokens (one row per device, has reliable `platform`).
    // driver_presence.push_token can be stale or carry a token whose platform is
    // not in push_tokens (e.g. WebView FCM token registered before login). We use
    // it only as a hint to prefer the matching row.
    let tokens: { token: string; platform: string }[] = [];

    const { data: ptRows, error: tokenError } = await supabase
      .from("push_tokens")
      .select("token, platform, updated_at, is_active")
      .eq("driver_id", payload.driverId)
      .eq("app_type", "driver")
      .eq("is_active", true)
      .order("updated_at", { ascending: false });

    if (tokenError) {
      console.error("[send-driver-notification] Token fetch error:", tokenError);
      return errorResponse("TOKEN_FETCH_FAILED", "Failed to fetch push tokens", 500);
    }

    const isFcmRegistrationToken = (token: string, platform: string) => {
      const t = token.trim();
      if (!t || isApnsDeviceToken(t)) return false;
      // Modern FCM tokens: `prefix:APA91b...`
      if (t.includes(":") && t.length >= 80) return true;
      // iOS FCM registration tokens can be long alphanumeric strings without a colon.
      if (platform === "ios" && t.length >= 80) return true;
      if (platform === "android" && t.length >= 100) return true;
      return false;
    };

    const allTokens = (ptRows ?? []).filter(
      (r): r is { token: string; platform: string; updated_at: string } =>
        !!r?.token && !!r?.platform && isFcmRegistrationToken(r.token, r.platform),
    );

    // Soft-deactivate raw APNs device tokens — never send them via FCM v1.
    const rejectedTokens = (ptRows ?? []).filter(
      (r) => r?.token && isApnsDeviceToken(r.token),
    );
    for (const bad of rejectedTokens) {
      if (!bad?.token) continue;
      const fp = tokenFingerprint(bad.token);
      console.warn(
        `[send-driver-notification] Deactivating invalid push token driver=${payload.driverId} platform=${bad.platform} kind=apns_device fp=${fp}`,
      );
      await supabase
        .from("push_tokens")
        .update(buildTokenDeactivatePatch("rejected_apns_device_token"))
        .eq("token", bad.token)
        .eq("app_type", "driver");
    }

    // Optional hint: presence.push_token tells us which device the driver last
    // touched. Promote that row to the front so we send to the most active device first.
    const { data: presence } = await supabase
      .from("driver_presence")
      .select("push_token")
      .eq("driver_id", payload.driverId)
      .maybeSingle();

    if (presence?.push_token && allTokens.length > 0) {
      const idx = allTokens.findIndex(t => t.token === presence.push_token);
      if (idx > 0) {
        const [hint] = allTokens.splice(idx, 1);
        allTokens.unshift(hint);
      } else if (idx === -1) {
        const tokenHash = tokenFingerprint(presence.push_token);
        console.warn(`[send-driver-notification] presence.push_token not found in push_tokens (stale) — driver: ${payload.driverId}, fp=${tokenHash}. Using push_tokens table only.`);
      }
    }

    tokens = allTokens.map(({ token, platform }) => ({ token, platform }));

    if (payload.targetPlatform === 'ios' || payload.targetPlatform === 'android') {
      tokens = tokens.filter((t) => t.platform === payload.targetPlatform);
    }

    if (tokens.length === 0) {
      console.log("[send-driver-notification] No tokens for driver:", payload.driverId);
      return errorResponse("NO_TOKENS", "No push tokens found", 404, { sent: 0 });
    }

    // Get OAuth2 access token for FCM v1
    const accessToken = await getAccessToken(serviceAccount);
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;

    console.log(`[send-driver-notification] Sending ${payload.type} to ${tokens.length} device(s) via FCM v1`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const isRideOffer = payload.type === 'RIDE_OFFER' || payload.type === 'RIDE_OFFER_REMINDER';
    const isRideReminder = payload.type === 'RIDE_OFFER_REMINDER';
    const isRideStop = payload.type === 'RIDE_STOP';
    const isNegotiationUpdate = payload.type === 'NEGOTIATION_UPDATE';
    const notificationTitle = isRideOffer ? DRIVER_NEW_RIDE_OFFER_TITLE : sanitizedTitle;

    const offerMetaId = String(
      (payload.data?.offer_id as string | undefined) ||
        (payload.data?.offerId as string | undefined) ||
        "",
    );

    let rideOfferAdminSoundUrl: string | null = null;
    if (isRideOffer && supabaseUrl) {
      const resolved = await resolveAlertSound(supabase, "driver", "new_ride_offer", supabaseUrl);
      rideOfferAdminSoundUrl = resolved?.publicUrl ?? null;
      if (rideOfferAdminSoundUrl) {
        console.log("[send-driver-notification] admin alert sound resolved for new_ride_offer");
      }
    }

    // Send to all registered devices
    const results = await Promise.all(
      tokens.map(async ({ token, platform }) => {
        const incomingData = payload.data ?? {};

        const offerId =
          incomingData.offerId ||
          incomingData.offer_id ||
          incomingData.requestId ||
          incomingData.request_id ||
          '';
        const tripId = incomingData.tripId || incomingData.trip_id || incomingData.bookingId || incomingData.booking_id || '';
        const pickupAddress = incomingData.pickupAddress || incomingData.pickup_address || incomingData.pickup || '';
        const dropoffAddress = incomingData.dropoffAddress || incomingData.dropoff_address || incomingData.dropoff || '';
        // Driver-net only — never customer gross / estimated customer fare.
        const majorFareAmount =
          incomingData.driver_net_fare ||
          incomingData.driverNetFare ||
          incomingData.driver_earnings ||
          '';
        const penceFareAmount =
          incomingData.driver_net_fare_pence ||
          incomingData.driver_net_pence ||
          incomingData.driverNetFarePence ||
          incomingData.accepted_driver_offer_fare_pence ||
          incomingData.driver_earnings_pence ||
          '';
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

        const dataPayload = Object.fromEntries(
          Object.entries({ ...incomingData }).map(([k, v]) => [k, v == null ? '' : String(v)]),
        ) as Record<string, string>;

        /** Android ride offers are data-only and use an explicit NEW_RIDE_OFFER data marker. */
        const inboundTypeLower = incomingData.type != null
          ? String(incomingData.type).trim().toLowerCase()
          : "";
        const rideOfferSemantic =
          inboundTypeLower === "stacked_ride_offer"
            ? "stacked_ride_offer"
            : inboundTypeLower === "ride_offer"
              ? "ride_offer"
              : inboundTypeLower === "new_ride_offer_reminder"
                ? "new_ride_offer_reminder"
                : inboundTypeLower === "new_ride_offer"
                  ? "new_ride_offer"
                  : null;

        const rideOfferDataType = isRideReminder
          ? "new_ride_offer_reminder"
          : rideOfferSemantic === "stacked_ride_offer"
            ? "stacked_ride_offer"
            : "NEW_RIDE_OFFER";

        Object.assign(dataPayload, {
          type: isRideOffer ? rideOfferDataType : payload.type,
          notificationType: incomingData.notificationType || incomingData.offer_notification_type ||
            (isRideOffer ? rideOfferDataType : inboundTypeLower || payload.type),
          ...(offerId ? { offerId, requestId: offerId, offer_id: offerId } : {}),
          ...(tripId ? {
            tripId,
            trip_id: tripId,
            bookingId: tripId,
            booking_id: tripId,
            ride_id: tripId,
          } : {}),
          ...(pickupAddress ? { pickupAddress, pickup: pickupAddress, pickup_address: pickupAddress } : {}),
          ...(dropoffAddress ? { dropoffAddress, dropoff: dropoffAddress, dropoff_address: dropoffAddress } : {}),
          ...(isRideOffer && incomingData.driver_earnings_pence
            ? {
              driver_earnings_pence: String(incomingData.driver_earnings_pence),
              driver_net_preview_pence: String(
                incomingData.driver_net_preview_pence ?? incomingData.driver_earnings_pence,
              ),
            }
            : !isRideOffer && fareAmount
              ? { fareAmount, fare: fareAmount, estimated_fare: majorFareAmount || fareAmount }
              : {}),
          ...(isRideOffer
            ? {}
            : penceFareAmount
              ? {
                estimated_fare_pence: penceFareAmount,
                estimated_total_pence: penceFareAmount,
                gross_fare_pence: penceFareAmount,
                base_fare_pence: penceFareAmount,
              }
              : {}),
          ...(currencyCode ? { currencyCode, currency_code: currencyCode, currency: currencyCode } : {}),
          ...(expirySeconds ? { expirySeconds } : {}),
          ...(stopReason ? { stopReason, stop_reason: stopReason } : {}),
        });

        // Ride-offer envelopes: stable semantic type + identities for OS data payloads (FCM/APNs → native).
        if (isRideOffer) {
          const expiresAtIso =
            typeof incomingData.expires_at === "string" && incomingData.expires_at.trim() !== ""
              ? incomingData.expires_at.trim()
              : "";
          const reminderFallback = isRideReminder ? "new_ride_offer_reminder" : "new_ride_offer";
          Object.assign(dataPayload, {
            notificationType:
              incomingData.notificationType?.trim()
              || incomingData.offer_notification_type?.trim()
              || dataPayload.notificationType
              || reminderFallback,
            driver_id: payload.driverId,
          });
          if (expiresAtIso) {
            dataPayload.expires_at = expiresAtIso;
          }
          if (isRideReminder && incomingData.reminder_index) {
            dataPayload.reminder_index = String(incomingData.reminder_index);
          }
          if (rideOfferAdminSoundUrl) {
            dataPayload.alert_sound_url = rideOfferAdminSoundUrl;
            dataPayload.alert_sound_event = "new_ride_offer";
          }
        }

        const rawIosSoundBase =
          incomingData.sound != null && String(incomingData.sound).trim() !== ''
            ? String(incomingData.sound).trim()
            : 'default';

        /** iOS APNs `aps.sound` — mono CAF in Copy Bundle Resources. */
        const IOS_RIDE_OFFER_BUNDLE_SOUND = RIDE_OFFER_IOS_ALERT_SOUND;

        const normalizeIosRideOfferApnsSound = (sound: string): string => {
          const s = sound.trim().toLowerCase();
          if (
            s === "default" || s === "" || s === "none" || s === "silent"
          ) {
            return s;
          }
          if (
            s === "ride_offer_alert.caf"
            || s === "ride_offer_alert"
            || s === "onecab_true_original_refined.wav"
            || s === "onecab_true_original_refined"
            || s === "onecab_true_original_refined.caf"
          ) {
            return IOS_RIDE_OFFER_BUNDLE_SOUND;
          }
          return sound.trim();
        };

        const rawIosSound =
          platform === "ios" && isRideOffer
            ? normalizeIosRideOfferApnsSound(rawIosSoundBase)
            : rawIosSoundBase;

        const reminderIdx = incomingData.reminder_index?.trim();

        let apnsRideOfferSound:
          | string
          | 'default'
          | undefined =
          rawIosSound.toLowerCase() === 'none' || rawIosSound.toLowerCase() === 'silent'
            ? undefined
            : rawIosSound.toLowerCase() === 'default'
              ? ('default' as const)
              : rawIosSound;

        // iOS ride offers: default to system alert sound for reliable lock-screen / background banners.
        if (platform === "ios" && isRideOffer) {
          const wantsSilent =
            rawIosSound.toLowerCase() === "none" || rawIosSound.toLowerCase() === "silent";
          if (!wantsSilent && apnsRideOfferSound === undefined) {
            apnsRideOfferSound = "default";
          }
        }

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
            //
            // Copy parity with Driver hydrate:
            //   title = "New ride offer · £X.XX"
            //   body  = "1.2 mi · 4 min to pickup\nPickup"
            const bodyLines = sanitizedBody.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            const androidTitle =
              bodyLines[0] &&
              (bodyLines[0].includes("New ride offer") ||
                bodyLines[0].includes("New ride after current trip"))
                ? bodyLines[0]
                : notificationTitle;
            const androidBody =
              bodyLines.length > 1 ? bodyLines.slice(1).join("\n") : sanitizedBody;
            message.data = {
              ...dataPayload,
              title: androidTitle,
              body: androidBody,
              ...(isRideReminder ? { notification_update_only: 'true' } : {}),
            };
            // DO NOT set message.notification here — it breaks background delivery
            message.android = {
              priority: 'high',
              // Long-TTL so offers can be delivered after extended background
              // suspension (Doze / OEM limits). FCM may still defer; this only
              // prevents an early server-side discard at 30s.
              ttl: '3600s',
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
              priority: 'high',
              ttl: '10s',
              direct_boot_ok: true,
            };
          } else if (isNegotiationUpdate) {
            // ── NEGOTIATION UPDATE: data-only — sync OfferStateStore, no new alert audio ──
            message.data = {
              ...dataPayload,
              type: dataPayload.type || 'NEGOTIATION_UPDATE',
              title: sanitizedTitle,
              body: sanitizedBody,
            };
            message.android = {
              priority: 'high',
              ttl: '120s',
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
              priority: 'normal',
              ttl: '120s',
              notification: {
                channel_id: 'default',
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
            // ── RIDE OFFER on iOS: alert push (never data-only / content-available) ──
            // FCM must include BOTH top-level `notification` and `apns.payload.aps.alert`
            // or iOS will not reliably show heads-up banners while the app is backgrounded.
            message.data = dataPayload;
            const iosRideAlert = buildIosRideOfferAlertText({
              serverTitle: notificationTitle,
              serverBody: sanitizedBody,
              pickupAddress,
              fareMajor: majorFareAmount ? String(majorFareAmount) : "",
              farePence: penceFareAmount ? String(penceFareAmount) : "",
              currencyCode,
            });
            message.notification = {
              title: iosRideAlert.title,
              body: iosRideAlert.body,
            };
            // deno-lint-ignore no-explicit-any
            const apsRide: Record<string, any> = {
              alert: {
                title: iosRideAlert.title,
                body: iosRideAlert.body,
              },
              badge: 1,
              sound: apnsRideOfferSound != null && apnsRideOfferSound !== ''
                ? apnsRideOfferSound
                : 'default',
              // iOS 15+ Focus: pairs with UNAuthorizationOptions.timeSensitive.
              'interruption-level': 'time-sensitive',
            };
            const rideCollapseKey = (tripId || offerId || token.slice(-12)).slice(0, 48);
            const apnsCollapseId = `ride_${rideCollapseKey}_offer`.slice(0, 64);
            if (isRideReminder) {
              // Reminder updates the same tray notification — no repeat sound/heads-up.
              apsRide.sound = undefined;
              apsRide['interruption-level'] = 'passive';
            }
            message.apns = {
              headers: {
                'apns-priority': isRideReminder ? '5' : '10',
                'apns-push-type': 'alert',
                'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
                'apns-collapse-id': apnsCollapseId,
                'apns-topic': 'com.onecab.driver.app',
              },
              payload: {
                aps: apsRide,
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
                  badge: 1,
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
        console.log(`[send-driver-notification] → ${platform} [${payload.type}] hasNotification=${hasTopLevelNotification}: fp=${tokenFingerprint(token)}`);
        if (isRideOffer) {
          const apsPayload = message.apns?.payload?.aps;
          const apnsHeaders = message.apns?.headers;
          console.log(`[send-driver-notification] RIDE_OFFER payload shape: data=${!!message.data}, notification=${hasTopLevelNotification}, android=${!!message.android}, apns=${!!message.apns}`);
          console.log(`[send-driver-notification] RIDE_OFFER details: platform=${platform}, contentAvailable=${apsPayload?.['content-available'] ?? 'none'}, hasApsAlert=${!!apsPayload?.alert}, sound=${apsPayload?.sound ?? 'none'}, androidPriority=${message.android?.priority ?? 'none'}`);
          if (platform === "ios") {
            console.log("[send-driver-notification] ios_apns_ride_offer", {
              apns_push_type: apnsHeaders?.["apns-push-type"] ?? null,
              apns_priority: apnsHeaders?.["apns-priority"] ?? null,
              sound: apsPayload?.sound ?? null,
              interruption_level: apsPayload?.["interruption-level"] ?? null,
              has_alert_title: !!(apsPayload?.alert && typeof apsPayload.alert === "object" && apsPayload.alert.title),
              has_alert_body: !!(apsPayload?.alert && typeof apsPayload.alert === "object" && apsPayload.alert.body),
              type: dataPayload.type ?? null,
              notificationType: dataPayload.notificationType ?? null,
              offer_id: dataPayload.offer_id ?? null,
              booking_id: dataPayload.booking_id ?? null,
              expires_at: dataPayload.expires_at ?? null,
              reminder_index: dataPayload.reminder_index ?? null,
            });
          }
          console.log(`[send-driver-notification] RIDE_OFFER full message JSON:`, JSON.stringify(message).substring(0, 500));
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
            return {
              platform,
              success: true,
              provider_response: result?.name ?? null,
              token_fp: tokenFingerprint(token),
              notification_channel: platform === 'android' ? 'onecab_driver_offers' : 'apns_time_sensitive',
              notification_sound_name: platform === 'android' ? 'ride_offer_alert' : IOS_RIDE_OFFER_BUNDLE_SOUND,
            };
          }

          const errBody = await response.json().catch(() => ({}));
          const errCode = errBody?.error?.details?.[0]?.errorCode
            ?? errBody?.error?.status
            ?? response.status;

          console.error(`[send-driver-notification] ✗ ${platform}:`, errCode, errBody?.error?.message, 'full:', JSON.stringify(errBody).substring(0, 300));

          const errMessage = String(errBody?.error?.message ?? "");
          const shouldDeactivate = isInvalidProviderTokenError({
            errCode,
            errMessage,
            httpStatus: response.status,
          });

          // Soft-deactivate invalid tokens so they are never sent again.
          if (shouldDeactivate) {
            const fp = tokenFingerprint(token);
            console.warn(
              `[delivery] push_invalid_token_deactivated driver_id=${payload.driverId} offer_id=${offerMetaId || "n/a"} platform=${platform} code=${String(errCode)} fp=${fp}`,
            );
            await supabase
              .from("push_tokens")
              .update(
                buildTokenDeactivatePatch(
                  `provider:${String(errCode)}:${errMessage}`.slice(0, 200),
                ),
              )
              .eq("token", token)
              .eq("app_type", "driver");
          }

          return {
            platform,
            success: false,
            error: errBody?.error?.message ?? String(errCode),
            provider_response: errBody?.error?.status ?? response.status,
            token_fp: tokenFingerprint(token),
            notification_channel: platform === 'android' ? 'onecab_driver_offers' : 'apns_time_sensitive',
            notification_sound_name: platform === 'android' ? 'ride_offer_alert' : IOS_RIDE_OFFER_BUNDLE_SOUND,
          };
        } catch (err) {
          console.error(`[send-driver-notification] Network error ${platform}:`, err);
          return {
            platform,
            success: false,
            error: String(err),
            provider_response: 'network_exception',
            token_fp: tokenFingerprint(token),
            notification_channel: platform === 'android' ? 'onecab_driver_offers' : 'apns_time_sensitive',
            notification_sound_name: platform === 'android' ? 'ride_offer_alert' : IOS_RIDE_OFFER_BUNDLE_SOUND,
          };
        }
      })
    );

    const successCount = results.filter(r => r.success).length;
    console.log(`[send-driver-notification] Done: ${successCount}/${tokens.length} sent`);

    const offerUuidRaw =
      (payload.data?.offer_id as string | undefined) ||
      (payload.data?.offerId as string | undefined) ||
      "";
    if (isRideOffer) {
      const oid =
        typeof offerUuidRaw === "string" && isValidUUID(offerUuidRaw.trim())
          ? offerUuidRaw.trim()
          : "";
      console.log(
        `[booking_delivery] push_sent offer_id=${oid || "n/a"} driver_id=${payload.driverId} devices_ok=${successCount}/${tokens.length}`,
      );
    }

    if (
      isRideOffer &&
      typeof offerUuidRaw === "string" &&
      isValidUUID(offerUuidRaw.trim())
    ) {
      const oid = offerUuidRaw.trim();
      const reminderIndex =
        typeof payload.data?.reminder_index === "string" && payload.data.reminder_index.trim() !== ""
          ? payload.data.reminder_index.trim()
          : null;
      const notificationType =
        typeof payload.data?.notificationType === "string" && payload.data.notificationType.trim() !== ""
          ? payload.data.notificationType.trim()
          : typeof payload.data?.offer_notification_type === "string" && payload.data.offer_notification_type.trim() !== ""
            ? payload.data.offer_notification_type.trim()
            : typeof payload.data?.type === "string" && payload.data.type.trim() !== ""
              ? payload.data.type.trim()
              : payload.type;
      const { error: mergeErr } = await supabase.rpc("merge_ride_offer_push_log", {
        p_offer_id: oid,
        p_json: {
          at: new Date().toISOString(),
          title: notificationTitle,
          notification_type: notificationType,
          reminder_index: reminderIndex,
          sent: successCount,
          total_tokens: tokens.length,
          results: results.map((r: {
            platform?: string;
            success?: boolean;
            error?: string;
            provider_response?: string | number | null;
            token_fp?: string;
            notification_channel?: string;
          }) => ({
            platform: r.platform,
            success: r.success,
            error: r.error ?? null,
            provider_response: r.provider_response ?? null,
            token_fp: r.token_fp ?? null,
            notification_channel: r.notification_channel ?? null,
          })),
        },
      });
      if (mergeErr) {
        console.warn("[send-driver-notification] merge_ride_offer_push_log failed:", mergeErr);
      }

      const { data: tripRow, error: tripErr } = await supabase
        .from("ride_offers")
        .select("trip_id")
        .eq("id", oid)
        .maybeSingle();
      if (tripErr) {
        console.warn("[send-driver-notification] trip_id lookup before record_booking_delivery:", tripErr);
      } else if (tripRow?.trip_id && isValidUUID(payload.driverId)) {
        const { error: bdlErr } = await supabase.rpc("record_booking_delivery", {
          p_booking_id: tripRow.trip_id,
          p_phase: "push_sent",
          p_driver_id: payload.driverId,
          p_offer_id: oid,
          p_source: "edge",
          p_detail: {
            devices_ok: successCount,
            total_tokens: tokens.length,
            at: new Date().toISOString(),
            title: notificationTitle,
            notification_type: notificationType,
            reminder_index: reminderIndex,
            results: results.map((r: {
              platform?: string;
              success?: boolean;
              error?: string;
              provider_response?: string | number | null;
              token_fp?: string;
              notification_channel?: string;
            }) => ({
              platform: r.platform,
              success: r.success,
              error: r.error ?? null,
              provider_response: r.provider_response ?? null,
              token_fp: r.token_fp ?? null,
              notification_channel: r.notification_channel ?? null,
            })),
          },
        });
        if (bdlErr) {
          console.warn("[send-driver-notification] record_booking_delivery failed:", bdlErr);
        }

        // Note: We no longer explicitly schedule +4s / +8s reminder pushes here
        // via `ride_offer_enqueue_reminders` RPC. The database trigger
        // `ride_offer_dispatch_push_delivery` (or auto-dispatch) manages this canonically
        // to prevent duplicate background scheduling loops and concurrent ringing.
      }
    }

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
