import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import parsePhoneNumberFromString from "https://esm.sh/libphonenumber-js@1.12.42/min";
import { normalizeOnboardingPhone } from "./onboardingValidation.ts";

export const OTP_PHONE_COUNTRY_BLOCK = {
  COUNTRY_UNKNOWN: "OTP_COUNTRY_UNKNOWN",
  COUNTRY_NOT_ALLOWED: "OTP_COUNTRY_NOT_ALLOWED",
} as const;

export type OtpPhoneCountryBlockCode =
  typeof OTP_PHONE_COUNTRY_BLOCK[keyof typeof OTP_PHONE_COUNTRY_BLOCK];

export type OtpPhoneCountryGuardResult =
  | { ok: true; countryCode: string }
  | { ok: false; code: OtpPhoneCountryBlockCode; message: string; httpStatus: number };

/**
 * Server-authoritative OTP country gate.
 * Fail closed when E.164 country cannot be resolved or is not enabled in otp_allowed_countries.
 */
export async function assertOtpPhoneCountryAllowed(
  service: SupabaseClient,
  phoneRaw: string,
): Promise<OtpPhoneCountryGuardResult> {
  const normalizedPhone = normalizeOnboardingPhone(phoneRaw);
  const parsed = parsePhoneNumberFromString(normalizedPhone);
  const countryCode = parsed?.country?.toUpperCase() ?? null;

  if (!parsed?.isValid() || !countryCode) {
    return {
      ok: false,
      code: OTP_PHONE_COUNTRY_BLOCK.COUNTRY_UNKNOWN,
      message: "Could not determine the country for this phone number.",
      httpStatus: 403,
    };
  }

  const { data, error } = await service
    .from("otp_allowed_countries")
    .select("country_code")
    .eq("country_code", countryCode)
    .eq("is_enabled", true)
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      code: OTP_PHONE_COUNTRY_BLOCK.COUNTRY_NOT_ALLOWED,
      message: "Phone verification is not available for this country yet.",
      httpStatus: 403,
    };
  }

  return { ok: true, countryCode };
}
