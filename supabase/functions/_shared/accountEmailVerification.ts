export const CUSTOMER_APP_URL_SCHEME = "onecab-customer";
export const DRIVER_APP_URL_SCHEME = "onecab-driver";
export const ADMIN_APP_URL_SCHEME = "onecabadmin";

/** Canonical Android applicationIds — required for Gmail/Chrome intent:// handoff. */
export const CUSTOMER_ANDROID_PACKAGE = "com.onecab.customer.app";
export const DRIVER_ANDROID_PACKAGE = "com.onecab.driver.app";

export type VerificationAppType = "customer" | "driver" | "admin";
export type NativeVerifyPath = "auth/verify-email" | "auth/verify-email-change";

export function resolveVerificationAppType(raw: string | null | undefined): VerificationAppType {
  if (raw === "driver") return "driver";
  if (raw === "admin") return "admin";
  return "customer";
}

export function verificationAppScheme(appType: VerificationAppType): string {
  if (appType === "driver") return DRIVER_APP_URL_SCHEME;
  if (appType === "admin") return ADMIN_APP_URL_SCHEME;
  return CUSTOMER_APP_URL_SCHEME;
}

export function verificationAppAndroidPackage(
  appType: VerificationAppType,
): string | null {
  if (appType === "driver") return DRIVER_ANDROID_PACKAGE;
  if (appType === "customer") return CUSTOMER_ANDROID_PACKAGE;
  return null;
}

function nativeVerifyQuery(args: {
  appType: VerificationAppType;
  token?: string | null;
  error?: string | null;
}): string {
  const params = new URLSearchParams({ app: args.appType });
  const token = String(args.token ?? "").trim();
  const error = String(args.error ?? "").trim();
  if (token) params.set("token", token);
  if (error) params.set("error", error);
  return params.toString();
}

/** Native deep link opened by the email bridge. */
export function accountEmailVerificationDeepLink(
  appType: VerificationAppType,
  token: string,
  error?: string,
): string {
  const scheme = verificationAppScheme(appType);
  const query = nativeVerifyQuery({ appType, token, error });
  return `${scheme}://auth/verify-email?${query}`;
}

/**
 * Chrome/Samsung Gmail block HTTPS 302 → custom scheme.
 * intent:// with the real applicationId opens the installed app from a Custom Tab.
 */
export function accountEmailVerificationAndroidIntentUrl(
  appType: VerificationAppType,
  token: string,
  error?: string,
): string | null {
  return androidIntentUrl({
    appType,
    path: "auth/verify-email",
    token,
    error,
  });
}

export function androidIntentUrl(args: {
  appType: VerificationAppType;
  path: NativeVerifyPath;
  token?: string | null;
  error?: string | null;
}): string | null {
  const pkg = verificationAppAndroidPackage(args.appType);
  if (!pkg) return null;
  const scheme = verificationAppScheme(args.appType);
  const query = nativeVerifyQuery(args);
  return `intent://${args.path}?${query}#Intent;scheme=${scheme};package=${pkg};end`;
}

export function isAndroidUserAgent(userAgent: string | null | undefined): boolean {
  return /Android/i.test(String(userAgent ?? ""));
}

/** iOS Safari often ignores HTTPS 302 → custom-scheme. */
export function isIosSafariUserAgent(userAgent: string | null | undefined): boolean {
  const ua = String(userAgent ?? "");
  if (!/iPhone|iPad|iPod/i.test(ua)) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua)) return false;
  return /Safari/i.test(ua) || /AppleWebKit/i.test(ua);
}

/**
 * Public admin site that can serve real text/html.
 * Supabase Edge rewrites function HTML bodies to text/plain + CSP sandbox,
 * so the email bridge must 302 here instead of returning HTML itself.
 */
export const ACCOUNT_EMAIL_VERIFIED_SITE_ORIGIN = "https://adminonecab.net";

export type EmailVerifiedPageStatus =
  | "ok"
  | "already_verified"
  | "expired_token"
  | "invalid_token"
  | "missing_token"
  | "error";

/** Static Pages handoff (rendered HTML). Never includes the raw token. */
export function accountEmailVerifiedPageUrl(
  appType: VerificationAppType,
  status: EmailVerifiedPageStatus,
  siteOrigin = ACCOUNT_EMAIL_VERIFIED_SITE_ORIGIN,
): string {
  const base = siteOrigin.replace(/\/+$/, "");
  const params = new URLSearchParams({
    app: appType,
    status,
  });
  return `${base}/auth/email-verified/?${params.toString()}`;
}

