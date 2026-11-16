/**
 * ActivityKit APNs liveactivity update/end — presentation delivery only.
 * Requires APNS_KEY_ID + APNS_TEAM_ID + APNS_AUTH_KEY_P8 (+ optional APNS_BUNDLE_ID).
 * When unset, callers must skip iOS LA push without failing trip mutations.
 */

export type LiveActivityApnsEvent = "update" | "end" | "start";

export function liveActivityApnsConfigured(): boolean {
  return Boolean(
    Deno.env.get("APNS_KEY_ID")?.trim() &&
      Deno.env.get("APNS_TEAM_ID")?.trim() &&
      Deno.env.get("APNS_AUTH_KEY_P8")?.trim(),
  );
}

export function customerLiveActivityBundleId(): string {
  return (
    Deno.env.get("APNS_CUSTOMER_BUNDLE_ID")?.trim() ||
    Deno.env.get("APNS_BUNDLE_ID")?.trim() ||
    "com.onecab.customer.app"
  );
}

function customerBundleId(): string {
  return customerLiveActivityBundleId();
}

/**
 * Prefer push-to-start for remote start; activity-specific token for update/end.
 *
 * MK-261116-015: register mirrored PTS into push_token when the activity token
 * was missing. Sending `event=update` to a push-to-start token does not update
 * an existing Live Activity — treat identical tokens as PTS-only.
 */
export function selectLiveActivityPushToken(args: {
  event: LiveActivityApnsEvent;
  pushToken?: string | null;
  pushToStartToken?: string | null;
}): string | null {
  const activity = String(args.pushToken ?? "").trim();
  const pushToStart = String(args.pushToStartToken ?? "").trim();
  const ptsOnly = Boolean(
    pushToStart && (!activity || activity === pushToStart),
  );
  const activityDistinct = ptsOnly ? "" : activity;
  if (args.event === "start") {
    return pushToStart || activityDistinct || null;
  }
  // update / end require a real activity token — never fall back to PTS.
  return activityDistinct || null;
}

/**
 * Safe credential shape check — never returns secret values / digests of values.
 * Used by service-role probe only.
 */
export type LiveActivityApnsCredentialProbe = {
  configured: boolean;
  keyIdPresent: boolean;
  keyIdShapeOk: boolean;
  teamIdPresent: boolean;
  teamIdShapeOk: boolean;
  p8Present: boolean;
  p8PemShapeOk: boolean;
  p8ImportOk: boolean;
  jwtMintOk: boolean;
  bundleId: string;
  topic: string;
  topicMatchesBundle: boolean;
  expectedBundleId: string;
};

export async function probeCustomerLiveActivityApnsCredentials(): Promise<
  LiveActivityApnsCredentialProbe
> {
  const expectedBundleId = "com.onecab.customer.app";
  const keyId = Deno.env.get("APNS_KEY_ID")?.trim() ?? "";
  const teamId = Deno.env.get("APNS_TEAM_ID")?.trim() ?? "";
  const p8Raw = Deno.env.get("APNS_AUTH_KEY_P8")?.replace(/\\n/g, "\n").trim() ??
    "";
  const bundleId = customerBundleId();
  const topic = `${bundleId}.push-type.liveactivity`;

  const keyIdShapeOk = /^[A-Z0-9]{8,12}$/i.test(keyId);
  const teamIdShapeOk = /^[A-Z0-9]{8,12}$/i.test(teamId);
  const p8PemShapeOk =
    p8Raw.includes("BEGIN PRIVATE KEY") &&
    p8Raw.includes("END PRIVATE KEY") &&
    p8Raw.replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s+/g, "").length > 80;

  let p8ImportOk = false;
  let jwtMintOk = false;
  if (keyId && teamId && p8PemShapeOk) {
    try {
      await apnsJwt();
      p8ImportOk = true;
      jwtMintOk = true;
    } catch {
      p8ImportOk = false;
      jwtMintOk = false;
    }
  }

  return {
    configured: liveActivityApnsConfigured(),
    keyIdPresent: Boolean(keyId),
    keyIdShapeOk,
    teamIdPresent: Boolean(teamId),
    teamIdShapeOk,
    p8Present: Boolean(p8Raw),
    p8PemShapeOk,
    p8ImportOk,
    jwtMintOk,
    bundleId,
    topic,
    topicMatchesBundle: topic === `${expectedBundleId}.push-type.liveactivity`,
    expectedBundleId,
  };
}

