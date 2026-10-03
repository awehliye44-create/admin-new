/**
 * HTTPS hand-off for Driver / Customer password-reset emails.
 *
 * Gmail (and most webmail) strips hrefs that are not http(s), so a native
 * `onecab-customer://` / `onecab-driver://` link in an email renders as a dead
 * button. The email therefore links to the `password-recovery-link` edge bridge,
 * which redirects into the installed app (custom scheme on iOS, intent:// on
 * Android where Chrome / Gmail Custom Tabs block custom-scheme redirects).
 *
 * The recovery session travels sealed (AES-GCM, bound to the app) with a short
 * expiry, so the email never carries a readable access or refresh token.
 * Opening the link does not consume anything, so mail scanners that prefetch
 * links cannot burn it before the user taps.
 *
 * Pure TypeScript (Web Crypto only) — no Deno/npm imports.
 */

import {
  CUSTOMER_ANDROID_PACKAGE,
  CUSTOMER_APP_URL_SCHEME,
  DRIVER_ANDROID_PACKAGE,
  DRIVER_APP_URL_SCHEME,
  isAndroidUserAgent,
} from "./accountEmailVerification.ts";
import { buildNativeRecoveryDeepLinkFromSession } from "./passwordRecoverySSOT.ts";

export type NativeRecoveryApp = "driver" | "customer";

export const PASSWORD_RECOVERY_BRIDGE_FUNCTION = "password-recovery-link";
export const PASSWORD_RECOVERY_HANDOFF_TTL_SECONDS = 60 * 60;

export type RecoveryHandoffSession = {
  accessToken: string;
  refreshToken: string;
  tokenType?: string;
  expiresAt?: number;
};

export type RecoveryHandoffOpenResult =
  | { ok: true; session: RecoveryHandoffSession }
  | { ok: false; reason: "invalid" | "expired" };

type SealedPayload = {
  v: 1;
  app: NativeRecoveryApp;
  at: string;
  rt: string;
  tt?: string;
  ea?: number;
  exp: number;
};

const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const enc = new TextEncoder();

export function parseNativeRecoveryApp(value: unknown): NativeRecoveryApp | null {
  return value === "driver" || value === "customer" ? value : null;
}

/** Server-only key material. A dedicated secret wins when configured. */
export function recoveryHandoffSecret(env: {
  PASSWORD_RECOVERY_HANDOFF_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}): string {
  return env.PASSWORD_RECOVERY_HANDOFF_SECRET?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("onecab-password-recovery"),
      info: enc.encode("onecab:password-recovery-handoff:v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesFromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function sealRecoveryHandoff(args: {
  app: NativeRecoveryApp;
  session: RecoveryHandoffSession;
  secret: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const accessToken = args.session.accessToken.trim();
  const refreshToken = args.session.refreshToken.trim();
  if (!args.secret) throw new Error("password recovery handoff secret missing");
  if (!accessToken || !refreshToken) throw new Error("password recovery session incomplete");

  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: SealedPayload = {
    v: 1,
    app: args.app,
    at: accessToken,
    rt: refreshToken,
    exp: now + Math.max(60, args.ttlSeconds ?? PASSWORD_RECOVERY_HANDOFF_TTL_SECONDS),
  };
  const tokenType = args.session.tokenType?.trim();
  if (tokenType) payload.tt = tokenType;
  if (typeof args.session.expiresAt === "number" && Number.isFinite(args.session.expiresAt)) {
    payload.ea = Math.floor(args.session.expiresAt);
  }

  const key = await deriveKey(args.secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(args.app) },
      key,
      enc.encode(JSON.stringify(payload)),
    ),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return base64UrlFromBytes(out);
}

export async function openRecoveryHandoff(args: {
  token: string;
  app: NativeRecoveryApp;
  secret: string;
  nowSeconds?: number;
}): Promise<RecoveryHandoffOpenResult> {
  if (!args.secret) return { ok: false, reason: "invalid" };
  const raw = bytesFromBase64Url(args.token.trim());
  if (!raw || raw.length <= IV_BYTES + GCM_TAG_BYTES) return { ok: false, reason: "invalid" };

  let payload: SealedPayload;
  try {
    const key = await deriveKey(args.secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, IV_BYTES), additionalData: enc.encode(args.app) },
      key,
      raw.slice(IV_BYTES),
    );
    payload = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (
    payload?.v !== 1 ||
    payload.app !== args.app ||
    typeof payload.at !== "string" || !payload.at ||
    typeof payload.rt !== "string" || !payload.rt ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "invalid" };
  }
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return { ok: false, reason: "expired" };

  return {
    ok: true,
    session: {
      accessToken: payload.at,
      refreshToken: payload.rt,
      tokenType: payload.tt,
      expiresAt: payload.ea,
    },
  };
}

/** HTTPS link placed in the email. */
export function passwordRecoveryBridgeUrl(
  supabaseUrl: string,
  app: NativeRecoveryApp,
  handoff: string,
): string {
  const base = supabaseUrl.trim().replace(/\/+$/, "");
  return `${base}/functions/v1/${PASSWORD_RECOVERY_BRIDGE_FUNCTION}?app=${app}&h=${
    encodeURIComponent(handoff)
  }`;
}

function nativeScheme(app: NativeRecoveryApp): string {
  return app === "driver" ? DRIVER_APP_URL_SCHEME : CUSTOMER_APP_URL_SCHEME;
}

function nativePackage(app: NativeRecoveryApp): string {
  return app === "driver" ? DRIVER_ANDROID_PACKAGE : CUSTOMER_ANDROID_PACKAGE;
}

function recoveryParams(session: RecoveryHandoffSession | null): URLSearchParams {
  const params = new URLSearchParams();
  if (session) {
    params.set("access_token", session.accessToken);
    params.set("refresh_token", session.refreshToken);
    params.set("token_type", session.tokenType?.trim() || "bearer");
    if (typeof session.expiresAt === "number") params.set("expires_at", String(session.expiresAt));
  } else {
    params.set("error", "access_denied");
    params.set("error_code", "otp_expired");
    params.set("error_description", "Email link is invalid or has expired");
  }
  params.set("type", "recovery");
  return params;
}

/**
 * Redirect target for the bridge. Never taken from the request URL — the app
 * route comes from the server-side recovery redirect for that app.
 */
export function passwordRecoveryHandoffLocation(args: {
  app: NativeRecoveryApp;
  nativeRedirect: string;
  session: RecoveryHandoffSession | null;
  userAgent?: string | null;
}): string {
  const scheme = nativeScheme(args.app);
  const base = args.nativeRedirect.trim().replace(/[?#].*$/, "");
  const prefix = `${scheme}://`;
  if (!base.toLowerCase().startsWith(prefix)) {
    throw new Error(`native recovery redirect must use ${prefix}`);
  }
  const route = base.slice(prefix.length);
  const params = recoveryParams(args.session);

  if (isAndroidUserAgent(args.userAgent)) {
    return `intent://${route}?${params.toString()}#Intent;scheme=${scheme};package=${
      nativePackage(args.app)
    };end`;
  }

  if (args.session) {
    const deepLink = buildNativeRecoveryDeepLinkFromSession({
      nativeRedirect: base,
      accessToken: args.session.accessToken,
      refreshToken: args.session.refreshToken,
      tokenType: args.session.tokenType,
      expiresAt: args.session.expiresAt,
    });
    if (deepLink) return deepLink;
  }
  return `${base}#${params.toString()}`;
}
