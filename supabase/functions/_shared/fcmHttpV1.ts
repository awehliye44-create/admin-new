/**
 * FCM HTTP v1 transport for Customer senders (send-trip-notification,
 * send-customer-notification). Same service-account chain as Driver / VoIP.
 * The legacy server-key API (fcm/send) is retired by Google — never reintroduce it.
 * Never log the service account, the access token, or a full device token.
 */

export function readFcmServiceAccountJson(): string | undefined {
  return Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ??
    Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
}

export function fcmProjectIdFromServiceAccount(serviceAccountJson: string): string {
  return JSON.parse(serviceAccountJson).project_id;
}

export async function getFcmHttpV1AccessToken(serviceAccountJson: string): Promise<string> {
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
    const err = await tokenResponse.text();
    throw new Error(`Failed to get FCM access token: ${err}`);
  }

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

export function fcmHttpV1SendUrl(projectId: string): string {
  return `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
}

export type FcmHttpV1Failure = {
  httpStatus: number;
  /** FCM `errorCode` from error details, else the Google RPC status. */
  errorCode: string;
  /** Definitive: the registration token no longer exists for this project. */
  tokenDead: boolean;
};

/**
 * Only UNREGISTERED / 404 / 410 mean the token is gone. SENDER_ID_MISMATCH,
 * INVALID_ARGUMENT, auth (401/403), quota (429) and 5xx are not token death.
 */
export function classifyFcmHttpV1Failure(httpStatus: number, bodyText: string): FcmHttpV1Failure {
  let errorCode = "";
  try {
    const parsed = JSON.parse(bodyText);
    const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
    const fcmDetail = details.find((d: { errorCode?: unknown }) => typeof d?.errorCode === "string");
    errorCode = String(fcmDetail?.errorCode ?? parsed?.error?.status ?? "");
  } catch {
    errorCode = "";
  }
  if (!errorCode) errorCode = `HTTP_${httpStatus}`;
  const tokenDead = errorCode === "UNREGISTERED" || httpStatus === 404 || httpStatus === 410;
  return { httpStatus, errorCode, tokenDead };
}

export async function sendFcmHttpV1Message(opts: {
  projectId: string;
  accessToken: string;
  message: Record<string, unknown>;
}): Promise<{ ok: true } | ({ ok: false } & FcmHttpV1Failure)> {
  const response = await fetch(fcmHttpV1SendUrl(opts.projectId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: opts.message }),
  });
  if (response.ok) {
    await response.body?.cancel();
    return { ok: true };
  }
  const bodyText = await response.text();
  return { ok: false, ...classifyFcmHttpV1Failure(response.status, bodyText) };
}
