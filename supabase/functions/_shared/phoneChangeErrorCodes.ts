/** Structured phone-change send errors — edge + client must stay aligned. */

export const PHONE_CHANGE_ERROR = {
  PHONE_ALREADY_IN_USE: "PHONE_ALREADY_IN_USE",
  INVALID_PHONE_FORMAT: "INVALID_PHONE_FORMAT",
  OTP_SEND_FAILED: "OTP_SEND_FAILED",
  AUTH_PHONE_UPDATE_FAILED: "AUTH_PHONE_UPDATE_FAILED",
  PENDING_PHONE_CONFLICT: "PENDING_PHONE_CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  CURRENT_PHONE_MISMATCH: "CURRENT_PHONE_MISMATCH",
  PHONE_UNCHANGED: "PHONE_UNCHANGED",
  PHONE_REQUIRED: "PHONE_REQUIRED",
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_SESSION: "INVALID_SESSION",
} as const;

export type PhoneChangeErrorCode =
  typeof PHONE_CHANGE_ERROR[keyof typeof PHONE_CHANGE_ERROR];

export const PHONE_CHANGE_ERROR_MESSAGES: Record<PhoneChangeErrorCode, string> = {
  PHONE_ALREADY_IN_USE: "This phone number is already registered.",
  INVALID_PHONE_FORMAT: "Enter a valid UK phone number.",
  OTP_SEND_FAILED: "We couldn't send the verification code. Please try again.",
  AUTH_PHONE_UPDATE_FAILED: "We couldn't start phone verification. Please try again.",
  PENDING_PHONE_CONFLICT:
    "You already have a pending phone change. Please verify or cancel it first.",
  RATE_LIMITED: "Too many attempts. Please wait before trying again.",
  CURRENT_PHONE_MISMATCH: "Your account phone needs refreshing. Please sign in again.",
  PHONE_UNCHANGED: "This is already your current phone number.",
  PHONE_REQUIRED: "New phone number is required.",
  UNAUTHORIZED: "Please sign in again.",
  INVALID_SESSION: "Your session expired. Please sign in again.",
};

export const PHONE_CHANGE_OTP_SENT_MESSAGE =
  "We sent a verification code to your new phone number.";

export function phoneChangeErrorBody(
  code: string,
  message: string,
): { ok: false; code: string; message: string; error: string } {
  return { ok: false, code, message, error: message };
}

export function phoneChangeSuccessBody(phone: string): {
  ok: true;
  phone: string;
  message: string;
} {
  return {
    ok: true,
    phone,
    message: PHONE_CHANGE_OTP_SENT_MESSAGE,
  };
}

export function resolvePhoneChangeErrorMessage(
  code: string | null | undefined,
  message: string | null | undefined,
): string {
  if (message?.trim()) return message.trim();
  if (code && code in PHONE_CHANGE_ERROR_MESSAGES) {
    return PHONE_CHANGE_ERROR_MESSAGES[code as PhoneChangeErrorCode];
  }
  return PHONE_CHANGE_ERROR_MESSAGES.OTP_SEND_FAILED;
}
