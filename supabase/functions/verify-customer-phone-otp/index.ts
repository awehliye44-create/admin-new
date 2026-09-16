import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  assertCustomerPhoneOtpAllowed,
  type CustomerPhoneOtpPurpose,
} from "../_shared/customerPhoneOtpPolicy.ts";
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
    const purpose: CustomerPhoneOtpPurpose = body.purpose === "change" ? "change" : "signup";
    const phoneRaw = String(body.phone ?? "").trim();
    const token = String(body.token ?? "").trim();

    if (!token || token.length < 4) {
      return jsonResponse({ error: "Verification code is required.", code: "TOKEN_REQUIRED" }, 400);
    }

    const service = createClient(supabaseUrl, serviceKey);
    const guard = await assertCustomerPhoneOtpAllowed(service, user.id, purpose, phoneRaw);
    if (!guard.ok) {
      console.info("CUSTOMER_PHONE_OTP_VERIFY_BLOCKED", JSON.stringify({
        user_id: user.id,
        purpose,
        code: guard.code,
      }));
      return jsonResponse({ error: guard.message, code: guard.code }, guard.httpStatus);
    }

    // For change purpose: verify pending_phone_change exists and is not expired BEFORE calling
    // verifyOtp. Without this guard, a missing/expired pending record falls through to
    // completePhoneChangeAfterVerify which raises 'no pending phone change' → PHONE_SYNC_FAILED.
    // The spec requires PENDING_PHONE_NOT_FOUND / VERIFICATION_EXPIRED as distinct codes.
    if (purpose === "change") {
      const { data: pendingRow } = await service
        .from("customers")
        .select("pending_phone_change, pending_phone_change_expires_at")
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();

      if (!pendingRow?.pending_phone_change) {
        return jsonResponse({
          error: "No phone change request found. Please request a new verification code.",
          code: "PENDING_PHONE_NOT_FOUND",
        }, 404);
      }

      const expiresAt = pendingRow.pending_phone_change_expires_at
        ? new Date(pendingRow.pending_phone_change_expires_at).getTime()
        : NaN;
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        return jsonResponse({
          error: "Your phone change request has expired. Please request a new verification code.",
          code: "VERIFICATION_EXPIRED",
        }, 410);
      }
    }

    // Signup OTP is dispatched via GoTrue updateUser(phone) → phone_change,
    // not signInWithOtp → sms. Change uses the same phone_change type.
    const otpType = "phone_change";
    const { error: verifyError } = await anon.auth.verifyOtp({
      phone: guard.normalizedPhone,
      token,
      type: otpType,
    });

    if (verifyError) {
      console.warn("verify-customer-phone-otp verifyOtp error:", verifyError.message);
      const mapped = mapOtpErrorToMessage(verifyError, "verify");
      return jsonResponse({
        error: mapped.message,
        code: "PHONE_OTP_VERIFY_FAILED",
      }, 400);
    }

    if (purpose === "change") {
      const completed = await completePhoneChangeAfterVerify(service, user.id, "customer");
      if (!completed.ok) {
        return jsonResponse({ error: completed.message, code: completed.code }, 500);
      }

      const { data: customerRow } = await service
        .from("customers")
        .select("id")
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();

      await writePhoneChangedAudit(service, {
        appType: "customer",
        userId: user.id,
        profileId: customerRow?.id ?? null,
        phoneSuffix: guard.normalizedPhone.slice(-4),
      });
    } else {
      // Signup: activate customers row from pending signup (idempotent).
      // Phone is the only gate — finalize_customer_onboarding does not require email.
      const { data: customerId, error: finalizeError } = await service.rpc(
        "finalize_customer_onboarding",
        { _user_id: user.id },
      );
      if (finalizeError) {
        console.error("verify-customer-phone-otp finalize error:", finalizeError);
        return jsonResponse({
          error: "Phone verified but account activation failed. Please try again.",
          code: "CUSTOMER_FINALIZE_FAILED",
        }, 500);
      }

      const { error: syncError } = await service.rpc("sync_customer_phone_verification", {
        _user_id: user.id,
      });
      if (syncError) {
        // Row already created by finalize — sync is best-effort mirror.
        console.warn("verify-customer-phone-otp signup sync warn:", syncError.message);
      }

      console.info("CUSTOMER_PHONE_OTP_VERIFIED", JSON.stringify({
        user_id: user.id,
        purpose,
        phone_suffix: guard.normalizedPhone.slice(-4),
        customer_id: customerId ?? null,
      }));

      return jsonResponse({
        ok: true,
        phone: guard.normalizedPhone,
        customer_id: customerId ?? null,
      });
    }

    console.info("CUSTOMER_PHONE_OTP_VERIFIED", JSON.stringify({
      user_id: user.id,
      purpose,
      phone_suffix: guard.normalizedPhone.slice(-4),
    }));

    return jsonResponse({ ok: true, phone: guard.normalizedPhone });
  } catch (err) {
    console.error("verify-customer-phone-otp error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
