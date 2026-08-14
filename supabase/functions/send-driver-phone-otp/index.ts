import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  assertDriverPhoneOtpAllowed,
  type DriverPhoneOtpPurpose,
} from "../_shared/driverPhoneOtpPolicy.ts";
import { mapOtpErrorToMessage } from "../_shared/authErrorMessages.ts";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";
import { opsLog } from "../_shared/opsLog.ts";
import {
  parseBearerToken,
  type GoTrueAuthContext,
  goTrueUpdateUserPhone,
} from "../_shared/goTrueUserApi.ts";
import {
  phoneChangeErrorBody,
  phoneChangeSuccessBody,
  PHONE_CHANGE_ERROR,
  PHONE_CHANGE_ERROR_MESSAGES,
} from "../_shared/phoneChangeErrorCodes.ts";
import {
  clearPhoneChangePending,
  repairStaleAuthBeforeContactChange,
  sendPhoneChangeOtp,
  stagePhoneChange,
} from "../_shared/phoneChangeSsot.ts";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse(
        phoneChangeErrorBody(
          PHONE_CHANGE_ERROR.UNAUTHORIZED,
          PHONE_CHANGE_ERROR_MESSAGES.UNAUTHORIZED,
        ),
        401,
      );
    }

    const accessToken = parseBearerToken(authHeader);
    if (!accessToken) {
      return jsonResponse(
        phoneChangeErrorBody(
          PHONE_CHANGE_ERROR.UNAUTHORIZED,
          PHONE_CHANGE_ERROR_MESSAGES.UNAUTHORIZED,
        ),
        401,
      );
    }

    const authCtx: GoTrueAuthContext = {
      supabaseUrl,
      anonKey: supabaseAnonKey,
      accessToken,
    };

    const anon = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) {
      return jsonResponse(
        phoneChangeErrorBody(
          PHONE_CHANGE_ERROR.INVALID_SESSION,
          PHONE_CHANGE_ERROR_MESSAGES.INVALID_SESSION,
        ),
        401,
      );
    }

    const body = await req.json().catch(() => ({}));
    const purpose: DriverPhoneOtpPurpose = body.purpose === "change" ? "change" : "signup";
    const phoneRaw = purpose === "change"
      ? String(body.phone ?? "").trim()
      : String(
        body.phone ??
          user.phone ??
          user.user_metadata?.phone ??
          "",
      ).trim();

    if (purpose === "change" && !phoneRaw) {
      return jsonResponse(
        phoneChangeErrorBody(
          PHONE_CHANGE_ERROR.PHONE_REQUIRED,
          PHONE_CHANGE_ERROR_MESSAGES.PHONE_REQUIRED,
        ),
        400,
      );
    }

    const service = createClient(supabaseUrl, serviceKey);
    const guard = await assertDriverPhoneOtpAllowed(service, user.id, purpose, phoneRaw);
    if (!guard.ok) {
      console.info("DRIVER_PHONE_OTP_SEND_BLOCKED", JSON.stringify({
        user_id: user.id,
        purpose,
        code: guard.code,
      }));
      if (guard.code === "EMAIL_NOT_VERIFIED") {
        await opsLog(service, {
          level: "warn",
          source: "send-driver-phone-otp",
          app: "driver_app",
          message: guard.message,
          error_code: guard.code,
          driver_id: user.id,
          metadata: { purpose },
        });
      }
      return jsonResponse(phoneChangeErrorBody(guard.code, guard.message), guard.httpStatus);
    }

    if (purpose === "change") {
      await repairStaleAuthBeforeContactChange(service, user.id);

      const sent = await sendPhoneChangeOtp(authCtx, guard.normalizedPhone, {
        service,
        userId: user.id,
      });
      if (!sent.ok) {
        await clearPhoneChangePending(service, user.id, "driver");
        return jsonResponse(phoneChangeErrorBody(sent.code, sent.message), sent.httpStatus);
      }

      let staged = await stagePhoneChange(service, user.id, "driver", guard.normalizedPhone);
      if (!staged.ok) {
        await new Promise((r) => setTimeout(r, 200));
        staged = await stagePhoneChange(service, user.id, "driver", guard.normalizedPhone);
      }
      if (!staged.ok) {
        console.error("DRIVER_PHONE_OTP_STAGE_FAILED_AFTER_SEND", JSON.stringify({
          user_id: user.id,
          code: staged.code,
          message: staged.message,
        }));
        await clearPhoneChangePending(service, user.id, "driver");
        return jsonResponse(
          phoneChangeErrorBody(
            PHONE_CHANGE_ERROR.OTP_SEND_FAILED,
            PHONE_CHANGE_ERROR_MESSAGES.OTP_SEND_FAILED,
          ),
          500,
        );
      }
    } else {
      const dispatched = await goTrueUpdateUserPhone(authCtx, guard.normalizedPhone);

      if (!dispatched.ok) {
        console.error("send-driver-phone-otp signup GoTrue error:", dispatched.message);
        const mapped = mapOtpErrorToMessage({ message: dispatched.message }, "send");
        const code = mapped.code === "rate_limited"
          ? PHONE_CHANGE_ERROR.RATE_LIMITED
          : mapped.code === "duplicate_phone"
          ? PHONE_CHANGE_ERROR.PHONE_ALREADY_IN_USE
          : PHONE_CHANGE_ERROR.OTP_SEND_FAILED;
        const message = code in PHONE_CHANGE_ERROR_MESSAGES
          ? PHONE_CHANGE_ERROR_MESSAGES[code as keyof typeof PHONE_CHANGE_ERROR_MESSAGES]
          : mapped.message;
        const status = mapped.code === "rate_limited" ? 429 : 400;
        return jsonResponse(phoneChangeErrorBody(code, message), status);
      }
    }

    console.info("DRIVER_PHONE_OTP_SENT", JSON.stringify({
      user_id: user.id,
      purpose,
      phone_suffix: guard.normalizedPhone.slice(-4),
    }));

    return jsonResponse(phoneChangeSuccessBody(guard.normalizedPhone));
  } catch (err) {
    console.error("send-driver-phone-otp error:", err);
    return jsonResponse(
      phoneChangeErrorBody(
        PHONE_CHANGE_ERROR.OTP_SEND_FAILED,
        PHONE_CHANGE_ERROR_MESSAGES.OTP_SEND_FAILED,
      ),
      500,
    );
  }
});
