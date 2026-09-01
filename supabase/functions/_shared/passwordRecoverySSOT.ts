/**
 * Password recovery SSOT — redirects, validation, enumeration-safe responses.
 * Pure TypeScript (no Deno/npm imports) so vitest can import via @shared.
 */

export type RecoveryApp = "driver" | "customer" | "corporate";

export const PASSWORD_RECOVERY_SAFE_MESSAGE =
  "If an account matches that email address, we've sent password reset instructions.";

/** Matches Driver native `DRIVER_PASSWORD_RESET_REDIRECT`. */
export const DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT = "onecab-driver://reset-password";

/** Customer native scheme + reset route. */
export const DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT =
  "onecab-customer://auth/reset-password";

/** Corporate web portal reset route (co.onecab.net). */
export const DEFAULT_CORPORATE_PASSWORD_RESET_REDIRECT =
  "https://co.onecab.net/reset-password";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRecoveryEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 320) return null;
  if (!EMAIL_RE.test(normalized)) return null;
  return normalized;
}

export function parseRecoveryApp(value: unknown): RecoveryApp | null {
  if (value === "driver" || value === "customer" || value === "corporate") return value;
  return null;
}

/**
 * Resolve redirect from approved app only — never from client-supplied URLs.
 * Optional env overrides:
 * DRIVER_PASSWORD_RESET_REDIRECT / CUSTOMER_PASSWORD_RESET_REDIRECT /
 * CORPORATE_PASSWORD_RESET_REDIRECT.
 */
export function getRecoveryRedirect(
  app: RecoveryApp,
  env: Record<string, string | undefined> = {},
): string {
  if (app === "driver") {
    const fromEnv = env.DRIVER_PASSWORD_RESET_REDIRECT?.trim();
    return fromEnv || DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT;
  }
  if (app === "corporate") {
    const fromEnv = env.CORPORATE_PASSWORD_RESET_REDIRECT?.trim();
    return fromEnv || DEFAULT_CORPORATE_PASSWORD_RESET_REDIRECT;
  }
  const fromEnv = env.CUSTOMER_PASSWORD_RESET_REDIRECT?.trim();
  return fromEnv || DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT;
}

/** Reject bodies that try to pass arbitrary redirects. */
export function hasDisallowedClientRedirect(body: Record<string, unknown>): boolean {
  const keys = [
    "redirectTo",
    "redirect_to",
    "redirectUrl",
    "redirect_url",
    "recoveryRedirect",
    "callback",
    "callbackUrl",
  ];
  return keys.some((k) => body[k] != null && String(body[k]).trim() !== "");
}

export function passwordRecoverySafeResponse(): {
  ok: true;
  message: string;
} {
  return { ok: true, message: PASSWORD_RECOVERY_SAFE_MESSAGE };
}

