/**
 * LOCK — VERIFY EMAIL must open the native Driver/Customer app.
 *
 * Production bug: bridge used onecabdriver:// (no hyphen) and HTTPS 302.
 * Driver listens for onecab-driver://. Samsung Gmail/Chrome Custom Tabs
 * block Location: custom-scheme, so the button never launched the app.
 *
 * Run: deno test --allow-read supabase/functions/_shared/accountEmailVerification.test.ts
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DRIVER_ANDROID_PACKAGE,
  DRIVER_APP_URL_SCHEME,
  CUSTOMER_ANDROID_PACKAGE,
  CUSTOMER_APP_URL_SCHEME,
  accountEmailVerificationAndroidIntentUrl,
  accountEmailVerificationDeepLink,
  nativeAppHandoffLocation,
} from "./accountEmailVerification.ts";

const TOKEN = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

Deno.test("Driver scheme matches native app.config (onecab-driver)", () => {
  assertEquals(DRIVER_APP_URL_SCHEME, "onecab-driver");
  assertEquals(CUSTOMER_APP_URL_SCHEME, "onecab-customer");
});

Deno.test("Driver Android intent targets com.onecab.driver.app", () => {
  assertEquals(DRIVER_ANDROID_PACKAGE, "com.onecab.driver.app");
  assertEquals(CUSTOMER_ANDROID_PACKAGE, "com.onecab.customer");

  const intent = accountEmailVerificationAndroidIntentUrl("driver", TOKEN);
  assertEquals(typeof intent, "string");
  assertStringIncludes(intent!, "intent://auth/verify-email?");
  assertStringIncludes(intent!, `token=${TOKEN}`);
  assertStringIncludes(intent!, "app=driver");
  assertStringIncludes(intent!, "#Intent;scheme=onecab-driver;package=com.onecab.driver.app;end");
});

Deno.test("Driver deep link uses hyphenated scheme the APK registers", () => {
  const link = accountEmailVerificationDeepLink("driver", TOKEN);
  assertEquals(
    link,
    `onecab-driver://auth/verify-email?app=driver&token=${TOKEN}`,
  );
  assertEquals(link.startsWith("onecabdriver://"), false);
});

Deno.test("Android Gmail UA hands off via intent:// to com.onecab.driver.app", () => {
  const TOKEN = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
  const location = nativeAppHandoffLocation({
    appType: "driver",
    path: "auth/verify-email",
    token: TOKEN,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-A165F) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
  });
  assertEquals(
    location,
    `intent://auth/verify-email?app=driver&token=${TOKEN}#Intent;scheme=onecab-driver;package=com.onecab.driver.app;end`,
  );
});

Deno.test("handoff Location never uses request-supplied redirect URLs", () => {
  const injected =
    "x#Intent;scheme=https;package=com.evil;S.browser_fallback_url=https://evil.example;end";
  const location = nativeAppHandoffLocation({
    appType: "driver",
    path: "auth/verify-email",
    token: injected,
    userAgent: "Android",
  });
  assertEquals(location.startsWith("intent://auth/verify-email?"), true);
  assertEquals(location.split("#Intent").length, 2);
  const intentSuffix = location.split("#Intent")[1] ?? "";
  assertEquals(
    intentSuffix,
    ";scheme=onecab-driver;package=com.onecab.driver.app;end",
  );
  assertEquals(intentSuffix.includes("com.evil"), false);
  assertEquals(intentSuffix.includes("browser_fallback_url"), false);
});
