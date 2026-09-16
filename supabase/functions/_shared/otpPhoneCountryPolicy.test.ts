import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  assertOtpPhoneCountryAllowed,
  OTP_PHONE_COUNTRY_BLOCK,
} from "./otpPhoneCountryPolicy.ts";

function mockService(countries: Array<{ country_code: string; is_enabled: boolean }>) {
  return {
    from: (table: string) => {
      if (table !== "otp_allowed_countries") throw new Error(`unexpected table ${table}`);
      let filterCode: string | null = null;
      let filterEnabled: boolean | null = null;
      const builder = {
        eq: (col: string, value: string | boolean) => {
          if (col === "country_code") filterCode = String(value).toUpperCase();
          if (col === "is_enabled") filterEnabled = value === true;
          return builder;
        },
        maybeSingle: async () => {
          const row = countries.find(
            (c) =>
              c.country_code.toUpperCase() === filterCode &&
              (filterEnabled === null || c.is_enabled === filterEnabled),
          );
          return { data: row ? { country_code: row.country_code } : null, error: null };
        },
      };
      return { select: () => builder };
    },
  } as unknown as SupabaseClient;
}

Deno.test("assertOtpPhoneCountryAllowed allows enabled GB number", async () => {
  const result = await assertOtpPhoneCountryAllowed(mockService([
    { country_code: "GB", is_enabled: true },
  ]), "+441234567890");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.countryCode, "GB");
});

Deno.test("assertOtpPhoneCountryAllowed rejects disabled country before SMS", async () => {
  const result = await assertOtpPhoneCountryAllowed(mockService([
    { country_code: "GB", is_enabled: false },
  ]), "+441234567890");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, OTP_PHONE_COUNTRY_BLOCK.COUNTRY_NOT_ALLOWED);
    assertEquals(result.httpStatus, 403);
  }
});

Deno.test("assertOtpPhoneCountryAllowed rejects malformed phone fail-closed", async () => {
  const result = await assertOtpPhoneCountryAllowed(mockService([
    { country_code: "GB", is_enabled: true },
  ]), "not-a-phone");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, OTP_PHONE_COUNTRY_BLOCK.COUNTRY_UNKNOWN);
});

Deno.test("assertOtpPhoneCountryAllowed rejects unresolvable country fail-closed", async () => {
  const result = await assertOtpPhoneCountryAllowed(mockService([
    { country_code: "GB", is_enabled: true },
  ]), "+999000");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, OTP_PHONE_COUNTRY_BLOCK.COUNTRY_UNKNOWN);
});

Deno.test("list_enabled_otp_country_codes migration exposes only code and name", async () => {
  const repoRoot = new URL("../../../", import.meta.url);
  const sql = await Deno.readTextFile(new URL("supabase/migrations/20260831120000_p0_otp_country_ssot.sql", repoRoot));
  assertEquals(sql.includes("country_code"), true);
  assertEquals(sql.includes("country_name"), true);
  assertEquals(sql.includes("is_enabled"), true);
  assertEquals(sql.includes('DROP POLICY IF EXISTS "Anyone can read enabled OTP countries"'), true);
  assertEquals(sql.includes("REVOKE ALL ON TABLE public.otp_allowed_countries FROM anon"), true);
  assertEquals(sql.includes("GRANT EXECUTE ON FUNCTION public.list_enabled_otp_country_codes() TO anon"), true);
});

Deno.test("customer and driver OTP policies call server country gate", async () => {
  const repoRoot = new URL("../../../", import.meta.url);
  const customer = await Deno.readTextFile(new URL("supabase/functions/_shared/customerPhoneOtpPolicy.ts", repoRoot));
  const driver = await Deno.readTextFile(new URL("supabase/functions/_shared/driverPhoneOtpPolicy.ts", repoRoot));
  assertEquals(customer.includes("assertOtpPhoneCountryAllowed"), true);
  assertEquals(driver.includes("assertOtpPhoneCountryAllowed"), true);
});
