/**
 * Password recovery SSOT — redirects, validation, enumeration-safe responses.
 * Pure TypeScript (no Deno/npm imports) so vitest can import via @shared.
 */

export type RecoveryApp = "driver" | "customer";

export const PASSWORD_RECOVERY_SAFE_MESSAGE =
  "If an account matches that email address, we've sent password reset instructions.";

/** Matches Driver native `DRIVER_PASSWORD_RESET_REDIRECT`. */
export const DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT = "onecab-driver://reset-password";

/** Customer native scheme + reset route. */
export const DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT =
  "onecab-customer://auth/reset-password";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRecoveryEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 320) return null;
  if (!EMAIL_RE.test(normalized)) return null;
  return normalized;
}

export function parseRecoveryApp(value: unknown): RecoveryApp | null {
  if (value === "driver" || value === "customer") return value;
  return null;
}

/**
 * Resolve redirect from approved app only — never from client-supplied URLs.
 * Optional env overrides: DRIVER_PASSWORD_RESET_REDIRECT / CUSTOMER_PASSWORD_RESET_REDIRECT.
 */
export function getRecoveryRedirect(
  app: RecoveryApp,
  env: Record<string, string | undefined> = {},
): string {
  if (app === "driver") {
    const fromEnv = env.DRIVER_PASSWORD_RESET_REDIRECT?.trim();
    return fromEnv || DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT;
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

export function extractRecoveryActionLink(linkData: unknown): string | null {
  if (!linkData || typeof linkData !== "object") return null;
  const props = (linkData as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return null;
  const actionLink = (props as { action_link?: unknown }).action_link;
  if (typeof actionLink !== "string" || !actionLink.startsWith("http")) return null;
  return actionLink;
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
