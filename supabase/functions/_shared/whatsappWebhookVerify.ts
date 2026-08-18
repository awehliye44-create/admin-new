/**
 * Meta WhatsApp webhook verification (GET hub challenge + POST X-Hub-Signature-256).
 * App Secret is required for POST signature checks — store as WHATSAPP_APP_SECRET.
 */

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function hexFromBytes(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return hexFromBytes(sig);
}

export type WhatsAppHubVerifyQuery = {
  mode: string | null;
  verifyToken: string | null;
  challenge: string | null;
};

export function readWhatsAppHubVerifyQuery(url: URL): WhatsAppHubVerifyQuery {
  return {
    mode: url.searchParams.get("hub.mode"),
    verifyToken: url.searchParams.get("hub.verify_token"),
    challenge: url.searchParams.get("hub.challenge"),
  };
}

/** Meta webhook subscription verification (GET). */
export function verifyWhatsAppHubChallenge(
  query: WhatsAppHubVerifyQuery,
  expectedVerifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  if (query.mode !== "subscribe") return { ok: false };
  if (!query.verifyToken || !query.challenge) return { ok: false };
  if (query.verifyToken !== expectedVerifyToken) return { ok: false };
  return { ok: true, challenge: query.challenge };
}

/** Meta X-Hub-Signature-256: sha256=<hex-hmac of raw body with App Secret>. */
export async function verifyWhatsAppWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.trim() || !appSecret.trim()) return false;
  const provided = signatureHeader
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("sha256="))
    .map((part) => part.slice("sha256=".length).toLowerCase());
  if (provided.length === 0) return false;
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return provided.some((candidate) => timingSafeEqualHex(candidate, expected));
}
