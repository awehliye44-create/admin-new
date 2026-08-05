/**
 * Driver push-token validation + invalid-token helpers.
 * Tokens must be FCM registration tokens (Android + iOS via FCM).
 * Never log the full token — use tokenFingerprint only.
 */

export type DriverPushPlatform = "ios" | "android";

export function tokenFingerprint(token: string): string {
  const t = token.trim();
  if (t.length <= 16) return "***";
  return `${t.slice(0, 8)}…${t.slice(-6)}`;
}

export function isApnsDeviceToken(token: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(token.trim());
}

export function isExpoPushToken(token: string): boolean {
  const t = token.trim();
  return (
    t.startsWith("ExponentPushToken[") ||
    t.startsWith("ExpoPushToken[")
  );
}

/**
 * Accept FCM registration tokens only — matches send-driver-notification.
 */
export function isFcmRegistrationToken(
  token: string,
  platform: DriverPushPlatform,
): boolean {
  const t = token.trim();
  if (!t || isApnsDeviceToken(t) || isExpoPushToken(t)) return false;
  if (t.includes(":") && t.length >= 80) return true;
  if (platform === "ios" && t.length >= 80) return true;
  if (platform === "android" && t.length >= 100) return true;
  return false;
}

export function parseDriverPushPlatform(
  value: unknown,
): DriverPushPlatform | null {
  if (typeof value !== "string") return null;
  const p = value.trim().toLowerCase();
  if (p === "ios" || p === "android") return p;
  return null;
}

/** Provider / FCM error signals that mean the token must stop receiving. */
export function isInvalidProviderTokenError(input: {
  errCode?: string | number | null;
  errMessage?: string | null;
  httpStatus?: number | null;
}): boolean {
  const code = String(input.errCode ?? "").toUpperCase();
  const message = String(input.errMessage ?? "").toLowerCase();
  const status = input.httpStatus ?? 0;

  if (
    code === "UNREGISTERED" ||
    code === "NOT_FOUND" ||
    code === "INVALID_ARGUMENT" ||
    code === "TOKEN_INVALID" ||
    code === "MESSAGING/INVALID-REGISTRATION-TOKEN" ||
    code === "MESSAGING/REGISTRATION-TOKEN-NOT-REGISTERED"
  ) {
    return true;
  }

  if (status === 404) return true;

  if (
    message.includes("not a valid fcm registration token") ||
    message.includes("requested entity was not found") ||
    message.includes("unregistered") ||
    message.includes("bad device token") ||
    message.includes("baddevicetoken") ||
    message.includes("invalid registration") ||
    message.includes("not registered") ||
    message.includes("token mismatch")
  ) {
    return true;
  }

  return false;
}

export function buildTokenDeactivatePatch(reason: string): {
  is_active: false;
  last_failure_at: string;
  last_failure_reason: string;
  updated_at: string;
} {
  const now = new Date().toISOString();
  return {
    is_active: false,
    last_failure_at: now,
    last_failure_reason: reason.slice(0, 200),
    updated_at: now,
  };
}
