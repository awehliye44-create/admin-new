import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  nativeAppHandoffLocation,
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

function nativeAppHandoffResponse(
  req: Request,
  appType: VerificationAppType,
  token: string,
  error?: string,
): Response {
  return redirectResponse(nativeAppHandoffLocation({
    appType,
    path: "auth/verify-email-change",
    token,
    error,
    userAgent: req.headers.get("user-agent"),
  }));
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const token = String(url.searchParams.get("token") ?? "").trim();
  const appType = resolveVerificationAppType(url.searchParams.get("app"));

  if (!token) {
    return nativeAppHandoffResponse(req, appType, "", "missing_token");
  }

  const validation = await validateEmailChangeLink(token, appType);
  if (!validation.ok) {
    const openToken =
      validation.reason === "missing_token" ||
      validation.reason === "invalid_token" ||
      validation.reason === "expired_token"
        ? ""
        : token;
    return nativeAppHandoffResponse(req, appType, openToken, validation.reason);
  }

  return nativeAppHandoffResponse(req, appType, token);
});
