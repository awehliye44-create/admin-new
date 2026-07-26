import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  accountEmailChangeDeepLink,
  accountEmailChangeWebUrl,
  resolveVerificationAppBaseUrl,
  resolveVerificationAppType,
  type VerificationAppType,
} from "../_shared/accountEmailVerification.ts";
import {
  findPendingEmailChangeRequest,
  isLatestPendingEmailChangeRequest,
} from "../_shared/emailChangePolicy.ts";
import { isVerificationTokenExpired } from "../_shared/emailVerificationPolicy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: {
      ...corsHeaders,
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

type LinkValidation =
  | { ok: true }
  | { ok: false; reason: "missing_token" | "invalid_token" | "expired_token" | "already_used" };

async function validateEmailChangeLink(
  token: string,
  appType: VerificationAppType,
): Promise<LinkValidation> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, reason: "invalid_token" };
  }

  const service = createClient(supabaseUrl, serviceKey);
  const row = await findPendingEmailChangeRequest(
    service,
    token,
    appType === "driver" ? "driver" : "customer",
  );

  if (!row) {
    return { ok: false, reason: "invalid_token" };
  }

  if (row.status === "verified" || row.verified_at) {
    return { ok: false, reason: "already_used" };
  }

  if (row.status !== "pending") {
    return { ok: false, reason: "invalid_token" };
  }

  if (isVerificationTokenExpired(row.expires_at)) {
    return { ok: false, reason: "expired_token" };
  }

  if (!(await isLatestPendingEmailChangeRequest(service, row))) {
    return { ok: false, reason: "invalid_token" };
  }

  return { ok: true };
}

function webFallbackUrl(
  appBaseUrl: string,
  appType: VerificationAppType,
  token: string | null,
  reason?: string,
): string {
  const base = appBaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ app: appType });
  if (token && reason !== "missing_token" && reason !== "invalid_token" && reason !== "expired_token") {
    params.set("token", token);
  }
  if (reason === "already_used") {
    params.set("error", "already_used");
  } else if (reason === "expired_token") {
    params.set("error", "expired_token");
  } else if (reason) {
    params.set("error", reason);
  }
  return `${base}/auth/verify-email-change?${params.toString()}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const token = String(url.searchParams.get("token") ?? "").trim();
  const appType = resolveVerificationAppType(url.searchParams.get("app"));
  const appBaseUrl = resolveVerificationAppBaseUrl(appType, {
    customerAppUrl: Deno.env.get("CUSTOMER_APP_URL"),
    driverAppUrl: Deno.env.get("DRIVER_APP_URL"),
    adminAppUrl: Deno.env.get("ADMIN_APP_URL"),
    appUrl: Deno.env.get("APP_URL"),
  });

  if (!token) {
    return redirectResponse(webFallbackUrl(appBaseUrl, appType, null, "missing_token"));
  }

  const validation = await validateEmailChangeLink(token, appType);
  if (!validation.ok) {
    return redirectResponse(
      webFallbackUrl(appBaseUrl, appType, token, validation.reason),
    );
  }

  return redirectResponse(accountEmailChangeDeepLink(appType, token));
});
