export const CUSTOMER_APP_URL_SCHEME = "onecab-customer";
export const DRIVER_APP_URL_SCHEME = "onecab-driver";
export const ADMIN_APP_URL_SCHEME = "onecabadmin";

/** Canonical Android applicationIds — required for Gmail/Chrome intent:// handoff. */
export const CUSTOMER_ANDROID_PACKAGE = "com.onecab.customer";
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