/** Deep link into the holding screen after server-side confirm (no token). */
export function accountEmailVerifiedAppDeepLink(appType: VerificationAppType): string {
  const scheme = verificationAppScheme(appType);
  return `${scheme}://verify-email?app=${encodeURIComponent(appType)}&result=verified`;
}

/**
 * Location for the email-bridge handoff. Never taken from the request URL.
 * Android Chrome/Gmail Custom Tabs follow intent:// and block custom-scheme 302s.
 */
export function nativeAppHandoffLocation(args: {
  appType: VerificationAppType;
  path: NativeVerifyPath;
  token?: string | null;
  error?: string | null;
  userAgent?: string | null;
}): string {
  const token = String(args.token ?? "");
  const error: string | undefined = args.error ? String(args.error) : undefined;
  const android = isAndroidUserAgent(args.userAgent);
  if (android) {
    const intent = androidIntentUrl({
      appType: args.appType,
      path: args.path,
      token,
      error,
    });
    if (intent) return intent;
  }
  if (args.path === "auth/verify-email-change") {
    return accountEmailChangeDeepLink(args.appType, token, error);
  }
  return accountEmailVerificationDeepLink(args.appType, token, error);
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * HTML interstitial for iOS Safari (and similar) that cannot follow Location: custom-scheme.
 * Deep link is fixed from appType/path/token — never from caller-supplied redirect URLs.
 */
export function nativeAppHandoffHtml(args: {
  appType: VerificationAppType;
  path: NativeVerifyPath;
  token?: string | null;
  error?: string | null;
}): string {
  const deepLink = nativeAppHandoffLocation({
    ...args,
    userAgent: "iPhone",
  });
  const href = escapeHtmlAttr(deepLink);
  const appLabel = args.appType === "driver"
    ? "ONECAB Driver"
    : args.appType === "admin"
    ? "ONECAB Admin"
    : "ONECAB";
  const title = args.error
    ? "Open the app to continue"
    : "Confirming your email";
  const body = args.error
    ? "This link could not finish in the browser. Open the app, then use Resend if needed."
    : "Tap below if the app does not open automatically.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=${href}" />
  <title>${escapeHtmlAttr(title)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;padding:32px 20px;background:#fff;color:#111;text-align:center}
    a.btn{display:inline-block;margin-top:20px;padding:14px 22px;border-radius:12px;background:#111;color:#fff;text-decoration:none;font-weight:700}
    p{line-height:1.45;color:#444}
  </style>
  <script>location.replace(${JSON.stringify(deepLink)});</script>
</head>
<body>
  <h1>${escapeHtmlAttr(title)}</h1>
  <p>${escapeHtmlAttr(body)}</p>
  <p><a class="btn" href="${href}">Open ${escapeHtmlAttr(appLabel)}</a></p>
</body>
</html>`;
}

export function shouldServeNativeAppHandoffHtml(
  userAgent: string | null | undefined,
): boolean {
  if (isAndroidUserAgent(userAgent)) return false;
  return isIosSafariUserAgent(userAgent) || /iPhone|iPad|iPod/i.test(String(userAgent ?? ""));
}

/** Supabase edge bridge: HTTPS email button that hands off to the native app. */
export function accountEmailVerificationBridgeUrl(
  supabaseUrl: string,
  appType: VerificationAppType,
  token: string,
): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/functions/v1/account-email-verify-link?token=${encodeURIComponent(token)}&app=${appType}`;
}

/** Email change bridge (separate from signup verification). */
export function accountEmailChangeBridgeUrl(
  supabaseUrl: string,
  appType: VerificationAppType,
  token: string,
): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/functions/v1/account-email-change-verify-link?token=${encodeURIComponent(token)}&app=${appType}`;
}

/** Native deep link for email change verification. */
export function accountEmailChangeDeepLink(
  appType: VerificationAppType,
  token: string,
  error?: string,
): string {
  const scheme = verificationAppScheme(appType);
  const query = nativeVerifyQuery({ appType, token, error });
  return `${scheme}://auth/verify-email-change?${query}`;
}

export function accountEmailChangeAndroidIntentUrl(
  appType: VerificationAppType,
  token: string,
  error?: string,
): string | null {
  return androidIntentUrl({
    appType,
    path: "auth/verify-email-change",
    token,
    error,
  });
}
