/**
 * Lock: create-onboarding-auth-user must NOT attach Auth.phone on createUser.
 *
 * Pre-attaching unconfirmed phone makes Driver updateUser({ phone }) a no-op
 * (no phone_change OTP / no SMS) while the app still reports "code sent".
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const CREATE_ONBOARDING_PATH = new URL(
  "../create-onboarding-auth-user/index.ts",
  import.meta.url,
);

Deno.test("create-onboarding-auth-user does not attach Auth.phone on createUser", async () => {
  const source = await Deno.readTextFile(CREATE_ONBOARDING_PATH);
  assertEquals(
    /phone_confirm\s*:\s*false/.test(source),
    false,
    "Must not set phone_confirm:false on createUser (blocks later SMS OTP)",
  );
  assertEquals(
    /createWithPhone/.test(source),
    false,
    "Must not use createWithPhone payload (Auth.phone attach)",
  );
  assertEquals(
    /Keep phone in user_metadata only/.test(source),
    true,
    "Must document metadata-only phone on create",
  );
});
