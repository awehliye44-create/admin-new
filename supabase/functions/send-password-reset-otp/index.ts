import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  AUTH_ERROR,
  mapAuthErrorToCustomerMessage,
} from "../_shared/authErrorMessages.ts";
import {
  isValidOnboardingPhone,
  normalizeOnboardingPhone,
} from "../_shared/onboardingValidation.ts";
import { phonesMatchForPasswordReset } from "../_shared/passwordResetSsot.ts";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type AuthAdminUser = {
  id: string;
  phone?: string | null;
  phone_confirmed_at?: string | null;
  raw_user_meta_data?: Record<string, unknown> | null;
};

async function findAuthUserByPhone(
  supabaseUrl: string,
  serviceKey: string,
  normalizedPhone: string,
): Promise<AuthAdminUser | null> {
  const variants = [
    normalizedPhone.replace(/^\+/, ""),
    normalizedPhone,
  ];

  for (const phoneFilter of variants) {
    const resp = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?per_page=1&filter=${encodeURIComponent(
        `phone.eq.${phoneFilter}`,
      )}`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      },
    );
    if (!resp.ok) continue;
    const json = await resp.json().catch(() => null) as { users?: AuthAdminUser[] } | null;
    const user = json?.users?.[0];
    if (user) return user;
  }

  return null;
}

function phonesMatch(a: string, b: string): boolean {
  return phonesMatchForPasswordReset(a, b);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json().catch(() => ({}));
    const phoneRaw = String(body.phone ?? "").trim();
    const appTypeRaw = String(body.app_type ?? "customer").toLowerCase();
    const appType = appTypeRaw === "driver" ? "driver" : "customer";
    const normalizedPhone = normalizeOnboardingPhone(phoneRaw);

    if (!isValidOnboardingPhone(normalizedPhone)) {
      return jsonResponse({
        error: "Please enter a valid phone number.",
        code: "PHONE_INVALID",
      }, 400);
    }

    const authUser = await findAuthUserByPhone(supabaseUrl, serviceKey, normalizedPhone);
    if (!authUser) {
      return jsonResponse({
        error: AUTH_ERROR.NO_ACCOUNT_PHONE,
        code: "ACCOUNT_NOT_FOUND",
      }, 404);
    }

    const userAppType = String(authUser.raw_user_meta_data?.app_type ?? "customer");
    if (userAppType !== appType) {
      return jsonResponse({
        error: AUTH_ERROR.NO_ACCOUNT_PHONE,
        code: "ACCOUNT_NOT_FOUND",
      }, 404);
    }

    if (!authUser.phone_confirmed_at) {
      return jsonResponse({
        error: AUTH_ERROR.PASSWORD_RESET_PHONE_UNAVAILABLE,
        code: "PHONE_NOT_VERIFIED",
      }, 403);
    }

    const registeredPhone = normalizeOnboardingPhone(String(authUser.phone ?? ""));
    if (!phonesMatch(registeredPhone, normalizedPhone)) {
      return jsonResponse({
        error: AUTH_ERROR.NO_ACCOUNT_PHONE,
        code: "ACCOUNT_NOT_FOUND",
      }, 404);
    }

    const anon = createClient(supabaseUrl, supabaseAnonKey);
    const { error: otpError } = await anon.auth.signInWithOtp({
      phone: registeredPhone,
      options: { shouldCreateUser: false },
    });

    if (otpError) {
      console.warn("send-password-reset-otp signInWithOtp error:", otpError.message);
      const message = mapAuthErrorToCustomerMessage(otpError, "password_reset_send");
      const status = /rate|too many/i.test(otpError.message ?? "") ? 429 : 400;
      return jsonResponse({ error: message, code: "OTP_SEND_FAILED" }, status);
    }

    console.info("PASSWORD_RESET_OTP_SENT", JSON.stringify({
      user_id: authUser.id,
      app_type: appType,
      phone_suffix: registeredPhone.slice(-4),
    }));

    return jsonResponse({ ok: true, phone: registeredPhone });
  } catch (err) {
    console.error("send-password-reset-otp error:", err);
    return jsonResponse({ error: AUTH_ERROR.OTP_SEND_FAILED }, 500);
  }
});
