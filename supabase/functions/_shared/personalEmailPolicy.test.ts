/**
 * Personal email policy + greeting isolation + no-copy Resend payload tests.
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertPersonalEndUserEmail,
  classifyExistingPersonalEmail,
  isOnecabOwnedEmailDomain,
  maskEmailForAdmin,
} from "./personalEmailPolicy.ts";
import { resolveVerificationFirstName } from "./emailVerificationTemplate.ts";
import { buildResendRequestBody } from "./resendMail.ts";

Deno.test("blocks ONECAB-owned domains as personal recipients", () => {
  const blocked = [
    "bookings@onecab.net",
    "info@onecab.net",
    "verify@onecab.net",
    "ops@mail.onecab.net",
    "driver@adminonecab.net",
    "x@onecab.com",
  ];
  for (const email of blocked) {
    const result = assertPersonalEndUserEmail(email, "email_change");
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.code, "RECIPIENT_POLICY_VIOLATION");
  }
});

Deno.test("allows personal gmail/hotmail recipients", () => {
  const ok = assertPersonalEndUserEmail("logic4team@gmail.com", "email_change");
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.normalizedEmail, "logic4team@gmail.com");
});

Deno.test("classifies existing company Auth email as policy violation", () => {
  const c = classifyExistingPersonalEmail("bookings@onecab.net");
  assertEquals(c.status, "recipient_policy_violation");
});

Deno.test("From/Reply-To domains remain recognisable as owned", () => {
  assertEquals(isOnecabOwnedEmailDomain("onecab.net"), true);
  assertEquals(isOnecabOwnedEmailDomain("verify@onecab.net"), true);
});

Deno.test("greeting prefers acting profile over Auth metadata", () => {
  const name = resolveVerificationFirstName(
    { first_name: "Mohamud" },
    "Ahmed",
  );
  assertEquals(name, "Ahmed");
});

Deno.test("greeting falls back to metadata only when profile name missing", () => {
  assertEquals(resolveVerificationFirstName({ first_name: "Ahmed" }, null), "Ahmed");
  assertEquals(resolveVerificationFirstName({}, null), "there");
});

Deno.test("maskEmailForAdmin redacts local part", () => {
  const masked = maskEmailForAdmin("logic4team@gmail.com");
  assertEquals(masked.includes("logic4team"), false);
  assertEquals(masked.endsWith("@gmail.com"), true);
});

Deno.test("Resend personal payload has exactly one To and no CC/BCC", () => {
  const body = buildResendRequestBody({
    to: "logic4team@gmail.com",
    subject: "Confirm your ONECAB email change",
    html: "<p>test</p>",
    text: "test",
    tag: "account_email_change",
  });
  assertEquals(Array.isArray(body.to), true);
  assertEquals((body.to as string[]).length, 1);
  assertEquals((body.to as string[])[0], "logic4team@gmail.com");
  assertEquals("cc" in body, false);
  assertEquals("bcc" in body, false);
});