async function apnsJwt(): Promise<string> {
  const keyId = Deno.env.get("APNS_KEY_ID")!.trim();
  const teamId = Deno.env.get("APNS_TEAM_ID")!.trim();
  const p8 = Deno.env.get("APNS_AUTH_KEY_P8")!
    .replace(/\\n/g, "\n")
    .trim();

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId };
  const payload = { iss: teamId, iat: now };

  const enc = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsigned = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;

  const pem = p8
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const keyBuffer = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );
  // Convert DER → raw r||s if needed; WebCrypto ES256 returns raw 64 bytes on Deno.
  const sigB64 = enc(String.fromCharCode(...new Uint8Array(signature)));
  return `${unsigned}.${sigB64}`;
}

const APNS_PRODUCTION_HOST = "https://api.push.apple.com";
const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";

function apnsHostsForAttempt(preferred?: string | null): string[] {
  const primary =
    preferred?.trim() ||
    Deno.env.get("APNS_HOST")?.trim() ||
    APNS_PRODUCTION_HOST;
  const other = primary.includes("sandbox")
    ? APNS_PRODUCTION_HOST
    : APNS_SANDBOX_HOST;
  // Always allow one fallback host: development-signed Release IPAs use sandbox
  // tokens even when the client reports production.
  return primary === other ? [primary] : [primary, other];
}

async function postLiveActivityApns(args: {
  host: string;
  jwt: string;
  topic: string;
  pushToken: string;
  aps: Record<string, unknown>;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`${args.host}/3/device/${args.pushToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${args.jwt}`,
      "apns-topic": args.topic,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({ aps: args.aps }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export async function sendCustomerLiveActivityApns(args: {
  pushToken: string;
  event: LiveActivityApnsEvent;
  timestampSec: number;
  contentState: Record<string, unknown>;
  /** Required for event=start (push-to-start / remote start). */
  attributesType?: string;
  attributes?: Record<string, unknown>;
  dismissalDateSec?: number;
  staleDateSec?: number;
  alertTitle?: string;
  alertBody?: string;
  /** Optional token-scoped host (production / sandbox). */
  apnsHost?: string | null;
}): Promise<{ ok: boolean; status: number; body: string }> {
  if (!liveActivityApnsConfigured()) {
    return { ok: false, status: 0, body: "APNS_NOT_CONFIGURED" };
  }
  const bundleId = customerBundleId();
  const topic = `${bundleId}.push-type.liveactivity`;
  const jwt = await apnsJwt();

  const aps: Record<string, unknown> = {
    timestamp: args.timestampSec,
    event: args.event,
    "content-state": args.contentState,
  };
  if (args.event === "start") {
    aps["attributes-type"] =
      args.attributesType ?? "OneCabLiveTripAttributes";
    aps.attributes = args.attributes ?? {};
    if (args.alertTitle || args.alertBody) {
      aps.alert = {
        title: args.alertTitle ?? "ONECAB",
        body: args.alertBody ?? "Live trip tracking started",
      };
    }
  }
  if (args.event === "end" && args.dismissalDateSec != null) {
    aps["dismissal-date"] = args.dismissalDateSec;
  }
  if (args.staleDateSec != null) {
    aps["stale-date"] = args.staleDateSec;
  }

  const hosts = apnsHostsForAttempt(args.apnsHost);
  let last: { ok: boolean; status: number; body: string } = {
    ok: false,
    status: 0,
    body: "APNS_NO_HOST",
  };
  for (const host of hosts) {
    last = await postLiveActivityApns({
      host,
      jwt,
      topic,
      pushToken: args.pushToken,
      aps,
    });
    if (last.ok || last.status === 410) return last;
    // Wrong APNs environment commonly returns 400 BadDeviceToken — try fallback host.
    if (last.status === 400 && hosts.length > 1) continue;
    break;
  }
  return last;
}
