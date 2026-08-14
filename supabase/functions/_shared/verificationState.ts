import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  evaluateCustomerOnboardingLogin,
  evaluateDriverOnboardingLogin,
  isAccountEmailVerified,
  type OnboardingAppType,
  ONBOARDING_LOGIN_BLOCK,
  type OnboardingLoginBlockCode,
} from "./onboardingLoginGuard.ts";
import { normalizeOnboardingPhone } from "./onboardingValidation.ts";

export const VERIFICATION_BLOCKED_REASON = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  EMAIL_UNVERIFIED: "EMAIL_UNVERIFIED",
  PHONE_UNVERIFIED: "PHONE_UNVERIFIED",
  ONBOARDING_INCOMPLETE: "ONBOARDING_INCOMPLETE",
  ACCOUNT_INACTIVE: "ACCOUNT_INACTIVE",
} as const;

export type VerificationBlockedReason =
  typeof VERIFICATION_BLOCKED_REASON[keyof typeof VERIFICATION_BLOCKED_REASON];

export type VerificationStateResult = {
  email_verified: boolean;
  phone_verified: boolean;
  email_required: boolean;
  phone_required: boolean;
  blocked_reasons: VerificationBlockedReason[];
  message: string;
};

export type OtpErrorPhase = "send" | "verify" | "duplicate";

export type OtpErrorMapping = {
  phase: OtpErrorPhase;
  message: string;
  code?: string;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || "";
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

export function normalizePhoneNumber(raw: string): string {
  return normalizeOnboardingPhone(raw);
}

export function blockCodeToVerificationReasons(
  blockCode: OnboardingLoginBlockCode | null,
): VerificationBlockedReason[] {
  switch (blockCode) {
    case ONBOARDING_LOGIN_BLOCK.EMAIL_NOT_VERIFIED:
      return [VERIFICATION_BLOCKED_REASON.EMAIL_UNVERIFIED];
    case ONBOARDING_LOGIN_BLOCK.PHONE_NOT_VERIFIED:
      return [VERIFICATION_BLOCKED_REASON.PHONE_UNVERIFIED];
    case ONBOARDING_LOGIN_BLOCK.NO_PROFILE:
      return [VERIFICATION_BLOCKED_REASON.ONBOARDING_INCOMPLETE];
    case ONBOARDING_LOGIN_BLOCK.ACCOUNT_NOT_ACTIVE:
      return [VERIFICATION_BLOCKED_REASON.ACCOUNT_INACTIVE];
    default:
      return [];
  }
}

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
      message: "This phone number is already linked to another account. Please use a different number.",
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
        ? "Too many verification codes sent. Please wait a few minutes before trying again."
        : "Too many attempts. Please wait a few minutes before trying again.",
    };
  }

  if (phase === "send") {
    return {
      phase,
      code: "send_failed",
      message: raw || "Failed to send verification code. Please try again.",
    };
  }

  if (normalized.includes("expired")) {
    return {
      phase: "verify",
      code: "expired_otp",
      message: "Code expired. Please request a new one.",
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
      message: "Invalid verification code. Please check the code and try again.",
    };
  }

  return {
    phase,
    code: "unknown",
    message: raw || (phase === "verify"
      ? "Verification failed. Please try again."
      : "Failed to send verification code. Please try again."),
  };
}

export async function getVerificationState(
  service: SupabaseClient,
  userId: string | null | undefined,
  appType: OnboardingAppType,
): Promise<VerificationStateResult> {
  if (!userId) {
    return {
      email_verified: false,
      phone_verified: false,
      email_required: true,
      phone_required: true,
      blocked_reasons: [VERIFICATION_BLOCKED_REASON.AUTH_REQUIRED],
      message: "Sign in required.",
    };
  }

  const guard = appType === "driver"
    ? await evaluateDriverOnboardingLogin(service, userId)
    : await evaluateCustomerOnboardingLogin(service, userId);

  const { data: authLookup } = await service.auth.admin.getUserById(userId);
  const authUser = authLookup?.user;
  const emailVerified = authUser
    ? await isAccountEmailVerified(
      service,
      userId,
      appType,
      authUser.email_confirmed_at,
    )
    : guard.email_verified;
  const phoneVerified = !!authUser?.phone_confirmed_at || guard.phone_verified;

  const blocked_reasons = blockCodeToVerificationReasons(guard.block_code);
  if (!emailVerified && !blocked_reasons.includes(VERIFICATION_BLOCKED_REASON.EMAIL_UNVERIFIED)) {
    blocked_reasons.unshift(VERIFICATION_BLOCKED_REASON.EMAIL_UNVERIFIED);
  }
  if (!phoneVerified && !blocked_reasons.includes(VERIFICATION_BLOCKED_REASON.PHONE_UNVERIFIED)) {
    blocked_reasons.push(VERIFICATION_BLOCKED_REASON.PHONE_UNVERIFIED);
  }

  const message = guard.message
    ?? (!emailVerified
      ? "Please verify your email address before continuing."
      : !phoneVerified
      ? "Please verify your phone number before continuing."
      : "");

  return {
    email_verified: emailVerified,
    phone_verified: phoneVerified,
    email_required: true,
    phone_required: true,
    blocked_reasons: guard.app_access_allowed ? [] : blocked_reasons,
    message,
  };
}

export function requireEmailVerified(
  state: VerificationStateResult,
): { ok: true } | { ok: false; state: VerificationStateResult } {
  if (state.email_verified) return { ok: true };
  return {
    ok: false,
    state: {
      ...state,
      blocked_reasons: [VERIFICATION_BLOCKED_REASON.EMAIL_UNVERIFIED],
      message: state.message || "Please verify your email address before continuing.",
    },
  };
}

export function requirePhoneVerified(
  state: VerificationStateResult,
): { ok: true } | { ok: false; state: VerificationStateResult } {
  if (state.phone_verified) return { ok: true };
  return {
    ok: false,
    state: {
      ...state,
      blocked_reasons: [VERIFICATION_BLOCKED_REASON.PHONE_UNVERIFIED],
      message: state.message || "Please verify your phone number before continuing.",
    },
  };
}

/** Re-fetch auth user + profile verification flags (post OTP / email link). */
export async function refreshVerificationState(
  service: SupabaseClient,
  userId: string,
  appType: OnboardingAppType,
): Promise<VerificationStateResult> {
  return getVerificationState(service, userId, appType);
}
