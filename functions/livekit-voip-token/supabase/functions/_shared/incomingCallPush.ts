/**
 * Incoming-call push — safe payload only (no token, room, phones, secrets).
 * Reuses FCM v1 pattern from campaign heads-up. Logs token fingerprints only.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

const INCOMING_CALL_TYPE = "incoming_call";

/** Must match Customer `INCOMING_CALL_CHANNEL_ID` — never trip-updates / driver_assigned. */
export const CUSTOMER_INCOMING_VOIP_ANDROID_CHANNEL = "onecab_incoming_voip_v2";
/** Must match Driver `INCOMING_CALL_CHANNEL_ID`. */
export const DRIVER_INCOMING_VOIP_ANDROID_CHANNEL = "onecab_incoming_voip_v1";

export function pushTokenFingerprint(token: string): string {
  // Short non-reversible fingerprint for logs — never log full tokens.
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return `fp_${(hash >>> 0).toString(16).padStart(8, "0")}_${token.length}`;
}

async function getFcmAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const enc = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsignedToken = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const pemContents = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const keyBuffer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken),
  );
  const jwt = `${unsignedToken}.${enc(String.fromCharCode(...new Uint8Array(signature)))}`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!tokenResponse.ok) {
    throw new Error("FCM token exchange failed");
  }
  const tokenData = await tokenResponse.json();
  return tokenData.access_token as string;
}

async function sendFcmAlert(opts: {
  projectId: string;
  accessToken: string;
  token: string;
  platform: string;
  title: string;
  body: string;
  data: Record<string, string>;
  /** Android notification channel — incoming VoIP must NOT use trip-updates. */
  androidChannelId: string;
}): Promise<{ success: boolean }> {
  const message: Record<string, unknown> = {
    token: opts.token,
    data: opts.data,
    notification: { title: opts.title, body: opts.body },
  };
  if (opts.platform === "android") {
    message.android = {
      priority: "HIGH",
      notification: {
        channel_id: opts.androidChannelId,
        tag: opts.data.call_id,
        notification_priority: "PRIORITY_MAX",
      },
    };
  } else if (opts.platform === "ios") {
    message.apns = {
      headers: { "apns-priority": "10", "apns-push-type": "alert" },
      payload: {
        aps: {
          alert: { title: opts.title, body: opts.body },
          "thread-id": opts.data.trip_id,
          category: INCOMING_CALL_TYPE,
          sound: "default",
          "interruption-level": "time-sensitive",
        },
      },
    };
  }

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${opts.projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    },
  );
  return { success: response.ok };
}

export type IncomingCallPushInput = {
  tripId: string;
  callId: string;
  method: "voip";
  initiatorRole: "driver" | "customer";
  expiresAt: string | null;
  /** Recipient driver profile id when notifying driver. */
  recipientDriverId?: string | null;
  /** Recipient auth user id when notifying customer. */
  recipientUserId?: string | null;
};

/**
 * Send incoming-call push to the opposite participant.
 * Payload excludes LiveKit token, room name, phones, and credentials.
 */
export async function sendIncomingCallPush(
  client: SupabaseClient,
  input: IncomingCallPushInput,
): Promise<{ sent: number; skipped: boolean; reason?: string }> {
  const serviceAccountJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ??
    Deno.env.get("FCM_SERVICE_ACCOUNT_JSON") ??
    Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON");
  if (!serviceAccountJson) {
    console.warn("[incomingCallPush] FCM service account missing — push skipped");
    return { sent: 0, skipped: true, reason: "fcm_not_configured" };
  }

  let projectId: string;
  try {
    projectId = JSON.parse(serviceAccountJson).project_id;
  } catch {
    return { sent: 0, skipped: true, reason: "fcm_config_invalid" };
  }

  const title = "ONECAB";
  const body = input.initiatorRole === "customer"
    ? "Passenger is calling"
    : "Your driver is calling";

  const data: Record<string, string> = {
    type: INCOMING_CALL_TYPE,
    notification_type: INCOMING_CALL_TYPE,
    call_id: input.callId,
    trip_id: input.tripId,
    method: input.method,
    initiator_role: input.initiatorRole,
    expires_at: input.expiresAt ?? "",
  };

  // Defensive: never allow secret-like keys in data
  for (const forbidden of ["token", "room_name", "livekit_url", "phone", "auth_key"]) {
    if (forbidden in data) delete data[forbidden];
  }

  let resolved: { token: string; platform: string } | null = null;

  if (input.initiatorRole === "customer" && input.recipientDriverId) {
    const {
      resolveDriverAuthoritativeToken,
    } = await import("./authoritativeDevicePush.ts");
    const row = await resolveDriverAuthoritativeToken(
      client,
      input.recipientDriverId,
    );
    if (row) resolved = { token: row.token, platform: row.platform };
  } else if (input.initiatorRole === "driver" && input.recipientUserId) {
    const {
      resolveCustomerAuthoritativeToken,
    } = await import("./authoritativeDevicePush.ts");
    const row = await resolveCustomerAuthoritativeToken(
      client,
      input.recipientUserId,
    );
    if (row) resolved = { token: row.token, platform: row.platform };
  }

  if (!resolved?.token) {
    console.info("[incomingCallPush] no authoritative recipient token", {
      call_id: input.callId,
      initiator_role: input.initiatorRole,
    });
    return { sent: 0, skipped: true, reason: "no_tokens" };
  }

  let accessToken: string;
  try {
    accessToken = await getFcmAccessToken(serviceAccountJson);
  } catch (error) {
    console.warn("[incomingCallPush] FCM auth failed");
    return { sent: 0, skipped: true, reason: "fcm_auth_failed" };
  }

  const fp = pushTokenFingerprint(resolved.token);
  try {
    const result = await sendFcmAlert({
      projectId,
      accessToken,
      token: resolved.token,
      platform: (resolved.platform ?? "android").toLowerCase().includes("ios")
        ? "ios"
        : "android",
      title,
      body,
      data,
      androidChannelId: input.initiatorRole === "customer"
        ? DRIVER_INCOMING_VOIP_ANDROID_CHANNEL
        : CUSTOMER_INCOMING_VOIP_ANDROID_CHANNEL,
    });
    if (result.success) {
      console.info("[incomingCallPush] sent", { call_id: input.callId, token_fp: fp });
      return { sent: 1, skipped: false };
    }
    console.warn("[incomingCallPush] send failed", { call_id: input.callId, token_fp: fp });
  } catch {
    console.warn("[incomingCallPush] send error", { call_id: input.callId, token_fp: fp });
  }

  return { sent: 0, skipped: true };
}

