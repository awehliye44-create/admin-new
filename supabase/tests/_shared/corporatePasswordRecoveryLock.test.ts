import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_CORPORATE_PASSWORD_RESET_REDIRECT,
  DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT,
  DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT,
  buildCorporateRecoveryPageUrl,
  buildCorporateRecoveryPageUrlFromSession,
  buildNativeRecoveryDeepLinkFromSession,
  extractRecoveryActionLink,
  extractRecoveryTokenHash,
  getRecoveryRedirect,
  isAllowedPasswordResetRecoveryUrl,
  parseRecoveryApp,
} from "./passwordRecoverySSOT.ts";
import { buildPasswordResetEmail } from "./passwordResetEmail.ts";

Deno.test("parseRecoveryApp accepts corporate", () => {
  assertEquals(parseRecoveryApp("corporate"), "corporate");
  assertEquals(parseRecoveryApp("customer"), "customer");
  assertEquals(parseRecoveryApp("driver"), "driver");
  assertEquals(parseRecoveryApp("admin"), null);
});

Deno.test("getRecoveryRedirect corporate defaults to co.onecab.net", () => {
  assertEquals(
    getRecoveryRedirect("corporate"),
    DEFAULT_CORPORATE_PASSWORD_RESET_REDIRECT,
  );
  assertEquals(
    getRecoveryRedirect("corporate", {
      CORPORATE_PASSWORD_RESET_REDIRECT: "https://co.onecab.net/reset-password?x=1",
    }),
    "https://co.onecab.net/reset-password?x=1",
  );
});

Deno.test("buildPasswordResetEmail supports corporate wording", () => {
  const rendered = buildPasswordResetEmail({
    recoveryUrl: "https://example.com/recover",
    app: "corporate",
  });
  assertEquals(rendered.subject.includes("ONECAB"), true);
  assertEquals(rendered.text.includes("Corporate"), true);
  assertEquals(rendered.text.includes("Corporate portal"), true);
  assertEquals(rendered.html.includes("Reset password"), true);
});

Deno.test("extractRecoveryActionLink reads top-level action_link", () => {
  const link = extractRecoveryActionLink({
    action_link: "https://example.com/auth/v1/verify?token=abc&type=recovery",
  });
  assertEquals(link?.startsWith("https://example.com/"), true);
});

Deno.test("buildCorporateRecoveryPageUrl uses token_hash on co.onecab.net", () => {
  const url = buildCorporateRecoveryPageUrl({
    hashed_token: "abc123tokenhash",
    action_link:
      "https://thazislrdkjpvvghtvzo.supabase.co/auth/v1/verify?token=abc123tokenhash&type=recovery&redirect_to=http://localhost:3000",
  });
  assertEquals(url?.startsWith("https://co.onecab.net/reset-password"), true);
  assertEquals(url?.includes("token_hash=abc123tokenhash"), true);
  assertEquals(url?.includes("type=recovery"), true);
  assertEquals(url?.includes("localhost"), false);
  assertEquals(extractRecoveryTokenHash({ properties: { hashed_token: "xyz" } }), "xyz");
});

Deno.test("buildCorporateRecoveryPageUrlFromSession embeds hash session for live SPA", () => {
  const url = buildCorporateRecoveryPageUrlFromSession({
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    expiresIn: 3600,
  });
  assertEquals(url?.startsWith("https://co.onecab.net/reset-password#"), true);
  assertEquals(url?.includes("access_token=access-token-value"), true);
  assertEquals(url?.includes("refresh_token=refresh-token-value"), true);
  assertEquals(url?.includes("type=recovery"), true);
  assertEquals(url?.includes("localhost"), false);
});

Deno.test("buildNativeRecoveryDeepLinkFromSession embeds hash session for Driver/Customer apps", () => {
  const driver = buildNativeRecoveryDeepLinkFromSession({
    nativeRedirect: DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT,
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    expiresIn: 3600,
  });
  assertEquals(driver?.startsWith("onecab-driver://reset-password#"), true);
  assertEquals(driver?.includes("access_token=access-token-value"), true);
  assertEquals(driver?.includes("refresh_token=refresh-token-value"), true);

  const customer = buildNativeRecoveryDeepLinkFromSession({
    nativeRedirect: DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT,
    accessToken: "a",
    refreshToken: "r",
  });
  assertEquals(customer?.startsWith("onecab-customer://auth/reset-password#"), true);
});

Deno.test("isAllowedPasswordResetRecoveryUrl accepts https and native deep links", () => {
  assertEquals(isAllowedPasswordResetRecoveryUrl("https://example.com/x"), true);
  assertEquals(isAllowedPasswordResetRecoveryUrl("onecab-driver://reset-password#x=1"), true);
  assertEquals(isAllowedPasswordResetRecoveryUrl("onecab-customer://auth/reset-password"), true);
  assertEquals(isAllowedPasswordResetRecoveryUrl("javascript:alert(1)"), false);
});

Deno.test("request-password-recovery builds native session deep links for driver and customer", () => {
  const src = Deno.readTextFileSync(
    new URL("../request-password-recovery/index.ts", import.meta.url),
  );
  assertEquals(src.includes("buildNativeRecoveryDeepLinkFromSession"), true);
  assertEquals(src.includes("native_session_deep_link_built"), true);
  assertEquals(src.includes('app === "driver" || app === "customer"'), true);
});
