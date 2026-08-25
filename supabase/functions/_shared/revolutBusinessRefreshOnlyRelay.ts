/**
 * Minimal HMAC client for Revolut Business OAuth token exchange only.
 * No /pay, counterparty, or payout payment paths.
 */
function hexFromBuffer(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return hexFromBuffer(digest);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hexFromBuffer(sig);
}

function relayBaseFromEnv(): string {
  const enabled = (Deno.env.get("REVOLUT_BUSINESS_RELAY_ENABLED") ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0" || enabled === "off") return "";
  return (
    Deno.env.get("REVOLUT_BUSINESS_RELAY_URL") ??
    Deno.env.get("REVOLUT_BUSINESS_RELAY_BASE_URL") ??
    ""
  ).trim().replace(/\/$/, "");
}

export function isRefreshOnlyRelayConfigured(): boolean {
  const base = relayBaseFromEnv();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  return Boolean(base && secret.length >= 32);
}

async function signedHeaders(args: {
  method: string;
  path: string;
  body: string;
  secret: string;
}): Promise<Record<string, string>> {
  const ts = String(Date.now());
  const nonce = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const bodyHash = await sha256Hex(args.body);
  const message = `${args.method}\n${args.path}\n${ts}\n${nonce}\n${bodyHash}`;
  const signature = await hmacHex(args.secret, message);
  return {
    "x-onecab-timestamp": ts,
    "x-onecab-nonce": nonce,
    "x-onecab-signature": signature,
    "x-onecab-client-id": "supabase-edge",
  };
}

export async function relayRefreshOnlyTokenExchange(formBody: string): Promise<Response> {
  const base = relayBaseFromEnv();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) throw new Error("revolut_business_relay_not_configured");
  const path = "/v1/revolut/auth/token";
  const headers = await signedHeaders({ method: "POST", path, body: formBody, secret });
  headers["Content-Type"] = "application/x-www-form-urlencoded";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: formBody,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
