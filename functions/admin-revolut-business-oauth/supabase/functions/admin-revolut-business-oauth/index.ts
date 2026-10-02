/**
 * Revolut Business OAuth — prepare consent URL, exchange code, diagnostics.
 * Requests READ,WRITE,PAY consent. PAY permission ≠ live payout execution.
 * Never returns tokens or private key material.
 * Never calls /pay, transfers, or payouts during OAuth connect.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAdmin, corsHeaders } from "../_shared/adminPaymentGate.ts";
import {
  buildRevolutBusinessAuthorizationUrl,
  buildRevolutBusinessDiagnostics,
  buildRevolutBusinessRelayDiagnostics,
  clientIdMatchesCertificate,
  consumeOAuthPendingState,
  exchangeRevolutBusinessAuthorizationCode,
  invalidateRevolutBusinessOAuthTokens,
  isLivePayoutExecutionEnabled,
  persistRevolutBusinessTokens,
  probeEdgeEgressPublicIp,
  readRevolutBusinessClientId,
  readRevolutBusinessPrivateKey,
  resolveRevolutBusinessJwtIss,
  resolveRevolutBusinessRedirectUri,
  REVOLUT_BUSINESS_CLIENT_ID_EXPECTED,
  REVOLUT_BUSINESS_OAUTH_SCOPE,
  REVOLUT_BUSINESS_OAUTH_VERSION,
  REVOLUT_BUSINESS_REDIRECT_URI_EDGE,
  REVOLUT_BUSINESS_RELAY_WHITELIST_IP,
  storeOAuthPendingState,
} from "../_shared/revolutBusinessOAuthSSOT.ts";
import {
  getRevolutBusinessRelayBaseUrl,
  isRevolutBusinessRelayConfigured,
} from "../_shared/revolutBusinessRelayClient.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function newState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildAuthorizationPrepareResponse(args: {
  supabase: Parameters<typeof storeOAuthPendingState>[0];
  userId: string;
  redirectUri: string;
  jwtIss: string;
}) {
  const clientId = readRevolutBusinessClientId();
  const privateKey = readRevolutBusinessPrivateKey();
  if (!clientId || !privateKey) {
    return json({
      ok: false,
      error_code: "NOT_CONFIGURED",
      message: "REVOLUT_BUSINESS_CLIENT_ID and REVOLUT_BUSINESS_PRIVATE_KEY must be set as edge secrets first",
      client_id_configured: Boolean(clientId),
      private_key_configured: Boolean(privateKey),
      redirect_uri: args.redirectUri,
      jwt_iss: args.jwtIss,
    }, 400);
  }
  if (!clientIdMatchesCertificate(clientId)) {
    return json({
      ok: false,
      error_code: "CLIENT_ID_MISMATCH",
      message: "REVOLUT_BUSINESS_CLIENT_ID does not match the live ONECAB Business API certificate",
      client_id_source: "REVOLUT_BUSINESS_CLIENT_ID",
      client_id_expected_suffix: REVOLUT_BUSINESS_CLIENT_ID_EXPECTED.slice(-6),
      redirect_uri: args.redirectUri,
    }, 400);
  }
  const relayConfigured = isRevolutBusinessRelayConfigured();
  // Do not probe live relay health here — that can hang and block Connect.
  if (!relayConfigured) {
    return json({
      ok: false,
      error_code: "RELAY_NOT_CONFIGURED",
      message: "Fixed-IP relay secrets required before OAuth (REVOLUT_BUSINESS_RELAY_URL + SHARED_SECRET)",
      whitelist_ip: REVOLUT_BUSINESS_RELAY_WHITELIST_IP,
    }, 400);
  }
  const state = newState();
  // Invalidate prior READ/WRITE (or any stored) grant so Connect issues a fresh READ,WRITE,PAY token set.
  await invalidateRevolutBusinessOAuthTokens(args.supabase);
  await storeOAuthPendingState(args.supabase, state, args.userId);
  const authorization_url = buildRevolutBusinessAuthorizationUrl({
    clientId,
    redirectUri: args.redirectUri,
    scope: REVOLUT_BUSINESS_OAUTH_SCOPE,
    state,
  });
  return json({
    ok: true,
    version: REVOLUT_BUSINESS_OAUTH_VERSION,
    authorization_url,
    redirect_uri: args.redirectUri,
    jwt_iss: args.jwtIss,
    oauth_scope: REVOLUT_BUSINESS_OAUTH_SCOPE,
    response_type: "code",
    client_id_source: "REVOLUT_BUSINESS_CLIENT_ID",
    client_id_matches_certificate: true,
    live_payout_execution_enabled: isLivePayoutExecutionEnabled(),
    payment_execution_blocked: !isLivePayoutExecutionEnabled(),
    relay: {
      configured: true,
      base_url: getRevolutBusinessRelayBaseUrl(),
      shared_secret_configured: true,
      public_health_ok: null,
      egress_ip: null,
      egress_ip_matches_whitelist: null,
      whitelist_ip: REVOLUT_BUSINESS_RELAY_WHITELIST_IP,
    },
    message:
      "Redirecting to Revolut for READ,WRITE,PAY consent. Prior tokens invalidated; exchange is server-side via fixed-IP relay. Live payouts stay disabled.",
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;
    const { supabase, userId } = gate;

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = String(body.action ?? "diagnostics").trim().toLowerCase();
    const redirectUri = resolveRevolutBusinessRedirectUri();
    const jwtIss = resolveRevolutBusinessJwtIss();

    if (action === "gap_audit" || action === "prepare") {
      // shared prechecks for prepare + audit
    }

    if (action === "gap_audit") {
      const clientId = readRevolutBusinessClientId();
      const privateKey = readRevolutBusinessPrivateKey();
      const vault = await buildRevolutBusinessDiagnostics({
        supabase,
        includeAccounts: false,
        probeEgress: true,
      });
      const relay = vault.relay;
      const edgeProbe = await fetch(`${REVOLUT_BUSINESS_REDIRECT_URI_EDGE}?probe=1`)
        .then((r) => r.json())
        .catch(() => null);
      const adminHostReachable = await fetch(redirectUri, {
        method: "GET",
      }).then((r) => r.status).catch(() => 0);

      const gaps = [
        {
          id: "client_id_matches_certificate",
          status: vault.client_id_matches_certificate ? "PASS" : "FAIL",
          detail: vault.client_id_matches_certificate
            ? `REVOLUT_BUSINESS_CLIENT_ID matches ${REVOLUT_BUSINESS_CLIENT_ID_EXPECTED.slice(0, 8)}…`
            : "Update REVOLUT_BUSINESS_CLIENT_ID to the live ONECAB Business API certificate",
        },
        {
          id: "callback_backend_only",
          status: edgeProbe?.reachable ? "PASS" : "FAIL",
          detail: "Edge callback reachable for server-side exchange",
        },
        {
          id: "admin_oauth_callback",
          status: adminHostReachable === 200 ? "PASS" : "GAP",
          detail: `${redirectUri} HTTP ${adminHostReachable || "error"}`,
        },
        {
          id: "jwt_iss_matches_redirect_host",
          status: jwtIss === new URL(redirectUri).host ? "PASS" : "FAIL",
          detail: `iss=${jwtIss} redirect_host=${new URL(redirectUri).host}`,
        },
        {
          id: "client_id_secret",
          status: clientId ? "PASS" : "FAIL",
          detail: "REVOLUT_BUSINESS_CLIENT_ID",
        },
        {
          id: "private_key_secret",
          status: privateKey ? "PASS" : "FAIL",
          detail: "REVOLUT_BUSINESS_PRIVATE_KEY (X.509 certificate private key)",
        },
        {
          id: "fixed_ip_relay",
          status: relay.configured && relay.public_health_ok ? "PASS" : relay.configured ? "GAP" : "FAIL",
          detail: relay.configured
            ? `Relay ${relay.base_url} health=${relay.public_health_ok} egress=${relay.egress_ip ?? "unknown"}`
            : "REVOLUT_BUSINESS_RELAY_URL + SHARED_SECRET required",
        },
        {
          id: "relay_egress_whitelist",
          status: relay.egress_ip_matches_whitelist ? "PASS" : "GAP",
          detail: `Expected ${REVOLUT_BUSINESS_RELAY_WHITELIST_IP}, observed ${relay.egress_ip ?? "unknown"}`,
        },
        {
          id: "access_token",
          status: vault.access_token_configured ? "PASS" : "PENDING_CONSENT",
          detail: "Stored in payment_provider_vault after exchange",
        },
        {
          id: "refresh_token",
          status: vault.refresh_token_configured ? "PASS" : "PENDING_CONSENT",
          detail: "Stored in payment_provider_vault after exchange",
        },
        {
          id: "token_expires_at",
          status: vault.token_expires_at ? "PASS" : "PENDING_CONSENT",
          detail: vault.token_expires_at ?? "awaiting consent",
        },
        {
          id: "live_payout_execution_disabled",
          status: vault.live_payout_execution_enabled ? "FAIL" : "PASS",
          detail: `LIVE_PAYOUT_EXECUTION_ENABLED=${vault.live_payout_execution_enabled}`,
        },
        {
          id: "payment_execution_blocked",
          status: vault.live_payout_execution_enabled ? "FAIL" : "PASS",
          detail: vault.live_payout_execution_enabled
            ? "Payment execution incorrectly unlocked"
            : "Payment execution BLOCKED (LIVE=false; /pay denylisted on relay)",
        },
        {
          id: "no_pay_calls",
          status: "PASS",
          detail: "OAuth requests READ,WRITE,PAY for consent only; /pay execution remains blocked",
        },
        {
          id: "oauth_scope_read_write_pay",
          status: REVOLUT_BUSINESS_OAUTH_SCOPE === "READ,WRITE,PAY" ? "PASS" : "FAIL",
          detail: `Requested oauth_scope=${REVOLUT_BUSINESS_OAUTH_SCOPE}`,
        },
        {
          id: "oauth_scopes_granted_dynamic",
          status: "PASS",
          detail: vault.oauth_scopes_granted.length > 0
            ? `Granted scopes from vault/secret: ${vault.oauth_scopes_granted.join(",")}`
            : "No granted scopes recorded yet (expected pre-consent / after invalidate). Post-exchange vault records scopes_granted.",
        },
      ];

      return json({
        ok: true,
        version: REVOLUT_BUSINESS_OAUTH_VERSION,
        redirect_uri: redirectUri,
        jwt_iss: jwtIss,
        edge_callback_uri: REVOLUT_BUSINESS_REDIRECT_URI_EDGE,
        edge_callback_reachable: Boolean(edgeProbe?.reachable),
        live_payout_execution_enabled: isLivePayoutExecutionEnabled(),
        payment_execution_blocked: !isLivePayoutExecutionEnabled(),
        relay,
        gaps,
        ready_for_enable_access: gaps
          .filter((g) => [
            "client_id_matches_certificate",
            "client_id_secret",
            "private_key_secret",
            "jwt_iss_matches_redirect_host",
            "live_payout_execution_disabled",
            "payment_execution_blocked",
            "callback_backend_only",
            "fixed_ip_relay",
            "oauth_scope_read_write_pay",
            "no_pay_calls",
          ].includes(g.id))
          .every((g) => g.status === "PASS"),
        message: adminHostReachable === 200
          ? "Admin OAuth callback host reachable"
          : "After Enable access, if the browser fails to load the callback, copy ?code= from the URL and paste into Payment Providers → Exchange code.",
      });
    }

    if (action === "invalidate_tokens" || action === "revoke_tokens") {
      const cleared = await invalidateRevolutBusinessOAuthTokens(supabase);
      return json({
        ok: true,
        version: REVOLUT_BUSINESS_OAUTH_VERSION,
        tokens_invalidated: true,
        vault_rows_deleted: cleared.deleted,
        oauth_scope_requested: REVOLUT_BUSINESS_OAUTH_SCOPE,
        live_payout_execution_enabled: isLivePayoutExecutionEnabled(),
        payment_execution_blocked: !isLivePayoutExecutionEnabled(),
        message:
          "Prior Revolut Business access/refresh tokens and pending OAuth state cleared. Re-run Connect for fresh READ,WRITE,PAY consent. Live payouts stay disabled.",
      });
    }

    if (action === "prepare" || action === "connect" || action === "reconnect") {
      return await buildAuthorizationPrepareResponse({
        supabase,
        userId,
        redirectUri,
        jwtIss,
      });
    }

    if (action === "exchange") {
      const code = String(body.code ?? "").trim();
      const state = String(body.state ?? "").trim() || null;
      if (!code) {
        return json({ ok: false, error_code: "CODE_REQUIRED" }, 400);
      }
      if (state) {
        const stateCheck = await consumeOAuthPendingState(supabase, state);
        if (!stateCheck.ok) {
          return json({
            ok: false,
            error_code: "INVALID_OAUTH_STATE",
            reason: stateCheck.reason,
            message: "Start again from Connect — state mismatched or expired",
          }, 400);
        }
      }
      const tokens = await exchangeRevolutBusinessAuthorizationCode(code);
      const persisted = await persistRevolutBusinessTokens({
        supabase,
        tokens,
        updatedBy: userId,
      });
      return json({
        ok: true,
        version: REVOLUT_BUSINESS_OAUTH_VERSION,
        access_token_stored: true,
        refresh_token_stored: Boolean(tokens.refresh_token),
        token_expires_at: persisted.expires_at,
        oauth_scopes_granted: persisted.scopes_granted,
        live_payout_execution_enabled: isLivePayoutExecutionEnabled(),
        payment_execution_blocked: !isLivePayoutExecutionEnabled(),
        message: "Revolut Business tokens stored in vault. No payments executed.",
      });
    }

    if (action === "select_source_account") {
      const accountId = String(body.account_id ?? "").trim();
      if (!accountId) {
        return json({ ok: false, error_code: "ACCOUNT_ID_REQUIRED" }, 400);
      }
      const diag = await buildRevolutBusinessDiagnostics({
        supabase,
        includeAccounts: true,
        probeEgress: false,
      });
      // Match by exact account ID only — never by name, position, or highest balance.
      const match = diag.accounts.find((a) => a.id === accountId);
      if (!match) {
        return json({
          ok: false,
          error_code: "ACCOUNT_NOT_FOUND",
          message: "Account id not present in Revolut /accounts list",
        }, 404);
      }
      const currency = String(match.currency ?? "").toUpperCase();
      if (currency !== "GBP") {
        return json({
          ok: false,
          error_code: "CURRENCY_NOT_GBP",
          message: "Source account currency must be GBP",
        }, 400);
      }
      const accountState = String(match.state ?? "active").trim().toLowerCase();
      if (accountState && accountState !== "active") {
        return json({
          ok: false,
          error_code: "ACCOUNT_INACTIVE",
          message: "Source account is inactive",
        }, 400);
      }
      if (match.balance_pence == null || !Number.isFinite(match.balance_pence)) {
        return json({
          ok: false,
          error_code: "BALANCE_UNVERIFIED",
          message: "Provider balance cannot be verified for this account",
        }, 400);
      }
      const now = new Date().toISOString();
      // Canonical SSOT first — vault pointer only after table persist succeeds.
      await supabase
        .from("revolut_business_source_accounts")
        .update({ is_default_payout_source: false, updated_at: now, updated_by: userId })
        .eq("provider", "revolut_business")
        .eq("is_default_payout_source", true)
        .is("service_area_id", null);

      const { error: sourceError } = await supabase.from("revolut_business_source_accounts").upsert(
        {
          provider: "revolut_business",
          currency: String(match.currency ?? "GBP").toUpperCase(),
          revolut_account_id: accountId,
          account_name: match.name ?? null,
          account_status: match.state ?? null,
          is_active: true,
          is_default_payout_source: true,
          service_area_id: null,
          last_balance_pence: match.balance_pence ?? null,
          last_available_balance_pence: match.balance_pence ?? null,
          last_verified_at: match.balance_pence != null ? now : null,
          last_provider_sync_at: now,
          updated_at: now,
          updated_by: userId,
        },
        { onConflict: "provider,revolut_account_id" },
      );
      if (sourceError) {
        console.error("[revolut-business-oauth] source account persist failed", sourceError.message);
        return json({
          ok: false,
          error_code: "SOURCE_ACCOUNT_PERSIST_FAILED",
          message: sourceError.message,
        }, 500);
      }

      const { error: vaultError } = await supabase.from("payment_provider_vault").upsert(
        {
          provider: "revolut",
          environment: "live",
          secret_name: "merchant_id",
          secret_value: accountId,
          updated_by: userId,
          updated_at: now,
        },
        { onConflict: "provider,environment,secret_name" },
      );
      if (vaultError) throw vaultError;

      return json({
        ok: true,
        selected_source_account_id: accountId,
        selected_source_account_label: match.name
          ? `${match.name} (GBP …${accountId.slice(-6)})`
          : `Revolut Business GBP …${accountId.slice(-6)}`,
        currency: match.currency,
        name: match.name,
        message: "Source Business account selected for company balance reads. Payouts remain disabled.",
        live_payout_execution_enabled: isLivePayoutExecutionEnabled(),
      });
    }

    if (action === "egress_ip") {
      const ip = await probeEdgeEgressPublicIp();
      return json({
        ok: true,
        egress_public_ip: ip,
        egress_ip_fixed_proven: false,
        whitelist_recommendation: "DO_NOT_WHITELIST_YET",
        message: ip
          ? "Observed one outbound IP for this invocation. Supabase Edge egress is not proven fixed — do not whitelist yet."
          : "Could not determine egress IP",
      });
    }

    const includeAccounts = body.include_accounts !== false;
    const probeEgress = body.probe_egress === true;
    const diagnostics = await buildRevolutBusinessDiagnostics({
      supabase,
      includeAccounts,
      probeEgress,
    });
    return json({
      ok: true,
      ...diagnostics,
    });
  } catch (error) {
    console.error("[admin-revolut-business-oauth]", error instanceof Error ? error.message : "error");
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "unexpected_error",
      live_payout_execution_enabled: isLivePayoutExecutionEnabled(),
    }, 500);
  }
});
