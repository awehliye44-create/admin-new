import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import type { VerificationAppType } from "./accountEmailVerification.ts";

export const EMAIL_VERIFICATION_EXPIRY_MINUTES = 30;
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;

export const ONECAB_NATIVE_CLIENT_HEADER = "x-onecab-native-client";

export const EMAIL_VERIFICATION_AUDIT = {
  SENT: "EMAIL_VERIFICATION_SENT",
  RESENT: "EMAIL_VERIFICATION_RESENT",
  SUCCESS: "EMAIL_VERIFICATION_SUCCESS",
  EXPIRED: "EMAIL_VERIFICATION_EXPIRED",
  ALREADY_VERIFIED: "EMAIL_VERIFICATION_ALREADY_VERIFIED",
  INVALID_TOKEN: "EMAIL_VERIFICATION_INVALID_TOKEN",
} as const;

export type VerificationFailureCode = "expired_token" | "invalid_token";

type VerificationTokenRowRef = {
  id: string;
  user_id: string;
};

export function assertNativeClientOnly(req: Request): Response | null {
  const nativeClient = String(req.headers.get(ONECAB_NATIVE_CLIENT_HEADER) ?? "").trim().toLowerCase();
  if (nativeClient !== "native") {
    logVerificationAudit(EMAIL_VERIFICATION_AUDIT.INVALID_TOKEN, {
      phase: "native_client_required",
      reason: "browser_client_not_allowed",
    });
    return new Response(JSON.stringify({
      error: "Email verification can only be completed in the ONECAB app.",
      code: "native_app_required",
    }), {
      status: 403,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-onecab-native-client",
        "Content-Type": "application/json",
      },
    });
  }
  return null;
}

export function verificationExpiresAt(now = Date.now()): string {
  return new Date(now + EMAIL_VERIFICATION_EXPIRY_MINUTES * 60 * 1000).toISOString();
}

export async function hashVerificationToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cryptographically secure 256-bit token (hex). Only the hash is stored. */
export function generateVerificationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function logVerificationAudit(event: string, payload: Record<string, unknown>) {
  console.log(event, JSON.stringify({ ...payload, ts: new Date().toISOString() }));
}

export function isVerificationTokenExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}

export async function assertVerificationResendAllowed(
  service: SupabaseClient,
  userId: string,
  appType: VerificationAppType,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const { data: recent } = await service
    .from("account_email_verifications")
    .select("created_at")
    .eq("user_id", userId)
    .eq("app_type", appType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!recent?.created_at) return { ok: true };

  const elapsedMs = Date.now() - new Date(recent.created_at).getTime();
  const cooldownMs = EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000;
  if (elapsedMs < cooldownMs) {
    return { ok: false, retryAfterSeconds: Math.ceil((cooldownMs - elapsedMs) / 1000) };
  }
  return { ok: true };
}

export async function invalidateUnusedVerificationTokens(
  service: SupabaseClient,
  userId: string,
  appType: VerificationAppType,
): Promise<void> {
  await service
    .from("account_email_verifications")
    .delete()
    .eq("user_id", userId)
    .eq("app_type", appType)
    .is("verified_at", null);
}

/** Only the newest unused token may verify an account. */
export async function isLatestUnusedVerificationToken(
  service: SupabaseClient,
  row: VerificationTokenRowRef,
  appType: VerificationAppType,
): Promise<boolean> {
  const { data: latest } = await service
    .from("account_email_verifications")
    .select("id")
    .eq("user_id", row.user_id)
    .eq("app_type", appType)
    .is("verified_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return latest?.id === row.id;
}

export async function assertPendingVerificationAccountForEmailSend(
  service: SupabaseClient,
  userId: string,
  appType: VerificationAppType,
): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
  if (appType === "admin") {
    return { ok: true };
  }

  if (appType === "customer") {
    const { data: pending } = await service
      .from("pending_customer_signups")
      .select("status, email_verified_at")
      .eq("user_id", userId)
      .in("status", ["pending", "email_verified"])
      .maybeSingle();

    if (pending) {
      if (pending.email_verified_at) {
        return {
          ok: false,
          code: "already_verified",
          message: "Email is already verified.",
        };
      }
      return { ok: true };
    }

    const { data: customer } = await service
      .from("customers")
      .select("rider_status, email_verified, deleted_at")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!customer) {
      const { data: authLookup } = await service.auth.admin.getUserById(userId);
      const authUser = authLookup?.user;
      if (!authUser?.email) {
        return {
          ok: false,
          code: "account_not_pending",
          message: "Complete signup before requesting a verification email.",
        };
      }
      if (authUser.email_confirmed_at) {
        return {
          ok: false,
          code: "already_verified",
          message: "Email is already verified.",
        };
      }
      return { ok: true };
    }
    if (customer.email_verified === true) {
      return {
        ok: false,
        code: "already_verified",
        message: "Email is already verified.",
      };
    }
    if (customer.rider_status !== "pending_verification") {
      return {
        ok: false,
        code: "account_not_pending",
        message: "Account is not pending verification.",
      };
    }
    return { ok: true };
  }

  const { data: driver } = await service
    .from("drivers")
    .select("email_verified, driver_status, deleted_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!driver) {
    const { data: authLookup } = await service.auth.admin.getUserById(userId);
    const authUser = authLookup?.user;
    if (!authUser?.email) {
      return {
        ok: false,
        code: "account_not_pending",
        message: "Complete driver signup before requesting a verification email.",
      };
    }
    if (authUser.email_confirmed_at) {
      return {
        ok: false,
        code: "already_verified",
        message: "Email is already verified.",
      };
    }
    return { ok: true };
  }
  if (driver.email_verified === true) {
    return {
      ok: false,
      code: "already_verified",
      message: "Email is already verified.",
    };
  }
  const driverStatus = String(driver.driver_status ?? "").toLowerCase();
  if (driverStatus === "disabled" || driverStatus === "deleted") {
    return {
      ok: false,
      code: "account_not_pending",
      message: "Account is not pending verification.",
    };
  }
  return { ok: true };
}
