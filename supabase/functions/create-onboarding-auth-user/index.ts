import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { validateDriverSignupAddressInput } from "../_shared/driverSignupAddressValidation.ts";
import {
  onboardingErrorMessage,
  validateOnboardingSignup,
} from "../_shared/onboardingValidation.ts";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";

function logEvent(event: string, payload: Record<string, unknown>) {
  console.log(event, JSON.stringify(payload));
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isDuplicateAuthError(message: string): boolean {
  const msg = message.toLowerCase();
  return msg.includes("already") || msg.includes("registered") || msg.includes("exists");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json().catch(() => ({}));
    const appType = body.app_type === "driver" ? "driver" : "customer";

    // Customer Create Account collects a single full name; split for Auth metadata.
    let firstNameRaw = String(body.first_name ?? body.firstName ?? "");
    let lastNameRaw = String(body.last_name ?? body.lastName ?? "");
    const fullNameRaw = String(body.full_name ?? body.fullName ?? "").trim();
    if (fullNameRaw && !firstNameRaw.trim()) {
      const parts = fullNameRaw.split(/\s+/).filter(Boolean);
      firstNameRaw = parts[0] ?? "";
      lastNameRaw = parts.slice(1).join(" ");
      // Single-token names still need a last_name for shared validators / customers row.
      if (!lastNameRaw) lastNameRaw = firstNameRaw;
    }

    const validation = validateOnboardingSignup({
      firstName: firstNameRaw,
      lastName: lastNameRaw,
      email: String(body.email ?? ""),
      phone: String(body.phone ?? ""),
      password: String(body.password ?? ""),
    });

    if (!validation.ok) {
      return jsonResponse({ error: onboardingErrorMessage(validation.errors[0]) }, 400);
    }

    const { firstName, lastName, email, phone } = validation.normalized;
    const password = String(body.password ?? "");
    // Customer: no email-verification gate — confirm Auth email without GoTrue mailer.
    // Driver: leave unconfirmed so Resend onboarding verification can run.
    const confirmEmailOnCreate = appType === "customer";

    let addressMetadata: Record<string, string> = {};
    if (appType === "driver") {
      const addressValidation = validateDriverSignupAddressInput({
        residential_address: body.residential_address,
        residentialAddress: body.residentialAddress,
        postcode: body.postcode,
        city: body.city,
        country: body.country,
        country_code: body.country_code,
        countryCode: body.countryCode,
      });
      if (!addressValidation.ok) {
        logEvent("DRIVER_SIGNUP_ADDRESS_MISSING_BLOCKED", {
          reason: addressValidation.error,
        });
        return jsonResponse({ error: addressValidation.error }, 400);
      }
      addressMetadata = {
        driver_signup_residential_address: addressValidation.normalized.residentialAddress,
        driver_signup_postcode: addressValidation.normalized.postcode,
        driver_signup_city: addressValidation.normalized.city,
        driver_signup_country: addressValidation.normalized.country,
      };
      logEvent("DRIVER_SIGNUP_ADDRESS_SAVED", {
        city: addressValidation.normalized.city,
        country: addressValidation.normalized.country,
      });
    }

    const service = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: reclaimResult, error: reclaimErr } = await service.rpc(
      "reclaim_stale_onboarding_auth_user",
      { p_email: email },
    );
    if (reclaimErr) {
      console.warn("create-onboarding-auth-user reclaim_stale_onboarding_auth_user:", reclaimErr);
    } else if ((reclaimResult as { reclaimed?: boolean } | null)?.reclaimed) {
      logEvent("STALE_ONBOARDING_AUTH_USER_RECLAIMED", {
        email,
        user_id: (reclaimResult as { user_id?: string }).user_id ?? null,
      });
    }

    const { data: identity, error: identityErr } = await service.rpc("check_identity_exists", {
      p_phone: phone,
      p_email: email,
    });
    if (!identityErr) {
      const row = identity as { phone_exists?: boolean; email_exists?: boolean } | null;
      if (row?.email_exists) {
        return jsonResponse({ error: "An account with this email already exists. Please sign in instead." }, 409);
      }
      if (row?.phone_exists) {
        return jsonResponse({ error: "This phone number is already registered." }, 409);
      }
    }

    const userMetadata = {
      app_type: appType,
      first_name: firstName,
      last_name: lastName,
      phone,
      ...addressMetadata,
    };

    const { data: created, error: createError } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: confirmEmailOnCreate,
      user_metadata: userMetadata,
    });

    let createdUser = created;
    let finalCreateError = createError;

    if ((finalCreateError || !createdUser.user?.id) && isDuplicateAuthError(finalCreateError?.message ?? "")) {
      const { data: retryReclaim } = await service.rpc("reclaim_stale_onboarding_auth_user", { p_email: email });
      if ((retryReclaim as { reclaimed?: boolean } | null)?.reclaimed) {
        logEvent("STALE_ONBOARDING_AUTH_USER_RECLAIMED_ON_CREATE_RETRY", {
          email,
          user_id: (retryReclaim as { user_id?: string }).user_id ?? null,
        });
        const retry = await service.auth.admin.createUser({
          email,
          password,
          email_confirm: confirmEmailOnCreate,
          user_metadata: userMetadata,
        });
        createdUser = retry.data;
        finalCreateError = retry.error;
      }
    }

    if (finalCreateError || !createdUser.user?.id) {
      const msg = finalCreateError?.message ?? "createUser failed";
      if (isDuplicateAuthError(msg)) {
        return jsonResponse({ error: "An account with this email already exists. Please sign in instead." }, 409);
      }
      console.error("create-onboarding-auth-user createUser error:", finalCreateError);
      return jsonResponse({ error: "Could not create account. Please try again." }, 500);
    }

    const userId = createdUser.user.id;

    if (appType === "customer") {
      const { error: pendingError } = await service.rpc("upsert_pending_customer_signup", {
        p_user_id: userId,
        p_first_name: firstName,
        p_last_name: lastName,
        p_email: email,
        p_phone: phone,
        p_signup_source: "customer_app",
      });
      if (pendingError) {
        console.error("create-onboarding-auth-user upsert_pending_customer_signup error:", pendingError);
        await service.auth.admin.deleteUser(userId).catch(() => undefined);
        return jsonResponse({ error: "Could not start signup. Please try again." }, 500);
      }
      // Match Customer product: no email-verification gate.
      const { error: emailVerifiedErr } = await service
        .from("customers")
        .update({ email_verified: true })
        .eq("user_id", userId);
      if (emailVerifiedErr) {
        console.warn(
          "create-onboarding-auth-user customers.email_verified:",
          emailVerifiedErr.message,
        );
      }
      logEvent("CUSTOMER_SIGNUP_PENDING_RECORD_CREATED", {
        user_id: userId,
        status: "pending",
        email_confirm_on_create: true,
      });
    }

    const anon = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let sessionData;
    const { data: passwordSession, error: passwordSessionError } = await anon.auth.signInWithPassword({
      email,
      password,
    });

    if (!passwordSessionError && passwordSession.session) {
      sessionData = passwordSession;
    } else {
      const { data: linkData, error: linkError } = await service.auth.admin.generateLink({
        type: "magiclink",
        email,
      });
      if (linkError || !linkData?.properties?.hashed_token) {
        console.error("create-onboarding-auth-user generateLink error:", linkError);
        await service.auth.admin.deleteUser(userId).catch(() => undefined);
        return jsonResponse({ error: "Could not start signup session. Please try again." }, 500);
      }

      const { data: otpSession, error: otpSessionError } = await anon.auth.verifyOtp({
        type: "magiclink",
        token_hash: linkData.properties.hashed_token,
      });
      if (otpSessionError || !otpSession.session) {
        console.error("create-onboarding-auth-user verifyOtp error:", otpSessionError);
        await service.auth.admin.deleteUser(userId).catch(() => undefined);
        return jsonResponse({ error: "Could not start signup session. Please try again." }, 500);
      }
      sessionData = otpSession;

      // Driver only: keep Auth email unconfirmed so Resend onboarding verify runs.
      // Customer was created with email_confirm:true — do not undo that.
      if (!confirmEmailOnCreate) {
        const { error: resetErr } = await service.rpc("reset_auth_user_email_unconfirmed", {
          _user_id: userId,
        });
        if (resetErr) {
          console.error("create-onboarding-auth-user reset email unconfirmed error:", resetErr);
        }
      }
    }

    if (!sessionData.session) {
      await service.auth.admin.deleteUser(userId).catch(() => undefined);
      return jsonResponse({ error: "Could not start signup session. Please try again." }, 500);
    }

    logEvent(appType === "driver" ? "DRIVER_SIGNUP_AUTH_CREATED" : "CUSTOMER_SIGNUP_AUTH_CREATED", {
      user_id: userId,
      email,
      email_confirm_on_create: confirmEmailOnCreate,
      email_confirm_reset: !confirmEmailOnCreate,
      method: "create_user_sign_in",
    });

    return jsonResponse({
      ok: true,
      session: {
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
        expires_in: sessionData.session.expires_in,
        expires_at: sessionData.session.expires_at,
      },
      user_id: userId,
    });
  } catch (err) {
    console.error("create-onboarding-auth-user error:", err);
    return jsonResponse({ error: "Could not create account. Please try again." }, 500);
  }
});
