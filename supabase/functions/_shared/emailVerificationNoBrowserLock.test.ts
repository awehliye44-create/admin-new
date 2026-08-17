/**
 * LOCK — verification emails must not launch a browser / Capacitor web app.
 *
 * Run: deno test --allow-read supabase/functions/_shared/emailVerificationNoBrowserLock.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderVerificationEmail } from "./emailVerificationTemplate.ts";
import { renderEmailChangeEmail } from "./emailChangeTemplate.ts";

const BROWSER_RE =
  /continue in your browser|driver\.adminonecab\.net|driver\.onecab\.net|app\.onecab\.net\/auth\/verify-email|webVerifyUrl/i;

Deno.test("signup verification email has no browser fallback", () => {
  const email = renderVerificationEmail({
    appType: "driver",
    firstName: "John",
    verifyUrl:
      "https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/account-email-verify-link?token=abc&app=driver",
  });
  assertEquals(BROWSER_RE.test(email.html), false);
  assertEquals(BROWSER_RE.test(email.text), false);
  assertEquals(email.html.includes("VERIFY EMAIL"), true);
});

Deno.test("email-change email has no browser fallback", () => {
  const email = renderEmailChangeEmail({
    appType: "driver",
    firstName: "John",
    verifyUrl:
      "https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/account-email-change-verify-link?token=abc&app=driver",
  });
  assertEquals(BROWSER_RE.test(email.html), false);
  assertEquals(BROWSER_RE.test(email.text), false);
});

Deno.test("send functions no longer build web verify URLs", async () => {
  const send = await Deno.readTextFile(
    new URL("../send-account-email-verification/index.ts", import.meta.url),
  );
  const change = await Deno.readTextFile(
    new URL("../send-account-email-change-verification/index.ts", import.meta.url),
  );
  const shared = await Deno.readTextFile(
    new URL("./accountEmailVerification.ts", import.meta.url),
  );
  assertEquals(send.includes("webVerifyUrl"), false);
  assertEquals(send.includes("accountEmailVerificationWebUrl"), false);
  assertEquals(change.includes("appBaseUrl"), false);
  assertEquals(shared.includes("accountEmailVerificationWebUrl"), false);
  assertEquals(shared.includes("accountEmailChangeWebUrl"), false);
  assertEquals(shared.includes("driver.onecab.net"), false);
});

Deno.test("signup verification send-before-persist and uses verification tag", async () => {
  const send = await Deno.readTextFile(
    new URL("../send-account-email-verification/index.ts", import.meta.url),
  );
  const sendIdx = send.indexOf("await sendResendEmail");
  const invalidateIdx = send.indexOf("invalidateUnusedVerificationTokens", sendIdx);
  const insertIdx = send.indexOf('from("account_email_verifications").insert', sendIdx);
  assertEquals(sendIdx >= 0, true);
  assertEquals(invalidateIdx > sendIdx, true);
  assertEquals(insertIdx > sendIdx, true);
  assertEquals(send.includes('tag: "account_email_verification"'), true);
});