export type CallEndedPushInput = {
  tripId: string;
  callId: string;
  method: "voip" | "call_masking";
  endReason: string;
  driverId?: string | null;
  customerUserId?: string | null;
};

/** Safe call-ended / timeout push — no tokens, room names, or phones. */
export async function sendCallEndedPush(
  client: SupabaseClient,
  input: CallEndedPushInput,
): Promise<{ sent: number }> {
  const serviceAccountJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ??
    Deno.env.get("FCM_SERVICE_ACCOUNT_JSON") ??
    Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON");
  if (!serviceAccountJson) return { sent: 0 };

  let projectId: string;
  try {
    projectId = JSON.parse(serviceAccountJson).project_id;
  } catch {
    return { sent: 0 };
  }

  const title = "ONECAB";
  const body = input.endReason.includes("DURATION") || input.endReason.includes("TIMED")
    ? "Call ended — maximum call duration reached."
    : "Call ended.";
  const data: Record<string, string> = {
    type: "call_ended",
    notification_type: "call_ended",
    call_id: input.callId,
    trip_id: input.tripId,
    method: input.method,
    end_reason: input.endReason.slice(0, 64),
  };

  type TokenRow = { token: string; platform: string | null; androidChannelId: string };
  const tokens: TokenRow[] = [];
  if (input.driverId) {
    const {
      resolveDriverAuthoritativeToken,
    } = await import("./authoritativeDevicePush.ts");
    const row = await resolveDriverAuthoritativeToken(client, input.driverId);
    if (row) {
      tokens.push({
        token: row.token,
        platform: row.platform,
        androidChannelId: DRIVER_INCOMING_VOIP_ANDROID_CHANNEL,
      });
    }
  }
  if (input.customerUserId) {
    const {
      resolveCustomerAuthoritativeToken,
    } = await import("./authoritativeDevicePush.ts");
    const row = await resolveCustomerAuthoritativeToken(
      client,
      input.customerUserId,
    );
    if (row) {
      tokens.push({
        token: row.token,
        platform: row.platform,
        androidChannelId: CUSTOMER_INCOMING_VOIP_ANDROID_CHANNEL,
      });
    }
  }
  if (!tokens.length) return { sent: 0 };

  let accessToken: string;
  try {
    accessToken = await getFcmAccessToken(serviceAccountJson);
  } catch {
    return { sent: 0 };
  }

  let sent = 0;
  for (const row of tokens) {
    if (!row.token) continue;
    const fp = pushTokenFingerprint(row.token);
    try {
      const result = await sendFcmAlert({
        projectId,
        accessToken,
        token: row.token,
        platform: (row.platform ?? "android").toLowerCase().includes("ios") ? "ios" : "android",
        title,
        body,
        data,
        androidChannelId: row.androidChannelId,
      });
      if (result.success) {
        sent += 1;
        console.info("[callEndedPush] sent", { call_id: input.callId, token_fp: fp });
      }
    } catch {
      console.warn("[callEndedPush] send error", { call_id: input.callId, token_fp: fp });
    }
  }
  return { sent };
}
