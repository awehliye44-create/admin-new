export const CUSTOMER_APP_URL_SCHEME = "onecabcustomer";
export const DRIVER_APP_URL_SCHEME = "onecabdriver";
export const ADMIN_APP_URL_SCHEME = "onecabadmin";

export type VerificationAppType = "customer" | "driver" | "admin";

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

/** Native deep link opened by the email bridge redirect. */
export function accountEmailVerificationDeepLink(
  appType: VerificationAppType,
  token: string,
): string {
  const scheme = verificationAppScheme(appType);
  return `${scheme}://auth/verify-email?token=${encodeURIComponent(token)}&app=${appType}`;
}

/** Web fallback when the native app is not installed. */
export function accountEmailVerificationWebUrl(
  appBaseUrl: string,
  appType: VerificationAppType,
  token: string,
): string {
  const base = appBaseUrl.replace(/\/+$/, "");
  return `${base}/auth/verify-email?token=${encodeURIComponent(token)}&app=${appType}`;
}

/** Supabase edge bridge: tries native app first, falls back to web URL. */
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

/** Web fallback for email change verification. */
export function accountEmailChangeWebUrl(
  appBaseUrl: string,
  appType: VerificationAppType,
  token: string,
): string {
  const base = appBaseUrl.replace(/\/+$/, "");
  return `${base}/auth/verify-email-change?token=${encodeURIComponent(token)}&app=${appType}`;
}

/** Native deep link for email change verification. */
export function accountEmailChangeDeepLink(
  appType: VerificationAppType,
  token: string,
): string {
  const scheme = verificationAppScheme(appType);
  return `${scheme}://auth/verify-email-change?token=${encodeURIComponent(token)}&app=${appType}`;
}

export function resolveVerificationAppBaseUrl(
  appType: VerificationAppType,
  env: {
    customerAppUrl?: string | null;
    driverAppUrl?: string | null;
    adminAppUrl?: string | null;
    appUrl?: string | null;
  },
): string {
  if (appType === "driver") {
    return env.driverAppUrl ?? env.appUrl ?? "https://driver.onecab.net";
  }
  if (appType === "admin") {
    return env.adminAppUrl ?? env.appUrl ?? "https://admin.onecab.net";
  }
  return env.customerAppUrl ?? env.appUrl ?? "https://app.onecab.net";
}
