import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  assertCustomerPhoneOtpAllowed,
  type CustomerPhoneOtpPurpose,
} from "../_shared/customerPhoneOtpPolicy.ts";
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
    const purpose: CustomerPhoneOtpPurpose = body.purpose === "change" ? "change" : "signup";
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
    const guard = await assertCustomerPhoneOtpAllowed(service, user.id, purpose, phoneRaw);
    if (!guard.ok) {
      console.info("CUSTOMER_PHONE_OTP_SEND_BLOCKED", JSON.stringify({
        user_id: user.id,
        purpose,
        code: guard.code,
      }));
      if (guard.code === "EMAIL_NOT_VERIFIED") {
        await opsLog(service, {
          level: "warn",
          source: "send-customer-phone-otp",
          app: "customer_app",
          message: guard.message,
          error_code: guard.code,
          customer_id: user.id,
          metadata: { purpose },
        });
        await service.rpc("ops_ingest_workflow_event", {
          p_event_type: "customer_phone_verification_order_violation",
          p_app_name: "customer_app",
          p_severity: "warning",
          p_customer_id: null,
          p_error_code: guard.code,
          p_message: guard.message,
          p_metadata: { purpose, user_id: user.id },
          p_create_alert: true,
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
        await clearPhoneChangePending(service, user.id, "customer");
        return jsonResponse(phoneChangeErrorBody(sent.code, sent.message), sent.httpStatus);
      }

      const staged = await stagePhoneChange(service, user.id, "customer", guard.normalizedPhone);
      if (!staged.ok) {
        await clearPhoneChangePending(service, user.id, "customer");
        return jsonResponse(phoneChangeErrorBody(staged.code, staged.message), 500);
      }
    } else {
      const dispatched = await goTrueUpdateUserPhone(authCtx, guard.normalizedPhone);

      if (!dispatched.ok) {
        console.error("send-customer-phone-otp signup GoTrue error:", dispatched.message);
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

    console.info("CUSTOMER_PHONE_OTP_SENT", JSON.stringify({
      user_id: user.id,
      purpose,
      phone_suffix: guard.normalizedPhone.slice(-4),
    }));

    return jsonResponse(phoneChangeSuccessBody(guard.normalizedPhone));
  } catch (err) {
    console.error("send-customer-phone-otp error:", err);
    return jsonResponse(
      phoneChangeErrorBody(
        PHONE_CHANGE_ERROR.OTP_SEND_FAILED,
        PHONE_CHANGE_ERROR_MESSAGES.OTP_SEND_FAILED,
      ),
      500,
    );
  }
});
