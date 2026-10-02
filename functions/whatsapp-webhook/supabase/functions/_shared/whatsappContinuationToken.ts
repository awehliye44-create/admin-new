/**
 * Signed WhatsApp web continuation tokens (book / track links).
 * Verified server-side only — never embed secrets in onecab.net frontend.
 */

export type WhatsAppContinuationPurpose = "book" | "track";

export type WhatsAppContinuationClaims = {
  purpose: WhatsAppContinuationPurpose;
  waId: string;
  tripId: string | null;
  exp: number;
};

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

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function canonicalPayload(claims: WhatsAppContinuationClaims): string {
  const trip = claims.tripId ?? "";
  return `${claims.purpose}:${claims.waId}:${trip}:${claims.exp}`;
}

export function buildWhatsAppContinuationSigningMaterial(input: {
  verifyToken: string;
  phoneNumberId: string;
}): string {
  return `${input.verifyToken}:${input.phoneNumberId}`;
}

export async function createWhatsAppContinuationToken(
  claims: Omit<WhatsAppContinuationClaims, "exp"> & { ttlSeconds?: number },
  signingMaterial: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const exp = nowSeconds + Math.max(60, claims.ttlSeconds ?? 3600);
  const fullClaims: WhatsAppContinuationClaims = {
    purpose: claims.purpose,
    waId: claims.waId,
    tripId: claims.tripId ?? null,
    exp,
  };
  const payload = canonicalPayload(fullClaims);
  const sig = await hmacSha256Hex(signingMaterial, payload);
  return `${base64UrlEncode(payload)}.${sig}`;
}

export async function verifyWhatsAppContinuationToken(
  token: string,
  signingMaterial: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<WhatsAppContinuationClaims | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1).toLowerCase();
  const decoded = base64UrlDecode(encoded);
  if (!decoded) return null;

  const expectedSig = await hmacSha256Hex(signingMaterial, decoded);
  if (!timingSafeEqualHex(sig, expectedSig)) return null;

  const parts = decoded.split(":");
  if (parts.length !== 4) return null;
  const [purpose, waId, tripIdRaw, expRaw] = parts;
  if (purpose !== "book" && purpose !== "track") return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= nowSeconds) return null;
  if (!waId.trim()) return null;

  return {
    purpose,
    waId,
    tripId: tripIdRaw ? tripIdRaw : null,
    exp,
  };
}

export function buildWhatsAppContinuationUrl(
  publicOrigin: string,
  purpose: WhatsAppContinuationPurpose,
  token: string,
): string {
  const base = publicOrigin.replace(/\/+$/, "");
  const path = purpose === "book" ? "/whatsapp-booking" : "/whatsapp-track";
  return `${base}${path}?wa=${encodeURIComponent(token)}`;
}
