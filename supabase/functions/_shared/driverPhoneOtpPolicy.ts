import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { isAccountEmailVerified } from "./onboardingLoginGuard.ts";
import {
  isValidOnboardingPhone,
  normalizeOnboardingPhone,
} from "./onboardingValidation.ts";
import { PHONE_CHANGE_ERROR, PHONE_CHANGE_ERROR_MESSAGES } from "./phoneChangeErrorCodes.ts";
import { assertPhoneAvailableForChange } from "./phoneChangeSsot.ts";

export type DriverPhoneOtpPurpose = "signup" | "change";

export const DRIVER_PHONE_OTP_BLOCK = {
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  ACCOUNT_NOT_ELIGIBLE: "ACCOUNT_NOT_ELIGIBLE",
  PHONE_INVALID: "PHONE_INVALID",
  PHONE_UNCHANGED: "PHONE_UNCHANGED",
  NO_PROFILE: "NO_PROFILE",
} as const;

export type DriverPhoneOtpBlockCode =
  typeof DRIVER_PHONE_OTP_BLOCK[keyof typeof DRIVER_PHONE_OTP_BLOCK];

export type DriverPhoneOtpGuardResult =
  | { ok: true; normalizedPhone: string }
  | { ok: false; code: string; message: string; httpStatus: number };

const ELIGIBLE_CHANGE_STATUSES = new Set([
  "pending",
  "pending_approval",
  "approved",
  "active",
]);

/**
 * Server gate for driver phone OTP send/verify.
 * Invariant: email must be verified before any phone OTP action.
 */
export async function assertDriverPhoneOtpAllowed(
  service: SupabaseClient,
  userId: string,
  purpose: DriverPhoneOtpPurpose,
  phoneRaw: string,
): Promise<DriverPhoneOtpGuardResult> {
  const normalizedPhone = normalizeOnboardingPhone(phoneRaw);
  if (!isValidOnboardingPhone(normalizedPhone)) {
    return {
      ok: false,
      code: PHONE_CHANGE_ERROR.INVALID_PHONE_FORMAT,
      message: PHONE_CHANGE_ERROR_MESSAGES.INVALID_PHONE_FORMAT,
      httpStatus: 400,
    };
  }

  const { data: authLookup } = await service.auth.admin.getUserById(userId);
  const authUser = authLookup?.user;
  if (!authUser) {
    return {
      ok: false,
      code: DRIVER_PHONE_OTP_BLOCK.ACCOUNT_NOT_ELIGIBLE,
      message: "Session is invalid. Please sign in again.",
      httpStatus: 401,
    };
  }

  const emailVerified = await isAccountEmailVerified(
    service,
    userId,
    "driver",
    authUser.email_confirmed_at,
  );

  if (!emailVerified) {
    return {
      ok: false,
      code: DRIVER_PHONE_OTP_BLOCK.EMAIL_NOT_VERIFIED,
      message: "Verify your email before requesting a phone verification code.",
      httpStatus: 403,
    };
  }

  const { data: driver } = await service
    .from("drivers")
    .select("id, approval_status, driver_status, phone_verified, deleted_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (purpose === "signup") {
    if (driver) {
      const driverStatus = String(driver.driver_status ?? "").toLowerCase();
      if (driverStatus === "disabled" || driverStatus === "deleted") {
        return {
          ok: false,
          code: DRIVER_PHONE_OTP_BLOCK.ACCOUNT_NOT_ELIGIBLE,
          message: "Phone verification is not available for this account state.",
          httpStatus: 403,
        };
      }
      if (driver.phone_verified === true) {
        return {
          ok: false,
          code: DRIVER_PHONE_OTP_BLOCK.ACCOUNT_NOT_ELIGIBLE,
          message: "Phone is already verified for this account.",
          httpStatus: 403,
        };
      }
    }
    return { ok: true, normalizedPhone };
  }

  if (!driver) {
    return {
      ok: false,
      code: DRIVER_PHONE_OTP_BLOCK.NO_PROFILE,
      message: "Complete driver signup before changing your phone number.",
      httpStatus: 403,
    };
  }

  const currentAuthPhone = normalizeOnboardingPhone(String(authUser.phone ?? ""));

  if (purpose === "change") {
    const availability = await assertPhoneAvailableForChange(
      service,
      userId,
      "driver",
      normalizedPhone,
    );
    if (!availability.ok) {
      return {
        ok: false,
        code: availability.code,
        message: availability.message,
        httpStatus: availability.httpStatus,
      };
    }
  } else if (currentAuthPhone && currentAuthPhone === normalizedPhone) {
    return {
      ok: false,
      code: DRIVER_PHONE_OTP_BLOCK.PHONE_UNCHANGED,
      message: "This is already your current phone number.",
      httpStatus: 400,
    };
  }

  const approvalStatus = String(driver.approval_status ?? "").toLowerCase();
  if (!ELIGIBLE_CHANGE_STATUSES.has(approvalStatus)) {
    return {
      ok: false,
      code: DRIVER_PHONE_OTP_BLOCK.ACCOUNT_NOT_ELIGIBLE,
      message: "Phone verification is not available for this account state.",
      httpStatus: 403,
    };
  }

  return { ok: true, normalizedPhone };
}
