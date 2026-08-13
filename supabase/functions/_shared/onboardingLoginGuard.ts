import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

export const PENDING_PHONE_CHANGE_TTL_MINUTES = 30;

export function normalizePhoneDigits(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length > 2 && digits.startsWith("00")) {
    return digits.slice(2);
  }
  return digits;
}

export function phonesMatchNormalized(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizePhoneDigits(a);
  const right = normalizePhoneDigits(b);
  return !!left && left === right;
}

export type ProfilePhonePendingRow = {
  phone?: string | null;
  phone_verified?: boolean | null;
  phone_verified_at?: string | null;
  pending_phone_change?: string | null;
  pending_phone_change_verified_at?: string | null;
  pending_phone_change_requested_at?: string | null;
  pending_phone_change_expires_at?: string | null;
};

export function hasActiveUnverifiedPendingPhoneChange(
  row: ProfilePhonePendingRow | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const pending = String(row?.pending_phone_change ?? "").trim();
  if (!pending) return false;
  if (row?.pending_phone_change_verified_at) return false;

  const expiresAt = row?.pending_phone_change_expires_at
    ? Date.parse(row.pending_phone_change_expires_at)
    : NaN;
  if (Number.isFinite(expiresAt)) {
    return expiresAt > nowMs;
  }

  const requestedAt = row?.pending_phone_change_requested_at
    ? Date.parse(row.pending_phone_change_requested_at)
    : NaN;
  if (!Number.isFinite(requestedAt)) return true;
  return requestedAt + PENDING_PHONE_CHANGE_TTL_MINUTES * 60_000 > nowMs;
}

export function isCanonicalProfilePhoneVerified(args: {
  profile: ProfilePhonePendingRow | null | undefined;
  authPhone?: string | null;
  authPhoneConfirmedAt?: string | null;
}): boolean {
  const profilePhone = String(args.profile?.phone ?? "").trim();
  if (!profilePhone || args.profile?.phone_verified !== true) return false;
  if (!args.authPhoneConfirmedAt) return false;
  return phonesMatchNormalized(profilePhone, args.authPhone);
}

export const ONBOARDING_LOGIN_BLOCK = {
  PHONE_NOT_VERIFIED: "PHONE_NOT_VERIFIED",
  // Distinct from PHONE_NOT_VERIFIED: user is already active but has an in-progress phone
  // change (pending_phone_change non-null, TTL live). Session must NOT be revoked on sign_in
  // for this code — the user should be allowed in to complete or abandon the change.
  PHONE_CHANGE_PENDING: "PHONE_CHANGE_PENDING",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  ACCOUNT_NOT_ACTIVE: "ACCOUNT_NOT_ACTIVE",
  DRIVER_NOT_APPROVED: "DRIVER_NOT_APPROVED",
  DOCUMENTS_NOT_APPROVED: "DOCUMENTS_NOT_APPROVED",
  DOCUMENTS_EXPIRED: "DOCUMENTS_EXPIRED",
  NO_PROFILE: "NO_PROFILE",
} as const;

export type OnboardingLoginBlockCode =
  typeof ONBOARDING_LOGIN_BLOCK[keyof typeof ONBOARDING_LOGIN_BLOCK];

export type OnboardingAppType = "customer" | "driver";

export type OnboardingLoginIntent = "sign_in" | "continue_verification" | "session_check";

export type OnboardingLoginGuardResult = {
  app_access_allowed: boolean;
  email_verified: boolean;
  phone_verified: boolean;
  account_active: boolean;
  next_path: string | null;
  block_code: OnboardingLoginBlockCode | null;
  message: string | null;
  session_revoked?: boolean;
};

/** Sign-in attempts must not keep a usable session when verification is incomplete. */
export function shouldRevokeSessionOnBlock(intent: OnboardingLoginIntent): boolean {
  return intent === "sign_in";
}

