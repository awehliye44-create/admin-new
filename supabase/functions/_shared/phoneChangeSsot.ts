import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { mapOtpErrorToMessage } from "./authErrorMessages.ts";
import {
  type GoTrueAuthContext,
  type GoTrueResult,
  goTrueResendPhoneChange,
  goTrueUpdateUserPhone,
  phoneDigits,
} from "./goTrueUserApi.ts";
import {
  PHONE_CHANGE_ERROR,
  PHONE_CHANGE_ERROR_MESSAGES,
  resolvePhoneChangeErrorMessage,
} from "./phoneChangeErrorCodes.ts";

const PHONE_CHANGE_OTP_TTL_MS = 30 * 60 * 1000;

function readPendingPhoneChange(user: Record<string, unknown>): string {
  const raw = user.phone_change ?? user.new_phone ?? "";
  return phoneDigits(String(raw));
}

async function resolvePhoneChangeDispatch(
  authCtx: GoTrueAuthContext,
  service: SupabaseClient,
  userId: string,
  normalizedPhone: string,
): Promise<GoTrueResult> {
  const targetDigits = phoneDigits(normalizedPhone);
  const { data: authLookup } = await service.auth.admin.getUserById(userId);
  const authUser = authLookup?.user as Record<string, unknown> | undefined;

  if (authUser) {
    const pendingDigits = readPendingPhoneChange(authUser);
    const sentAtRaw = authUser.phone_change_sent_at;
    const sentAt = typeof sentAtRaw === "string" ? Date.parse(sentAtRaw) : Number.NaN;
    const isFresh = Number.isFinite(sentAt) && Date.now() - sentAt < PHONE_CHANGE_OTP_TTL_MS;

    if (pendingDigits && pendingDigits === targetDigits && isFresh) {
      return goTrueResendPhoneChange(authCtx, normalizedPhone);
    }

    if (pendingDigits && (!isFresh || pendingDigits !== targetDigits)) {
      await service.auth.admin.updateUserById(userId, {
        phone_change: "",
        phone_change_sent_at: undefined,
      });
    }
  }

  const sent = await goTrueUpdateUserPhone(authCtx, normalizedPhone);
  if (sent.ok) return sent;

  const { data: retryLookup } = await service.auth.admin.getUserById(userId);
  const retryUser = retryLookup?.user as Record<string, unknown> | undefined;
  if (retryUser && readPendingPhoneChange(retryUser) === targetDigits) {
    return goTrueResendPhoneChange(authCtx, normalizedPhone);
  }

  return sent;
}

export type PhoneChangeAppType = "customer" | "driver";

type PhoneAvailabilityResult = {
  available: boolean;
  code: string | null;
  message: string | null;
};

export async function assertPhoneAvailableForChange(
  service: SupabaseClient,
  userId: string,
  appType: PhoneChangeAppType,
  normalizedPhone: string,
): Promise<{ ok: true } | { ok: false; message: string; code: string; httpStatus: number }> {
  const { data, error } = await service.rpc("check_phone_available_for_change", {
    p_user_id: userId,
    p_phone: normalizedPhone,
    p_app_type: appType,
  });

  if (error) {
    console.error("check_phone_available_for_change error:", error.message);
    return {
      ok: false,
      code: PHONE_CHANGE_ERROR.AUTH_PHONE_UPDATE_FAILED,
      message: PHONE_CHANGE_ERROR_MESSAGES.AUTH_PHONE_UPDATE_FAILED,
      httpStatus: 500,
    };
  }

  const result = data as PhoneAvailabilityResult | null;
  if (result?.available === true) {
    return { ok: true };
  }

  const code = result?.code ?? PHONE_CHANGE_ERROR.AUTH_PHONE_UPDATE_FAILED;
  return {
    ok: false,
    code,
    message: resolvePhoneChangeErrorMessage(code, result?.message),
    httpStatus: 400,
  };
}

export async function clearPhoneChangePending(
  service: SupabaseClient,
  userId: string,
  appType: PhoneChangeAppType,
): Promise<void> {
  const { error } = await service.rpc("clear_phone_change_pending", {
    _user_id: userId,
    _app_type: appType,
  });
  if (error) {
    console.error("clear_phone_change_pending error:", error.message);
  }
}

