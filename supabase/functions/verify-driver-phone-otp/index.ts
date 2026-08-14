import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  assertDriverPhoneOtpAllowed,
  type DriverPhoneOtpPurpose,
} from "../_shared/driverPhoneOtpPolicy.ts";
import { mapOtpErrorToMessage } from "../_shared/authErrorMessages.ts";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";
import {
  completePhoneChangeAfterVerify,
  writePhoneChangedAudit,
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
      return jsonResponse({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    }

    const anon = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Invalid session", code: "INVALID_SESSION" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const purpose: DriverPhoneOtpPurpose = body.purpose === "change" ? "change" : "signup";
    const phoneRaw = String(body.phone ?? "").trim();
    const token = String(body.token ?? "").trim();

    if (!token || token.length < 4) {
      return jsonResponse({ error: "Verification code is required.", code: "TOKEN_REQUIRED" }, 400);
    }

    const service = createClient(supabaseUrl, serviceKey);
    const guard = await assertDriverPhoneOtpAllowed(service, user.id, purpose, phoneRaw);
    if (!guard.ok) {
      console.info("DRIVER_PHONE_OTP_VERIFY_BLOCKED", JSON.stringify({
        user_id: user.id,
        purpose,
        code: guard.code,
      }));
      return jsonResponse({ error: guard.message, code: guard.code }, guard.httpStatus);
    }

    const otpType = purpose === "change" ? "phone_change" : "sms";
    const { error: verifyError } = await anon.auth.verifyOtp({
      phone: guard.normalizedPhone,
      token,
      type: otpType,
    });

    if (verifyError) {
      console.warn("verify-driver-phone-otp verifyOtp error:", verifyError.message);
      const mapped = mapOtpErrorToMessage(verifyError, "verify");
      return jsonResponse({
        error: mapped.message,
        code: "PHONE_OTP_VERIFY_FAILED",
      }, 400);
    }

    if (purpose === "change") {
      const completed = await completePhoneChangeAfterVerify(service, user.id, "driver");
      if (!completed.ok) {
        return jsonResponse({ error: completed.message, code: completed.code }, 500);
      }

      const { data: driverRow } = await service
        .from("drivers")
        .select("id")
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();

      await writePhoneChangedAudit(service, {
        appType: "driver",
        userId: user.id,
        profileId: driverRow?.id ?? null,
        phoneSuffix: guard.normalizedPhone.slice(-4),
      });
    } else {
      const { error: syncError } = await service.rpc("sync_driver_phone_verification", {
        _user_id: user.id,
      });
      if (syncError) {
        console.error("verify-driver-phone-otp signup sync error:", syncError);
        return jsonResponse({
          error: "Phone verified but profile sync failed. Please try again.",
          code: "PHONE_SYNC_FAILED",
        }, 500);
      }
    }

    console.info("DRIVER_PHONE_OTP_VERIFIED", JSON.stringify({
      user_id: user.id,
      purpose,
      phone_suffix: guard.normalizedPhone.slice(-4),
    }));

    return jsonResponse({ ok: true, phone: guard.normalizedPhone });
  } catch (err) {
    console.error("verify-driver-phone-otp error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
