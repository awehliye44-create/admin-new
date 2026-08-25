/**
 * Step 9.4B — Temporary refresh-only Revolut Business OAuth.
 *
 * DO_NOT_REDEPLOY_WITHOUT_EXPLICIT_CREDENTIAL_RECOVERY_APPROVAL
 *
 * POST {} — Admin JWT or service_role.
 * Never /pay, payee, transfer, payout finalize, or wallet writers.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { REVOLUT_BUSINESS_OAUTH_SCOPE } from "../../../shared/revolutBusinessOAuthSSOT.ts";
import {
  persistRefreshOnlyTokens,
  readRefreshOnlyPrivateKey,
  readRefreshOnlyVaultTokens,
  refreshOnlyBusinessAccessToken,
} from "../_shared/revolutBusinessTokenRefreshCore.ts";
import {
  buildSafeRefreshResponse,
  classifyRefreshHttpFailure,
  fingerprintSecret,
  parseScopeTokens,
  resolveRefreshTokenToStore,
  shouldPersistRefreshAgainstConcurrentVault,
  validateBusinessOAuthTokenResponse,
} from "../_shared/revolutBusinessOAuthRefreshOnlySSOT.ts";
import { isRefreshOnlyRelayConfigured } from "../_shared/revolutBusinessRefreshOnlyRelay.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function decodeJwtRole(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const parsed = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof parsed?.role === "string" ? parsed.role : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ success: false, error: "method_not_allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ success: false, error: "server_misconfigured" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) {
    return json({ success: false, error: "unauthorized" }, 401);
  }
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return json({ success: false, error: "unauthorized" }, 401);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const jwtRole = decodeJwtRole(bearer);
  let actor: "service_role" | "admin" | null = null;
  if (jwtRole === "service_role") {
    actor = "service_role";
  } else {
    const { data: { user }, error } = await supabase.auth.getUser(bearer);
    if (error || !user) {
      return json({ success: false, error: "unauthorized" }, 401);
    }
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) {
      return json({ success: false, error: "forbidden", message: "Admin access required" }, 403);
    }
    actor = "admin";
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  for (const k of Object.keys(body)) {
    if (/token|secret|key|assertion|password/i.test(k)) {
      return json({
        success: false,
        error: "invalid_body",
        message: "Do not send credentials in the request body",
      }, 400);
    }
  }
  const environment = String(body.environment ?? "live").trim().toLowerCase();
  if (environment !== "live") {
    return json({
      success: false,
      error: "invalid_environment",
      message: "live Business environment only",
    }, 400);
  }

  if (!isRefreshOnlyRelayConfigured()) {
    return json({
      success: false,
      error: "relay_not_configured",
      message: "REVOLUT_BUSINESS_RELAY_URL + SHARED_SECRET required",
    }, 503);
  }

  const privateKeyPem = readRefreshOnlyPrivateKey();
  if (!privateKeyPem) {
    return json({
      success: false,
      error: "private_key_missing",
      message: "REVOLUT_BUSINESS_PRIVATE_KEY Edge secret missing",
    }, 503);
  }

  const refreshStartedAtMs = Date.now();
  const vaultBefore = await readRefreshOnlyVaultTokens(supabase);
  if (!vaultBefore.refresh_token) {
    return json({
      success: false,
      error: "REVOLUT_BUSINESS_REAUTHORISATION_REQUIRED",
      message: "No refresh token in Vault — interactive Business OAuth required",
      write: false,
    }, 409);
  }

  const accessFpBefore = await fingerprintSecret(vaultBefore.access_token);
  const refreshFpBefore = await fingerprintSecret(vaultBefore.refresh_token);
  const privateKeyFp = await fingerprintSecret(privateKeyPem);
  const priorScopes = vaultBefore.scopes_granted?.length
    ? vaultBefore.scopes_granted
    : parseScopeTokens(REVOLUT_BUSINESS_OAUTH_SCOPE);

  let providerTokens: Awaited<ReturnType<typeof refreshOnlyBusinessAccessToken>>;
  try {
    providerTokens = await refreshOnlyBusinessAccessToken(vaultBefore.refresh_token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const statusMatch = msg.match(/token_refresh_failed_(\d+)/);
    const status = statusMatch
      ? Number(statusMatch[1])
      : (/invalid_grant|expired|revoked/i.test(msg) ? 401 : 502);
    const classified = classifyRefreshHttpFailure(status, {
      error: msg,
      error_description: msg,
    });
    return json({
      success: false,
      error: classified.code,
      message: classified.message,
      write: false,
      actor,
      revolut_pay_called: false,
    }, classified.code === "REVOLUT_BUSINESS_REAUTHORISATION_REQUIRED" ? 409 : 502);
  }

  const validated = validateBusinessOAuthTokenResponse({
    access_token: providerTokens.access_token,
    token_type: providerTokens.token_type ?? "bearer",
    expires_in: providerTokens.expires_in,
    refresh_token: providerTokens.refresh_token,
    scope: providerTokens.scope,
  }, {
    requireScope: true,
    priorScopeTokens: priorScopes,
  });

  if (!validated.ok) {
    return json({
      success: false,
      error: "token_response_invalid",
      code: validated.code,
      message: validated.message,
      write: false,
      revolut_pay_called: false,
    }, 502);
  }

  const vaultMid = await readRefreshOnlyVaultTokens(supabase);
  const concurrent = shouldPersistRefreshAgainstConcurrentVault({
    refreshStartedAtMs,
    vaultExpiresAtIso: vaultMid.expires_at,
  });
  if (!concurrent.persist) {
    return json({
      success: false,
      error: "stale_refresh_aborted",
      message: concurrent.reason,
      write: false,
      revolut_pay_called: false,
    }, 409);
  }

  const refreshPlan = resolveRefreshTokenToStore({
    providerRefreshToken: validated.refresh_token,
    existingRefreshToken: vaultBefore.refresh_token,
  });

  let persisted: { expires_at: string; scopes_granted: string[] };
  try {
    persisted = await persistRefreshOnlyTokens({
      supabase,
      tokens: {
        access_token: validated.access_token,
        token_type: validated.token_type,
        expires_in: validated.expires_in,
        refresh_token: refreshPlan.refresh_token,
        scope: validated.scope ?? undefined,
      },
      // payment_provider_vault.updated_by is uuid — never pass a label string
      updatedBy: null,
    });
  } catch (err) {
    const msg = typeof err === "object" && err && "message" in err
      ? String((err as { message: unknown }).message)
      : (err instanceof Error ? err.message : "vault_write_failed");
    return json({
      success: false,
      error: "vault_persist_failed",
      message: msg.slice(0, 160),
      write: false,
      revolut_pay_called: false,
    }, 500);
  }

  const accessFpAfter = await fingerprintSecret(validated.access_token);
  const refreshFpAfter = await fingerprintSecret(refreshPlan.refresh_token);
  if (!accessFpAfter || !refreshFpAfter) {
    return json({
      success: false,
      error: "fingerprint_failed",
      message: "Could not fingerprint persisted tokens",
      write: false,
    }, 500);
  }

  const scopeTokens = persisted.scopes_granted.length
    ? persisted.scopes_granted
    : validated.scope_tokens;

  return json(buildSafeRefreshResponse({
    environment: "live",
    token_type: validated.token_type,
    expires_at: persisted.expires_at,
    scope_tokens: scopeTokens,
    access_before: accessFpBefore,
    access_after: accessFpAfter,
    refresh_before: refreshFpBefore,
    refresh_after: refreshFpAfter,
    refresh_rotated: refreshPlan.rotated,
    private_key: privateKeyFp,
  }));
});