export async function isAccountEmailVerified(
  service: SupabaseClient,
  userId: string,
  appType: OnboardingAppType,
  authEmailConfirmedAt: string | null | undefined,
): Promise<boolean> {
  if (authEmailConfirmedAt) return true;

  const { data: row } = await service
    .from("account_email_verifications")
    .select("verified_at")
    .eq("user_id", userId)
    .eq("app_type", appType)
    .not("verified_at", "is", null)
    .order("verified_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return !!row?.verified_at;
}

export function customerVerificationMessage(
  emailVerified: boolean,
  phoneVerified: boolean,
): string {
  if (!phoneVerified) return "Please verify your phone number before signing in.";
  if (!emailVerified) return "Please verify your email address before signing in.";
  return "Please complete account verification before signing in.";
}

export function resolveCustomerNextPath(
  emailVerified: boolean,
  phoneVerified: boolean,
): string {
  if (!emailVerified) return "/auth/verify-email";
  if (!phoneVerified) return "/auth/verify-phone";
  return "/auth/verify-email";
}

export async function evaluateCustomerOnboardingLogin(
  service: SupabaseClient,
  userId: string,
): Promise<OnboardingLoginGuardResult> {
  const { data: authLookup } = await service.auth.admin.getUserById(userId);
  const authUser = authLookup?.user;
  if (!authUser) {
    return {
      app_access_allowed: false,
      email_verified: false,
      phone_verified: false,
      account_active: false,
      next_path: "/auth",
      block_code: ONBOARDING_LOGIN_BLOCK.ACCOUNT_NOT_ACTIVE,
      message: "Session is invalid. Please sign in again.",
    };
  }

  const emailVerified = await isAccountEmailVerified(
    service,
    userId,
    "customer",
    authUser.email_confirmed_at,
  );

  const { data: customer } = await service
    .from("customers")
    .select(
      "id, phone, phone_verified, phone_verified_at, pending_phone_change, pending_phone_change_verified_at, pending_phone_change_requested_at, pending_phone_change_expires_at, rider_status, email_verified, deleted_at",
    )
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (hasActiveUnverifiedPendingPhoneChange(customer)) {
    return {
      app_access_allowed: false,
      email_verified: emailVerified,
      phone_verified: false,
      account_active: false,
      next_path: "/auth/verify-phone",
      // PHONE_CHANGE_PENDING (not PHONE_NOT_VERIFIED) so guard-onboarding-login does NOT
      // revoke the session on sign_in. The user is already active — they must be allowed back
      // in to complete or abandon the in-progress phone change.
      block_code: ONBOARDING_LOGIN_BLOCK.PHONE_CHANGE_PENDING,
      message: "Please verify your new phone number to continue. Your current phone remains active until verification completes.",
    };
  }

  const phoneVerified = isCanonicalProfilePhoneVerified({
    profile: customer,
    authPhone: authUser.phone,
    authPhoneConfirmedAt: authUser.phone_confirmed_at,
  });

  if (!phoneVerified || !emailVerified) {
    return {
      app_access_allowed: false,
      email_verified: emailVerified,
      phone_verified: phoneVerified,
      account_active: false,
      next_path: resolveCustomerNextPath(emailVerified, phoneVerified),
      block_code: !phoneVerified
        ? ONBOARDING_LOGIN_BLOCK.PHONE_NOT_VERIFIED
        : ONBOARDING_LOGIN_BLOCK.EMAIL_NOT_VERIFIED,
      message: customerVerificationMessage(emailVerified, phoneVerified),
    };
  }

  if (!customer) {
    return {
      app_access_allowed: false,
      email_verified: emailVerified,
      phone_verified: phoneVerified,
      account_active: false,
      next_path: "/auth/verify-phone",
      block_code: ONBOARDING_LOGIN_BLOCK.NO_PROFILE,
      message: "Complete verification to activate your account.",
    };
  }

  const profileEmailVerified = customer.email_verified === true && emailVerified;
  const profilePhoneVerified = customer.phone_verified === true && phoneVerified;

  if (!profileEmailVerified || !profilePhoneVerified) {
    return {
      app_access_allowed: false,
      email_verified: profileEmailVerified,
      phone_verified: profilePhoneVerified,
      account_active: false,
      next_path: resolveCustomerNextPath(profileEmailVerified, profilePhoneVerified),
      block_code: !profilePhoneVerified
        ? ONBOARDING_LOGIN_BLOCK.PHONE_NOT_VERIFIED
        : ONBOARDING_LOGIN_BLOCK.EMAIL_NOT_VERIFIED,
      message: customerVerificationMessage(profileEmailVerified, profilePhoneVerified),
    };
  }

  if (customer.rider_status !== "active") {
    return {
      app_access_allowed: false,
      email_verified: profileEmailVerified,
      phone_verified: profilePhoneVerified,
      account_active: false,
      next_path: "/auth/verify-email",
      block_code: ONBOARDING_LOGIN_BLOCK.ACCOUNT_NOT_ACTIVE,
      message: "Your account is not active yet. Please complete verification.",
    };
  }

  return {
    app_access_allowed: true,
    email_verified: true,
    phone_verified: true,
    account_active: true,
    next_path: null,
    block_code: null,
    message: null,
  };
}

export async function evaluateDriverOnboardingLogin(
  service: SupabaseClient,
  userId: string,
): Promise<OnboardingLoginGuardResult> {
  const { data: authLookup } = await service.auth.admin.getUserById(userId);
  const authUser = authLookup?.user;
  if (!authUser) {
    return {
      app_access_allowed: false,
      email_verified: false,
      phone_verified: false,
      account_active: false,
      next_path: "/auth",
      block_code: ONBOARDING_LOGIN_BLOCK.ACCOUNT_NOT_ACTIVE,
      message: "Session is invalid. Please sign in again.",
    };
  }

  const emailVerified = await isAccountEmailVerified(
    service,
    userId,
    "driver",
    authUser.email_confirmed_at,
  );

  const { data: driver } = await service
    .from("drivers")
    .select(
      "id, phone, phone_verified, phone_verified_at, pending_phone_change, pending_phone_change_verified_at, pending_phone_change_requested_at, pending_phone_change_expires_at, approval_status, driver_status, email_verified, documents_approved, deleted_at",
    )
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (hasActiveUnverifiedPendingPhoneChange(driver)) {
    return {
      app_access_allowed: false,
      email_verified: emailVerified,
      phone_verified: false,
      account_active: false,
      next_path: "/auth/verify-phone",
      // PHONE_CHANGE_PENDING: same reasoning as customer — do not revoke session.
      block_code: ONBOARDING_LOGIN_BLOCK.PHONE_CHANGE_PENDING,
      message: "Please verify your new phone number to continue. Your current phone remains active until verification completes.",
    };
  }

  const phoneVerified = isCanonicalProfilePhoneVerified({
    profile: driver,
    authPhone: authUser.phone,
    authPhoneConfirmedAt: authUser.phone_confirmed_at,
  });

  if (!phoneVerified || !emailVerified) {
    return {
      app_access_allowed: false,
      email_verified: emailVerified,
      phone_verified: phoneVerified,
      account_active: false,
      next_path: !emailVerified ? "/auth/verify-email" : "/auth/verify-phone",
      block_code: !phoneVerified
        ? ONBOARDING_LOGIN_BLOCK.PHONE_NOT_VERIFIED
        : ONBOARDING_LOGIN_BLOCK.EMAIL_NOT_VERIFIED,
      message: customerVerificationMessage(emailVerified, phoneVerified),
    };
  }

  if (!driver) {
    return {
      app_access_allowed: false,
      email_verified: emailVerified,
      phone_verified: phoneVerified,
      account_active: false,
      next_path: "/auth/complete-signup",
      block_code: ONBOARDING_LOGIN_BLOCK.NO_PROFILE,
      message: "Complete driver signup to continue.",
    };
  }

  if (!driver.email_verified || !driver.phone_verified) {
    return {
      app_access_allowed: false,
      email_verified: !!driver.email_verified && emailVerified,
      phone_verified: !!driver.phone_verified && phoneVerified,
      account_active: false,
      next_path: !driver.email_verified ? "/auth/verify-email" : "/auth/verify-phone",
      block_code: !driver.phone_verified
        ? ONBOARDING_LOGIN_BLOCK.PHONE_NOT_VERIFIED
        : ONBOARDING_LOGIN_BLOCK.EMAIL_NOT_VERIFIED,
      message: customerVerificationMessage(!!driver.email_verified, !!driver.phone_verified),
    };
  }

  const approval = String(driver.approval_status ?? "").toLowerCase();
  if (approval !== "approved") {
    return {
      app_access_allowed: false,
      email_verified: true,
      phone_verified: true,
      account_active: false,
      next_path: "/pending-approval",
      block_code: ONBOARDING_LOGIN_BLOCK.DRIVER_NOT_APPROVED,
      message: "Your driver profile is pending admin approval.",
    };
  }

  // FIX (P0 — 2026-06-19): Use live document expiry check via DB RPC instead of the
  // stale `documents_approved` boolean cached on the drivers row. The cached boolean
  // is not updated until a scheduled job or admin action runs, so a driver whose
  // documents expired TODAY would still pass the old `documents_approved === true` check.
  // check_driver_documents_approved() uses today's Europe/London calendar date against
  // actual expiry_date values, so it correctly catches same-day expiry.
  const { data: liveDocsApproved, error: docsRpcError } = await service
    .rpc("check_driver_documents_approved", { p_driver_id: driver.id });

  if (docsRpcError) {
    // RPC failure — fall back to the cached boolean conservatively.
    // Log so we can detect and alert on RPC failures.
    console.warn("CHECK_DRIVER_DOCUMENTS_RPC_FAILED", JSON.stringify({
      driver_id: driver.id,
      error: docsRpcError.message,
      fallback: driver.documents_approved,
    }));
  }

  // Use live result when available; fall back to cached boolean if RPC failed.
  const documentsValid = docsRpcError ? (driver.documents_approved === true) : (liveDocsApproved === true);

  if (!documentsValid) {
    // Distinguish expired (was approved, now expired) from never-approved, for better UX messaging.
    const wasEverApproved = driver.documents_approved === true;
    return {
      app_access_allowed: false,
      email_verified: true,
      phone_verified: true,
      account_active: false,
      next_path: "/pending-approval",
      block_code: wasEverApproved
        ? ONBOARDING_LOGIN_BLOCK.DOCUMENTS_EXPIRED
        : ONBOARDING_LOGIN_BLOCK.DOCUMENTS_NOT_APPROVED,
      message: wasEverApproved
        ? "One or more of your documents has expired. Please renew them to continue driving."
        : "Your documents are not approved yet.",
    };
  }

  return {
    app_access_allowed: true,
    email_verified: true,
    phone_verified: true,
    account_active: true,
    next_path: null,
    block_code: null,
    message: null,
  };
}

export async function logOnboardingLoginBlock(
  service: SupabaseClient,
  payload: {
    user_id: string;
    app_type: OnboardingAppType;
    block_code: OnboardingLoginBlockCode;
    message: string;
    intent?: string;
  },
): Promise<void> {
  const { error } = await service.from("onboarding_login_audit_log").insert({
    user_id: payload.user_id,
    app_type: payload.app_type,
    block_code: payload.block_code,
    message: payload.message,
    intent: payload.intent ?? "sign_in",
  });
  if (error) {
    console.warn("ONBOARDING_LOGIN_AUDIT_INSERT_FAILED", JSON.stringify({
      user_id: payload.user_id,
      block_code: payload.block_code,
      error: error.message,
    }));
  }
}
