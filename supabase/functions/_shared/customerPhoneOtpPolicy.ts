import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { isAccountEmailVerified } from "./onboardingLoginGuard.ts";
import {
  isValidOnboardingPhone,
  normalizeOnboardingPhone,
} from "./onboardingValidation.ts";
import { assertOtpPhoneCountryAllowed } from "./otpPhoneCountryPolicy.ts";

export type CustomerPhoneOtpPurpose = "signup" | "change";

export const CUSTOMER_PHONE_OTP_BLOCK = {
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  ACCOUNT_NOT_ELIGIBLE: "ACCOUNT_NOT_ELIGIBLE",
  PHONE_INVALID: "PHONE_INVALID",
  PHONE_REQUIRED: "PHONE_REQUIRED",
  PHONE_UNCHANGED: "PHONE_UNCHANGED",
  NO_PROFILE: "NO_PROFILE",
  OTP_COUNTRY_UNKNOWN: "OTP_COUNTRY_UNKNOWN",
  OTP_COUNTRY_NOT_ALLOWED: "OTP_COUNTRY_NOT_ALLOWED",
} as const;

export type CustomerPhoneOtpBlockCode =
  typeof CUSTOMER_PHONE_OTP_BLOCK[keyof typeof CUSTOMER_PHONE_OTP_BLOCK];

export type CustomerPhoneOtpGuardResult =
  | { ok: true; normalizedPhone: string }
  | { ok: false; code: CustomerPhoneOtpBlockCode; message: string; httpStatus: number };

const ELIGIBLE_CHANGE_STATUSES = new Set(["active", "pending_verification"]);

/**
 * Server gate for customer phone OTP send/verify.
 * Invariant: email must be verified before any phone OTP action.
 */
export async function assertCustomerPhoneOtpAllowed(
  service: SupabaseClient,
  userId: string,
  purpose: CustomerPhoneOtpPurpose,
  phoneRaw: string,
): Promise<CustomerPhoneOtpGuardResult> {
  const normalizedPhone = normalizeOnboardingPhone(phoneRaw);
  if (!isValidOnboardingPhone(normalizedPhone)) {
    return {
      ok: false,
      code: CUSTOMER_PHONE_OTP_BLOCK.PHONE_INVALID,
      message: "Please enter a valid phone number.",
      httpStatus: 400,
    };
  }

  const countryGuard = await assertOtpPhoneCountryAllowed(service, normalizedPhone);
  if (!countryGuard.ok) {
    return {
      ok: false,
      code: countryGuard.code,
      message: countryGuard.message,
      httpStatus: countryGuard.httpStatus,
    };
  }

  const { data: authLookup } = await service.auth.admin.getUserById(userId);
  const authUser = authLookup?.user;
  if (!authUser) {
    return {
      ok: false,
      code: CUSTOMER_PHONE_OTP_BLOCK.ACCOUNT_NOT_ELIGIBLE,
      message: "Session is invalid. Please sign in again.",
      httpStatus: 401,
    };
  }

  const emailVerified = await isAccountEmailVerified(
    service,
    userId,
    "customer",
    authUser.email_confirmed_at,
  );

  if (!emailVerified) {
    return {
      ok: false,
      code: CUSTOMER_PHONE_OTP_BLOCK.EMAIL_NOT_VERIFIED,
      message: "Verify your email before requesting a phone verification code.",
      httpStatus: 403,
    };
  }

  if (purpose === "signup") {
    const { data: pending } = await service
      .from("pending_customer_signups")
      .select("status")
      .eq("user_id", userId)
      .in("status", ["pending", "email_verified"])
      .maybeSingle();

    if (!pending) {
      const { data: customer } = await service
        .from("customers")
        .select("rider_status, deleted_at")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!customer || customer.rider_status !== "pending_verification") {
        return {
          ok: false,
          code: CUSTOMER_PHONE_OTP_BLOCK.NO_PROFILE,
          message: "Complete signup before verifying your phone number.",
          httpStatus: 403,
        };
      }
    }

    return { ok: true, normalizedPhone };
  }

  const { data: customer } = await service
    .from("customers")
    .select("id, rider_status, deleted_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!customer) {
    return {
      ok: false,
      code: CUSTOMER_PHONE_OTP_BLOCK.NO_PROFILE,
      message: "Complete signup before verifying your phone number.",
      httpStatus: 403,
    };
  }

  const status = String(customer.rider_status ?? "").toLowerCase();
  if (!ELIGIBLE_CHANGE_STATUSES.has(status)) {
    return {
      ok: false,
      code: CUSTOMER_PHONE_OTP_BLOCK.ACCOUNT_NOT_ELIGIBLE,
      message: "Phone verification is not available for this account state.",
      httpStatus: 403,
    };
  }

  if (purpose === "change") {
    if (!phoneRaw.trim()) {
      return {
        ok: false,
        code: CUSTOMER_PHONE_OTP_BLOCK.PHONE_REQUIRED,
        message: "New phone number is required.",
        httpStatus: 400,
      };
    }
    const currentAuthPhone = normalizeOnboardingPhone(String(authUser.phone ?? ""));
    if (currentAuthPhone && currentAuthPhone === normalizedPhone) {
      return {
        ok: false,
        code: CUSTOMER_PHONE_OTP_BLOCK.PHONE_UNCHANGED,
        message: "This is already your current phone number.",
        httpStatus: 400,
      };
    }
  }

  return { ok: true, normalizedPhone };
}
