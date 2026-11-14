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

function customerBundleId(): string {
  return (
    Deno.env.get("APNS_CUSTOMER_BUNDLE_ID")?.trim() ||
    Deno.env.get("APNS_BUNDLE_ID")?.trim() ||
    "com.onecab.customer.app"
  );
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
}): Promise<{ ok: boolean; status: number; body: string }> {
  if (!liveActivityApnsConfigured()) {
    return { ok: false, status: 0, body: "APNS_NOT_CONFIGURED" };
  }
  const bundleId = customerBundleId();
  const topic = `${bundleId}.push-type.liveactivity`;
  const host =
    Deno.env.get("APNS_HOST")?.trim() ||
    "https://api.push.apple.com";
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

  const res = await fetch(`${host}/3/device/${args.pushToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({ aps }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}
