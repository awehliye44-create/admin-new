import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import type { VerificationAppType } from "./accountEmailVerification.ts";
import {
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  hashVerificationToken,
} from "./emailVerificationPolicy.ts";

export type EmailChangeAccountType = "customer" | "driver";

export const EMAIL_CHANGE_BLOCK = {
  INVALID_EMAIL: "INVALID_EMAIL",
  EMAIL_UNCHANGED: "EMAIL_UNCHANGED",
  EMAIL_IN_USE: "EMAIL_IN_USE",
  NOT_AUTHENTICATED: "NOT_AUTHENTICATED",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  NO_PROFILE: "NO_PROFILE",
  RATE_LIMITED: "RATE_LIMITED",
} as const;

export type EmailChangeBlockCode =
  typeof EMAIL_CHANGE_BLOCK[keyof typeof EMAIL_CHANGE_BLOCK];

export type EmailChangeGuardResult =
  | { ok: true; normalizedEmail: string; currentEmail: string; accountId: string | null }
  | { ok: false; code: EmailChangeBlockCode; message: string; httpStatus: number; retryAfterSeconds?: number };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeAccountEmail(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function isValidAccountEmail(email: string): boolean {
  const normalized = normalizeAccountEmail(email);
  return normalized.length >= 5 && EMAIL_REGEX.test(normalized);
}

export async function assertEmailChangeAllowed(
  service: SupabaseClient,
  userId: string,
  accountType: EmailChangeAccountType,
  newEmailRaw: string,
): Promise<EmailChangeGuardResult> {
  const normalizedEmail = normalizeAccountEmail(newEmailRaw);
  if (!isValidAccountEmail(normalizedEmail)) {
    return {
      ok: false,
      code: EMAIL_CHANGE_BLOCK.INVALID_EMAIL,
      message: "Invalid email address.",
      httpStatus: 400,
    };
  }

  const { data: authLookup } = await service.auth.admin.getUserById(userId);
  const authUser = authLookup?.user;
  if (!authUser?.email) {
    return {
      ok: false,
      code: EMAIL_CHANGE_BLOCK.NOT_AUTHENTICATED,
      message: "Please sign in again.",
      httpStatus: 401,
    };
  }

  const currentEmail = normalizeAccountEmail(authUser.email);
  if (!authUser.email_confirmed_at) {
    return {
      ok: false,
      code: EMAIL_CHANGE_BLOCK.EMAIL_NOT_VERIFIED,
      message: "Please verify your current email before changing it.",
      httpStatus: 403,
    };
  }

  if (currentEmail === normalizedEmail) {
    return {
      ok: false,
      code: EMAIL_CHANGE_BLOCK.EMAIL_UNCHANGED,
      message: "This is already your current email address.",
      httpStatus: 400,
    };
  }

  const { data: available, error: availError } = await service.rpc(
    "check_email_available_for_change",
    { _email: normalizedEmail, _user_id: userId },
  );
  if (availError || available !== true) {
    return {
      ok: false,
      code: EMAIL_CHANGE_BLOCK.EMAIL_IN_USE,
      message: "This email is already in use.",
      httpStatus: 409,
    };
  }

  let accountId: string | null = null;
  if (accountType === "customer") {
    const { data: customer } = await service
      .from("customers")
      .select("id, email_verified, deleted_at")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!customer) {
      return {
        ok: false,
        code: EMAIL_CHANGE_BLOCK.NO_PROFILE,
        message: "Complete your account setup before changing email.",
        httpStatus: 403,
      };
    }
    accountId = customer.id;
  } else {
    const { data: driver } = await service
      .from("drivers")
      .select("id, email_verified, deleted_at")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!driver) {
      return {
        ok: false,
        code: EMAIL_CHANGE_BLOCK.NO_PROFILE,
        message: "Complete driver signup before changing email.",
        httpStatus: 403,
      };
    }
    accountId = driver.id;
  }

  return { ok: true, normalizedEmail, currentEmail, accountId };
}

export async function assertEmailChangeResendAllowed(
  service: SupabaseClient,
  userId: string,
  accountType: VerificationAppType,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const { data: recent } = await service
    .from("account_email_change_requests")
    .select("requested_at")
    .eq("user_id", userId)
    .eq("account_type", accountType)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!recent?.requested_at) return { ok: true };

  const elapsedMs = Date.now() - new Date(recent.requested_at).getTime();
  const cooldownMs = EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000;
  if (elapsedMs < cooldownMs) {
    return { ok: false, retryAfterSeconds: Math.ceil((cooldownMs - elapsedMs) / 1000) };
  }
  return { ok: true };
}

export async function findPendingEmailChangeRequest(
  service: SupabaseClient,
  tokenRaw: string,
  accountType?: EmailChangeAccountType,
): Promise<{
  id: string;
  user_id: string;
  account_type: EmailChangeAccountType;
  account_id: string | null;
  current_email: string;
  new_email: string;
  expires_at: string;
  status: string;
  verified_at: string | null;
} | null> {
  const hash = await hashVerificationToken(tokenRaw);
  let query = service
    .from("account_email_change_requests")
    .select("id, user_id, account_type, account_id, current_email, new_email, expires_at, status, verified_at")
    .eq("token_hash", hash);

  if (accountType) {
    query = query.eq("account_type", accountType);
  }

  const { data } = await query.maybeSingle();
  return data ?? null;
}

export async function isLatestPendingEmailChangeRequest(
  service: SupabaseClient,
  row: { id: string; user_id: string; account_type: string },
): Promise<boolean> {
  const { data: latest } = await service
    .from("account_email_change_requests")
    .select("id")
    .eq("user_id", row.user_id)
    .eq("account_type", row.account_type)
    .eq("status", "pending")
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return latest?.id === row.id;
}
