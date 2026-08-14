/** Customer-facing auth error copy — never expose raw Supabase messages. */

export const AUTH_ERROR = {
  NO_ACCOUNT_PHONE: "No account found.",
  PHONE_ALREADY_REGISTERED: "This phone number is already registered.",
  INCORRECT_CREDENTIALS: "Incorrect email or password.",
  EMAIL_NOT_VERIFIED: "Please verify your email before continuing.",
  PHONE_NOT_VERIFIED: "Please verify your phone number to continue.",
  OTP_SEND_FAILED: "We could not send the verification code.",
  OTP_INCORRECT: "The verification code is incorrect.",
  OTP_EXPIRED: "This verification code has expired. Please request a new one.",
  PASSWORD_RESET_PHONE_UNAVAILABLE:
    "Password reset by phone is not available. Please reset using your email.",
  OTP_RATE_LIMITED:
    "Too many verification codes sent. Please wait a few minutes before trying again.",
  OTP_VERIFY_RATE_LIMITED:
    "Too many attempts. Please wait a few minutes before trying again.",
} as const;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || "";
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

export type AuthErrorContext = "login" | "otp_send" | "otp_verify" | "password_reset_send";

/** Map raw Supabase/auth errors to customer-safe copy. */
export function mapAuthErrorToCustomerMessage(
  error: unknown,
  context: AuthErrorContext = "otp_send",
): string {
  const raw = errorText(error);
  const normalized = raw.toLowerCase();

  if (
    normalized.includes("signups not allowed") ||
    normalized.includes("signup is disabled") ||
    (context === "password_reset_send" &&
      (normalized.includes("user not found") ||
        normalized.includes("not found") ||
        normalized.includes("no user")))
  ) {
    return AUTH_ERROR.NO_ACCOUNT_PHONE;
  }

  if (
    normalized.includes("already been registered") ||
    normalized.includes("phone_exists") ||
    normalized.includes("phone already in use") ||
    normalized.includes("user already registered") ||
    normalized.includes("already registered")
  ) {
    return AUTH_ERROR.PHONE_ALREADY_REGISTERED;
  }

  if (
    normalized.includes("invalid login credentials") ||
    normalized.includes("invalid email or password")
  ) {
    return AUTH_ERROR.INCORRECT_CREDENTIALS;
  }

  if (
    normalized.includes("email not confirmed") ||
    normalized.includes("email not verified") ||
    normalized.includes("email_not_confirmed")
  ) {
    return AUTH_ERROR.EMAIL_NOT_VERIFIED;
  }

  if (
    normalized.includes("phone not confirmed") ||
    normalized.includes("phone not verified") ||
    normalized.includes("phone_not_confirmed")
  ) {
    return AUTH_ERROR.PHONE_NOT_VERIFIED;
  }

  if (
    normalized.includes("over_sms_send_rate_limit") ||
    normalized.includes("sms_send_rate_limit") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("429")
  ) {
    return context === "otp_verify"
      ? AUTH_ERROR.OTP_VERIFY_RATE_LIMITED
      : AUTH_ERROR.OTP_RATE_LIMITED;
  }

  if (context === "otp_verify" || context === "password_reset_send") {
    if (normalized.includes("expired")) {
      return AUTH_ERROR.OTP_EXPIRED;
    }
    if (
      normalized.includes("invalid") ||
      normalized.includes("token") ||
      normalized.includes("otp") ||
      normalized.includes("code")
    ) {
      return AUTH_ERROR.OTP_INCORRECT;
    }
  }

  if (context === "otp_send" || context === "password_reset_send") {
    return AUTH_ERROR.OTP_SEND_FAILED;
  }

  if (context === "otp_verify") {
    return AUTH_ERROR.OTP_INCORRECT;
  }

  if (context === "login") {
    return AUTH_ERROR.INCORRECT_CREDENTIALS;
  }

  return AUTH_ERROR.OTP_SEND_FAILED;
}

export type OtpErrorPhase = "send" | "verify" | "duplicate";

export type OtpErrorMapping = {
  phase: OtpErrorPhase;
  message: string;
  code?: string;
};

export function mapOtpErrorToMessage(
  error: unknown,
  phase: OtpErrorPhase,
): OtpErrorMapping {
  const raw = errorText(error);
  const normalized = raw.toLowerCase();

  if (
    normalized.includes("already been registered") ||
    normalized.includes("phone_exists") ||
    normalized.includes("phone already in use") ||
    normalized.includes("user already registered")
  ) {
    return {
      phase: "duplicate",
      code: "duplicate_phone",
      message: AUTH_ERROR.PHONE_ALREADY_REGISTERED,
    };
  }

  if (
    normalized.includes("signups not allowed") ||
    normalized.includes("signup is disabled")
  ) {
    return {
      phase,
      code: "account_not_found",
      message: AUTH_ERROR.NO_ACCOUNT_PHONE,
    };
  }

  if (
    normalized.includes("over_sms_send_rate_limit") ||
    normalized.includes("sms_send_rate_limit") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("429")
  ) {
    return {
      phase: phase === "verify" ? "verify" : "send",
      code: "rate_limited",
      message: phase === "send"
        ? AUTH_ERROR.OTP_RATE_LIMITED
        : AUTH_ERROR.OTP_VERIFY_RATE_LIMITED,
    };
  }

  if (phase === "send") {
    return {
      phase,
      code: "send_failed",
      message: AUTH_ERROR.OTP_SEND_FAILED,
    };
  }

  if (normalized.includes("expired")) {
    return {
      phase: "verify",
      code: "expired_otp",
      message: AUTH_ERROR.OTP_EXPIRED,
    };
  }

  if (
    normalized.includes("invalid") ||
    normalized.includes("token") ||
    normalized.includes("otp") ||
    normalized.includes("code")
  ) {
    return {
      phase: "verify",
      code: "invalid_otp",
      message: AUTH_ERROR.OTP_INCORRECT,
    };
  }

  return {
    phase,
    code: "unknown",
    message: phase === "verify"
      ? AUTH_ERROR.OTP_INCORRECT
      : AUTH_ERROR.OTP_SEND_FAILED,
  };
}
