import { describe, expect, it } from "vitest";

import {
  DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT,
  DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT,
  emailRateLimitFingerprint,
  extractRecoveryActionLink,
  getRecoveryRedirect,
  hasDisallowedClientRedirect,
  isUnknownAccountGenerateLinkError,
  normalizeRecoveryEmail,
  parseRecoveryApp,
  passwordRecoverySafeResponse,
} from "@shared/passwordRecoverySSOT";
import {
  PASSWORD_RESET_EMAIL_SUBJECT,
  buildPasswordResetEmail,
} from "@shared/passwordResetEmail";

describe("passwordRecoverySSOT", () => {
  it("normalizes and validates email", () => {
    expect(normalizeRecoveryEmail("  Alex@ONECAB.NET ")).toBe("alex@onecab.net");
    expect(normalizeRecoveryEmail("bad")).toBeNull();
    expect(normalizeRecoveryEmail(null)).toBeNull();
  });

  it("parses app whitelist only", () => {
    expect(parseRecoveryApp("driver")).toBe("driver");
    expect(parseRecoveryApp("customer")).toBe("customer");
    expect(parseRecoveryApp("admin")).toBeNull();
    expect(parseRecoveryApp(undefined)).toBeNull();
  });

  it("resolves redirects from app map / env, never inventing client URLs", () => {
    expect(getRecoveryRedirect("driver")).toBe(DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT);
    expect(getRecoveryRedirect("customer")).toBe(DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT);
    expect(
      getRecoveryRedirect("driver", {
        DRIVER_PASSWORD_RESET_REDIRECT: "onecab-driver://custom-reset",
      }),
    ).toBe("onecab-driver://custom-reset");
  });

  it("rejects client-provided redirect fields", () => {
    expect(hasDisallowedClientRedirect({ email: "a@b.c", app: "driver" })).toBe(false);
    expect(
      hasDisallowedClientRedirect({
        email: "a@b.c",
        app: "driver",
        redirectTo: "https://evil.example",
      }),
    ).toBe(true);
  });

  it("extracts action_link only from generateLink properties", () => {
    expect(
      extractRecoveryActionLink({
        properties: {
          action_link: "https://thazislrdkjpvvghtvzo.supabase.co/auth/v1/verify?token=abc",
        },
      }),
    ).toContain("https://");
    expect(extractRecoveryActionLink({ properties: { hashed_token: "x" } })).toBeNull();
    expect(extractRecoveryActionLink(null)).toBeNull();
  });

  it("maps unknown-account generateLink errors", () => {
    expect(isUnknownAccountGenerateLinkError("User not found")).toBe(true);
    expect(isUnknownAccountGenerateLinkError("network timeout")).toBe(false);
  });

  it("safe response never reveals account existence", () => {
    const r = passwordRecoverySafeResponse();
    expect(r.ok).toBe(true);
    expect(r.message.toLowerCase()).toContain("if an account matches");
    expect(r.message.toLowerCase()).not.toContain("not found");
  });

  it("email rate fingerprint is stable and non-raw", () => {
    const a = emailRateLimitFingerprint("alex@onecab.net");
    const b = emailRateLimitFingerprint("alex@onecab.net");
    expect(a).toBe(b);
    expect(a).not.toContain("@");
    expect(a.startsWith("em_")).toBe(true);
  });
});

describe("passwordResetEmail", () => {
  it("builds branded HTML with Confirmation-style CTA and no raw token fields", () => {
    const url =
      "https://thazislrdkjpvvghtvzo.supabase.co/auth/v1/verify?type=recovery&token=hashed&redirect_to=onecab-driver%3A%2F%2Freset-password";
    const mail = buildPasswordResetEmail({
      recoveryUrl: url,
      app: "driver",
      logoUrl: "https://cdn.example/logo.png",
    });

    expect(mail.subject).toBe(PASSWORD_RESET_EMAIL_SUBJECT);
    expect(mail.html).toContain("Reset your password");
    expect(mail.html).toContain("Reset password");
    expect(mail.html).toContain("#FFD400");
    expect(mail.html).toContain("#0B0F14");
    expect(mail.html).toContain('alt="ONECAB"');
    expect(mail.html).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
    expect(mail.html).not.toMatch(/copy and paste|into your browser/i);
    expect(mail.html).not.toMatch(/access_token|refresh_token|service.role/i);
    // Visible paste-fallback URL text removed — recovery URL stays only on the CTA href.
    expect(mail.html).not.toMatch(/>https:\/\/[^<]+supabase\.co\/auth\/v1\/verify/);
    expect(mail.text).not.toContain(url);
    expect(mail.text).toMatch(/tap Reset password/i);
    expect(mail.text).not.toMatch(/\bpassword\s*[:=]/i);
  });

  it("rejects non-http recovery URLs", () => {
    expect(() =>
      buildPasswordResetEmail({
        recoveryUrl: "javascript:alert(1)",
        app: "customer",
      }),
    ).toThrow(/https recovery link/i);
  });

  it("falls back to text wordmark when logo missing", () => {
    const mail = buildPasswordResetEmail({
      recoveryUrl: "https://example.com/auth/v1/verify?type=recovery&token=x",
      app: "customer",
    });
    expect(mail.html).toContain(">ONECAB</div>");
    expect(mail.html).not.toContain("<img");
  });
});
