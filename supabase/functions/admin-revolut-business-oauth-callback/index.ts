/**
 * Public Revolut Business OAuth redirect target (backend-only).
 * Accepts ?code=&state=&error=&error_description=
 * Exchanges code server-side and redirects the browser to the admin SPA.
 * Never returns tokens, JWTs, or private key material in the body or Location URL.
 * Never executes payouts, transfers, counterparty, or wallet mutations.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  consumeOAuthPendingState,
  exchangeRevolutBusinessAuthorizationCode,
  isLivePayoutExecutionEnabled,
  persistRevolutBusinessTokens,
  probeEdgeEgressPublicIp,
} from "../_shared/revolutBusinessOAuthSSOT.ts";

const ADMIN_SPA_SUCCESS =
  "https://adminonecab.net/payment-providers?revolut_business=connected&message=" +
  encodeURIComponent("Revolut Business connected. Tokens stored securely. No payments were made.");
const ADMIN_SPA_ERROR_BASE =
  "https://adminonecab.net/payment-providers?revolut_business=error";

const SAFE_REASON = new Set([
  "missing_code",
  "missing_state",
  "invalid_state",
  "state_expired",
  "state_mismatch",
  "state_not_found",
  "state_consumed",
  "missing_pending_state",
  "invalid_pending_state",
  "exchange_failed",
  "revolut_business_relay_unreachable",
  "revolut_business_relay_not_configured",
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "server_error",
  "temporarily_unavailable",
  "authorization_failed",
]);

function sanitizeReason(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .slice(0, 64);
  if (!cleaned) return "authorization_failed";
  if (/access_token|refresh_token|bearer|private_key|assertion|jwt/.test(cleaned)) {
    return "authorization_failed";
  }
  if (SAFE_REASON.has(cleaned)) return cleaned;
  // Map common Revolut/OAuth errors; otherwise keep a short opaque code.
  if (cleaned.includes("access_denied")) return "access_denied";
  if (cleaned.includes("expired")) return "state_expired";
  return cleaned.slice(0, 48) || "authorization_failed";
}

const CORS_JSON = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, accept",
  "Cache-Control": "no-store",
};

function wantsJson(req: Request, url: URL): boolean {
  if (url.searchParams.get("format") === "json") return true;
  const accept = (req.headers.get("Accept") ?? "").toLowerCase();
  return accept.includes("application/json");
}

function redirect(to: string, asJson: boolean): Response {
  if (asJson) {
    return new Response(JSON.stringify({ ok: to.includes("revolut_business=connected"), redirect_to: to }), {
      status: 200,
      headers: { ...CORS_JSON, "Content-Type": "application/json" },
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: to,
      "Cache-Control": "no-store",
    },
  });
}

function errorRedirect(reason: string, asJson: boolean): Response {
  return redirect(
    `${ADMIN_SPA_ERROR_BASE}&reason=${encodeURIComponent(sanitizeReason(reason))}`,
    asJson,
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_JSON });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...CORS_JSON, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const asJson = wantsJson(req, url);
  const code = (url.searchParams.get("code") ?? "").trim();
  const state = (url.searchParams.get("state") ?? "").trim();
  const oauthError = (url.searchParams.get("error") ?? "").trim();
  const oauthErrorDescription = (url.searchParams.get("error_description") ?? "").trim();

  if (oauthError) {
    return errorRedirect(oauthErrorDescription || oauthError, asJson);
  }

  // Health/reachability probe without exchanging.
  if (!code && url.searchParams.get("probe") === "1") {
    const egress = await probeEdgeEgressPublicIp();
    return new Response(JSON.stringify({
      ok: true,
      reachable: true,
      surface: "admin-revolut-business-oauth-callback",
      accepts: "GET ?code=&state=&error=&error_description=",
      payouts: false,
      live_payout_execution_enabled: isLivePayoutExecutionEnabled(),
      egress_public_ip: egress,
      egress_ip_fixed_proven: false,
      whitelist_recommendation: "DO_NOT_WHITELIST_YET",
    }), {
      headers: { ...CORS_JSON, "Content-Type": "application/json" },
    });
  }

  if (!code) {
    return errorRedirect("missing_code", asJson);
  }

  if (!state) {
    return errorRedirect("missing_state", asJson);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const stateCheck = await consumeOAuthPendingState(supabase, state);
    if (!stateCheck.ok) {
      return errorRedirect(stateCheck.reason || "invalid_state", asJson);
    }

    const tokens = await exchangeRevolutBusinessAuthorizationCode(code);
    await persistRevolutBusinessTokens({ supabase, tokens, updatedBy: null });
    return redirect(ADMIN_SPA_SUCCESS, asJson);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "exchange_failed";
    console.error("[admin-revolut-business-oauth-callback]", reason);
    if (/relay_unreachable|relay_not_configured/i.test(reason)) {
      return errorRedirect(reason, asJson);
    }
    return errorRedirect("exchange_failed", asJson);
  }
});
