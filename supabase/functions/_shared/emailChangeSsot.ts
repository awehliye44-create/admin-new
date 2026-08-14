import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  accountEmailChangeBridgeUrl,
  accountEmailChangeWebUrl,
  type VerificationAppType,
} from "./accountEmailVerification.ts";
import type { EmailChangeAccountType } from "./emailChangePolicy.ts";
import {
  generateVerificationToken,
  hashVerificationToken,
  verificationExpiresAt,
} from "./emailVerificationPolicy.ts";
import { renderEmailChangeEmail } from "./emailChangeTemplate.ts";
import { resolveVerificationFirstName } from "./emailVerificationTemplate.ts";
import { sendResendEmail } from "./resendMail.ts";

/**
 * Generate a verification token + expiry without touching the DB.
 * Use this before sending the email so the DB row is only written
 * after delivery is confirmed (send-before-persist pattern).
 */
export async function prepareEmailChangeToken(): Promise<{ rawToken: string; expiresAt: string }> {
  const rawToken = generateVerificationToken();
  const expiresAt = verificationExpiresAt();
  return { rawToken, expiresAt };
}

export async function stageEmailChange(
  service: SupabaseClient,
  userId: string,
  appType: EmailChangeAccountType,
  normalizedEmail: string,
): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
  const { error } = await service.rpc("stage_email_change", {
    _user_id: userId,
    _new_email: normalizedEmail,
    _app_type: appType,
  });

  if (error) {
    console.error("stage_email_change error:", error.message);
    const msg = error.message.includes("already in use")
      ? "This email is already in use."
      : error.message.includes("invalid email")
      ? "Invalid email address."
      : "We couldn't send the verification email. Please try again.";
    return { ok: false, message: msg, code: "STAGE_EMAIL_CHANGE_FAILED" };
  }

  return { ok: true };
}

export async function createEmailChangeRequest(
  service: SupabaseClient,
  args: {
    userId: string;
    accountType: EmailChangeAccountType;
    accountId: string | null;
    currentEmail: string;
    newEmail: string;
    createdIp?: string | null;
    userAgent?: string | null;
    /** Pre-generated token from prepareEmailChangeToken(). If provided, skips token generation. */
    preGenerated?: { rawToken: string; expiresAt: string };
  },
): Promise<{ ok: true; rawToken: string; expiresAt: string } | { ok: false; message: string }> {
  const rawToken = args.preGenerated?.rawToken ?? generateVerificationToken();
  const tokenHash = await hashVerificationToken(rawToken);
  const expiresAt = args.preGenerated?.expiresAt ?? verificationExpiresAt();

  const { error } = await service.from("account_email_change_requests").insert({
    user_id: args.userId,
    account_type: args.accountType,
    account_id: args.accountId,
    current_email: args.currentEmail,
    new_email: args.newEmail,
    token_hash: tokenHash,
    status: "pending",
    expires_at: expiresAt,
    created_ip: args.createdIp ?? null,
    user_agent: args.userAgent ?? null,
  });

  if (error) {
    console.error("account_email_change_requests insert error:", error.message);
    return { ok: false, message: "We couldn't send the verification email. Please try again." };
  }

  return { ok: true, rawToken, expiresAt };
}

export async function sendEmailChangeVerification(
  args: {
    service: SupabaseClient;
    supabaseUrl: string;
    appType: VerificationAppType;
    toEmail: string;
    firstName: string;
    rawToken: string;
    appBaseUrl: string;
  },
): Promise<{ ok: true; resendId?: string } | { ok: false; message: string }> {
  const verifyUrl = accountEmailChangeBridgeUrl(args.supabaseUrl, args.appType, args.rawToken);
  const webVerifyUrl = accountEmailChangeWebUrl(args.appBaseUrl, args.appType, args.rawToken);

  const emailContent = renderEmailChangeEmail({
    appType: args.appType,
    firstName: args.firstName,
    verifyUrl,
    webVerifyUrl,
  });

  const sent = await sendResendEmail({
    to: args.toEmail,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
    tag: "account_email_change",
  });

  if (!sent.ok) {
    return { ok: false, message: sent.message };
  }

  return { ok: true, resendId: sent.id };
}

export async function completeEmailChangeAfterVerify(
  service: SupabaseClient,
  userId: string,
  appType: EmailChangeAccountType,
  newEmail: string,
): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
  const { error: authError } = await service.auth.admin.updateUserById(userId, {
    email: newEmail,
    email_confirm: true,
  });

  if (authError) {
    console.error("completeEmailChange auth update error:", authError.message);
    return {
      ok: false,
      message: "Email verified but account update failed. Please try again.",
      code: "AUTH_EMAIL_UPDATE_FAILED",
    };
  }

  const rpcName = appType === "customer"
    ? "complete_email_change_customer"
    : "complete_email_change_driver";

  const { error } = await service.rpc(rpcName, {
    _user_id: userId,
    _new_email: newEmail,
  });

  if (error) {
    console.error(`${rpcName} error:`, error.message);
    return {
      ok: false,
      message: "Email verified but profile sync failed. Please try again.",
      code: "EMAIL_SYNC_FAILED",
    };
  }

  return { ok: true };
}

export async function writeEmailChangedAudit(
  service: SupabaseClient,
  args: {
    appType: EmailChangeAccountType;
    userId: string;
    profileId: string | null;
    emailSuffix: string;
  },
): Promise<void> {
  const eventType = args.appType === "customer"
    ? "customer_email_changed"
    : "driver_email_changed";

  await service.rpc("ops_ingest_workflow_event", {
    p_event_type: eventType,
    p_app_name: args.appType === "customer" ? "customer_app" : "driver_app",
    p_severity: "info",
    p_customer_id: args.appType === "customer" ? args.userId : null,
    p_error_code: null,
    p_message: "Email address changed after verification link",
    p_metadata: {
      email_suffix: args.emailSuffix,
      profile_id: args.profileId,
      user_id: args.userId,
    },
    p_create_alert: false,
  });

  await service.from("audit_logs").insert({
    event_type: eventType,
    user_id: args.userId,
    ...(args.appType === "driver" ? { driver_id: args.profileId } : {}),
    details: {
      purpose: "change",
      email_suffix: args.emailSuffix,
      verified_at: new Date().toISOString(),
    },
  });
}

export async function resolveEmailChangeFirstName(
  service: SupabaseClient,
  userId: string,
  appType: EmailChangeAccountType,
  metadata: Record<string, unknown> | null | undefined,
): Promise<string> {
  const table = appType === "driver" ? "drivers" : "customers";
  const { data } = await service
    .from(table)
    .select("first_name")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  return resolveVerificationFirstName(metadata, data?.first_name ?? null);
}
