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

const COMPANY_MAILBOXES = [
  "bookings@onecab.net",
  "info@onecab.net",
  "verify@onecab.net",
  "admin@onecab.net",
  "ops@mail.onecab.net",
  "driver@adminonecab.net",
  "x@onecab.com",
] as const;

Deno.test("blocks ONECAB-owned domains as personal recipients", () => {
  for (const email of COMPANY_MAILBOXES) {
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

Deno.test("Driver email-change: To = new driver email, CC/BCC none", () => {
  const newDriverEmail = "driver.new@gmail.com";
  const policy = assertPersonalEndUserEmail(newDriverEmail, "email_change");
  assertEquals(policy.ok, true);
  if (!policy.ok) return;

  const body = buildResendRequestBody({
    to: policy.normalizedEmail,
    subject: "Confirm your ONECAB email change",
    html: "<p>test</p>",
    text: "test",
    replyTo: "info@onecab.net",
    tag: "account_email_change",
  });
  assertEquals(Array.isArray(body.to), true);
  assertEquals((body.to as string[]).length, 1);
  assertEquals((body.to as string[])[0], newDriverEmail);
  assertEquals("cc" in body, false);
  assertEquals("bcc" in body, false);
  assertEquals(body.reply_to, "info@onecab.net");
});

Deno.test("Customer trip invoice: To = trip owner email, CC/BCC none", () => {
  const tripOwnerEmail = "customer.owner@hotmail.com";
  const policy = assertPersonalEndUserEmail(tripOwnerEmail, "personal_trip_invoice");
  assertEquals(policy.ok, true);
  if (!policy.ok) return;

  const body = buildResendRequestBody({
    to: policy.normalizedEmail,
    subject: "Your ONECAB Trip Receipt — INV-TEST",
    html: "<p>Invoice</p>",
    text: "Invoice",
    replyTo: "info@onecab.net",
    tag: "trip_invoice",
  });
  assertEquals(Array.isArray(body.to), true);
  assertEquals((body.to as string[]).length, 1);
  assertEquals((body.to as string[])[0], tripOwnerEmail);
  assertEquals("cc" in body, false);
  assertEquals("bcc" in body, false);
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

Deno.test("admin-new Resend builder ignores any DEBUG BCC env", () => {
  Deno.env.set("RESEND_DEBUG_BCC_EMAIL", "bookings@onecab.net");
  try {
    const body = buildResendRequestBody({
      to: "logic4team@gmail.com",
      subject: "test",
      html: "<p>t</p>",
      tag: "trip_invoice",
    });
    assertEquals("bcc" in body, false);
    assertEquals("cc" in body, false);
  } finally {
    Deno.env.delete("RESEND_DEBUG_BCC_EMAIL");
  }
});

Deno.test("stacked trips stay independent — each payload has its own single To", () => {
  const tripA = "owner.a@gmail.com";
  const tripB = "owner.b@gmail.com";
  const bodyA = buildResendRequestBody({
    to: tripA,
    subject: "Receipt A",
    html: "<p>A</p>",
    tag: "trip_invoice",
  });
  const bodyB = buildResendRequestBody({
    to: tripB,
    subject: "Receipt B",
    html: "<p>B</p>",
    tag: "trip_invoice",
  });
  assertEquals((bodyA.to as string[])[0], tripA);
  assertEquals((bodyB.to as string[])[0], tripB);
  assertEquals((bodyA.to as string[]).length, 1);
  assertEquals((bodyB.to as string[]).length, 1);
  assertEquals("cc" in bodyA || "bcc" in bodyA, false);
  assertEquals("cc" in bodyB || "bcc" in bodyB, false);
});