/** Stable non-secret key material for rate limiting (not for storage of PII). */
export function emailRateLimitFingerprint(email: string): string {
  let hash = 2166136261;
  for (let i = 0; i < email.length; i++) {
    hash ^= email.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `em_${(hash >>> 0).toString(16)}`;
}

function readStringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Admin generateLink shapes vary by GoTrue / supabase-js version:
 * - raw GoTrue: top-level `action_link` + `hashed_token`
 * - supabase-js: nested under `properties`
 */
export function extractRecoveryActionLink(linkData: unknown): string | null {
  if (!linkData || typeof linkData !== "object") return null;
  const root = linkData as Record<string, unknown>;
  const top = readStringField(root, "action_link");
  if (top?.startsWith("http")) return top;

  const props = root.properties;
  if (props && typeof props === "object") {
    const nested = readStringField(props as Record<string, unknown>, "action_link");
    if (nested?.startsWith("http")) return nested;
  }
  return null;
}

/** Token hash for SPA `verifyOtp({ type: 'recovery', token_hash })`. */
export function extractRecoveryTokenHash(linkData: unknown): string | null {
  if (!linkData || typeof linkData !== "object") return null;
  const root = linkData as Record<string, unknown>;
  const top = readStringField(root, "hashed_token");
  if (top) return top;
  const props = root.properties;
  if (props && typeof props === "object") {
    return readStringField(props as Record<string, unknown>, "hashed_token");
  }
  return null;
}

/**
 * Corporate web must not rely on Auth Site URL (often localhost).
 *
 * Prefer embedding a short-lived recovery *session* in the URL hash so the
 * currently published Corporate SPA (which shows the form on `type=recovery`
 * but does not call verifyOtp) can pick up the session via detectSessionInUrl
 * and successfully call updateUser.
 */
export function buildCorporateRecoveryPageUrlFromSession(args: {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  expiresAt?: number;
  tokenType?: string;
  portalResetUrl?: string;
}): string | null {
  const accessToken = args.accessToken.trim();
  const refreshToken = args.refreshToken.trim();
  if (!accessToken || !refreshToken) return null;

  const base = (args.portalResetUrl ?? DEFAULT_CORPORATE_PASSWORD_RESET_REDIRECT)
    .trim()
    .replace(/\/$/, "");
  if (!base.startsWith("https://")) return null;

  const url = new URL(base);
  const params = new URLSearchParams();
  params.set("access_token", accessToken);
  params.set("refresh_token", refreshToken);
  params.set("token_type", (args.tokenType ?? "bearer").trim() || "bearer");
  params.set("type", "recovery");
  if (typeof args.expiresIn === "number" && Number.isFinite(args.expiresIn)) {
    params.set("expires_in", String(Math.floor(args.expiresIn)));
  }
  if (typeof args.expiresAt === "number" && Number.isFinite(args.expiresAt)) {
    params.set("expires_at", String(Math.floor(args.expiresAt)));
  }
  url.hash = params.toString();
  return url.toString();
}

/**
 * Native Driver / Customer deep link with recovery session in the URL hash.
 * Avoids the mobile browser → Supabase verify → redirect chain that can drop tokens
 * or consume the one-time recovery OTP before the app calls setSession.
 */
export function buildNativeRecoveryDeepLinkFromSession(args: {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  expiresAt?: number;
  tokenType?: string;
  nativeRedirect: string;
}): string | null {
  const accessToken = args.accessToken.trim();
  const refreshToken = args.refreshToken.trim();
  if (!accessToken || !refreshToken) return null;

  const base = args.nativeRedirect.trim().replace(/#.*$/, "");
  if (!/^onecab-(driver|customer):\/\//i.test(base)) return null;

  const params = new URLSearchParams();
  params.set("access_token", accessToken);
  params.set("refresh_token", refreshToken);
  params.set("token_type", (args.tokenType ?? "bearer").trim() || "bearer");
  params.set("type", "recovery");
  if (typeof args.expiresIn === "number" && Number.isFinite(args.expiresIn)) {
    params.set("expires_in", String(Math.floor(args.expiresIn)));
  }
  if (typeof args.expiresAt === "number" && Number.isFinite(args.expiresAt)) {
    params.set("expires_at", String(Math.floor(args.expiresAt)));
  }
  return `${base}#${params.toString()}`;
}

/** Password-reset emails may use https action links or native app deep links. */
export function isAllowedPasswordResetRecoveryUrl(url: string): boolean {
  const trimmed = url.trim();
  return (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    /^onecab-(driver|customer):\/\//i.test(trimmed)
  );
}

/**
 * Fallback for newer Corporate builds that call verifyOtp(token_hash).
 * Prefer buildCorporateRecoveryPageUrlFromSession for live compatibility.
 */
export function buildCorporateRecoveryPageUrl(
  linkData: unknown,
  portalResetUrl: string = DEFAULT_CORPORATE_PASSWORD_RESET_REDIRECT,
): string | null {
  const tokenHash = extractRecoveryTokenHash(linkData);
  if (!tokenHash) return null;
  const base = portalResetUrl.trim().replace(/\/$/, "");
  if (!base.startsWith("https://")) return null;
  const url = new URL(base);
  url.searchParams.set("token_hash", tokenHash);
  url.searchParams.set("type", "recovery");
  return url.toString();
}

/** True when Admin generateLink failed because the user is missing / ineligible. */
export function isUnknownAccountGenerateLinkError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("user not found") ||
    m.includes("unable to find user") ||
    m.includes("email not found") ||
    m.includes("user does not exist")
  );
}