export async function repairStaleAuthBeforeContactChange(
  service: SupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await service.rpc("repair_user_stale_auth_identities", {
    _user_id: userId,
  });
  if (error) {
    console.warn("repair_user_stale_auth_identities error:", error.message);
  }
}

export async function stagePhoneChange(
  service: SupabaseClient,
  userId: string,
  appType: PhoneChangeAppType,
  normalizedPhone: string,
): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
  const { error } = await service.rpc("stage_phone_change", {
    _user_id: userId,
    _new_phone: normalizedPhone,
    _app_type: appType,
  });

  if (error) {
    console.error("stage_phone_change error:", error.message);
    const msg = error.message.toLowerCase();
    if (msg.includes("profile not found")) {
      return {
        ok: false,
        message: "Complete signup before changing your phone number.",
        code: "NO_PROFILE",
      };
    }
    return {
      ok: false,
      message: PHONE_CHANGE_ERROR_MESSAGES.AUTH_PHONE_UPDATE_FAILED,
      code: PHONE_CHANGE_ERROR.AUTH_PHONE_UPDATE_FAILED,
    };
  }

  return { ok: true };
}

export async function sendPhoneChangeOtp(
  authCtx: GoTrueAuthContext,
  normalizedPhone: string,
  options: { service: SupabaseClient; userId: string },
): Promise<{ ok: true } | { ok: false; message: string; code: string; httpStatus: number }> {
  const dispatched = await resolvePhoneChangeDispatch(
    authCtx,
    options.service,
    options.userId,
    normalizedPhone,
  );

  if (!dispatched.ok) {
    console.warn("sendPhoneChangeOtp GoTrue error:", dispatched.message);
    const mapped = mapOtpErrorToMessage({ message: dispatched.message }, "send");

    if (mapped.code === "duplicate_phone") {
      return {
        ok: false,
        message: PHONE_CHANGE_ERROR_MESSAGES.PHONE_ALREADY_IN_USE,
        code: PHONE_CHANGE_ERROR.PHONE_ALREADY_IN_USE,
        httpStatus: 400,
      };
    }

    if (mapped.code === "rate_limited") {
      return {
        ok: false,
        message: PHONE_CHANGE_ERROR_MESSAGES.RATE_LIMITED,
        code: PHONE_CHANGE_ERROR.RATE_LIMITED,
        httpStatus: 429,
      };
    }

    return {
      ok: false,
      message: PHONE_CHANGE_ERROR_MESSAGES.OTP_SEND_FAILED,
      code: PHONE_CHANGE_ERROR.OTP_SEND_FAILED,
      httpStatus: 400,
    };
  }

  return { ok: true };
}

export async function completePhoneChangeAfterVerify(
  service: SupabaseClient,
  userId: string,
  appType: PhoneChangeAppType,
): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
  const rpcName = appType === "customer"
    ? "complete_phone_change_customer"
    : "complete_phone_change_driver";

  const { error } = await service.rpc(rpcName, { _user_id: userId });

  if (error) {
    console.error(`${rpcName} error:`, error.message);
    return {
      ok: false,
      message: "Phone verified but profile sync failed. Please try again.",
      code: "PHONE_SYNC_FAILED",
    };
  }

  return { ok: true };
}

export async function writePhoneChangedAudit(
  service: SupabaseClient,
  args: {
    appType: PhoneChangeAppType;
    userId: string;
    profileId: string | null;
    phoneSuffix: string;
  },
): Promise<void> {
  const eventType = args.appType === "customer"
    ? "customer_phone_changed"
    : "driver_phone_changed";

  await service.rpc("ops_ingest_workflow_event", {
    p_event_type: eventType,
    p_app_name: args.appType === "customer" ? "customer_app" : "driver_app",
    p_severity: "info",
    p_customer_id: args.appType === "customer" ? args.userId : null,
    p_error_code: null,
    p_message: "Phone number changed after OTP verification",
    p_metadata: {
      phone_suffix: args.phoneSuffix,
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
      phone_suffix: args.phoneSuffix,
      verified_at: new Date().toISOString(),
    },
  });
}
