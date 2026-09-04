/**
 * LOCK — Customer signup must not use public GoTrue /auth/v1/signup mailer.
 * Customers have no email-verification gate; create-onboarding-auth-user
 * confirms Auth email on admin createUser so a broken SMTP cannot 500 signup.
 * Phone OTP remains required (customerPhoneOtpPolicy must not gate on email).
 *
 * If this fails, fix the code — never delete or soften the lock.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = join(dirname(fromFileUrl(import.meta.url)), "../../..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

Deno.test("customer create-onboarding-auth-user confirms email without mailer", () => {
  const src = read("supabase/functions/create-onboarding-auth-user/index.ts");
  assert(src.includes('appType === "customer"'));
  assert(src.includes("confirmEmailOnCreate"));
  assert(src.includes("email_confirm: confirmEmailOnCreate"));
  assert(src.includes('confirmEmailOnCreate = appType === "customer"'));
  // Driver must stay unconfirmed for Resend onboarding verification.
  assert(src.includes('app_type === "driver"'));
  assert(src.includes("full_name"));
  assert(src.includes("email_verified: true"));
  // Never call public Auth signup mailer from this Edge.
  assertEquals(src.includes("auth.signUp"), false);
  assertEquals(src.includes("/auth/v1/signup"), false);
});

Deno.test("customer phone OTP does not require email verification", () => {
  const policy = read("supabase/functions/_shared/customerPhoneOtpPolicy.ts");
  const verify = read("supabase/functions/verify-customer-phone-otp/index.ts");
  assert(policy.includes("no email-verification gate"));
  assertEquals(policy.includes("isAccountEmailVerified"), false);
  assertEquals(policy.includes("EMAIL_NOT_VERIFIED"), true); // code enum may remain
  assert(policy.includes("Customers have no email-verification gate"));
  // Signup OTP from updateUser(phone) must verify as phone_change, not sms.
  assert(verify.includes('otpType = "phone_change"'));
  assertEquals(verify.includes('type: "sms"'), false);
});
