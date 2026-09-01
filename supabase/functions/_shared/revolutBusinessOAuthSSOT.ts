/**
 * Edge runtime: JWT client assertion + token exchange + vault persistence.
 * Never log token or private-key material.
 */
// deno-lint-ignore no-explicit-any
type AnySupabase = any;

import {
  REVOLUT_BUSINESS_CLIENT_ID_EXPECTED,
  REVOLUT_BUSINESS_OAUTH_SCOPE,
  REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED_VAULT_NAMES,
  REVOLUT_BUSINESS_OAUTH_VERSION,
  REVOLUT_BUSINESS_REDIRECT_URI_EDGE,
  REVOLUT_BUSINESS_RELAY_WHITELIST_IP,
  buildRevolutBusinessAuthorizationUrl,
  mapRevolutAccountDiag,
  normalizeRevolutBusinessOAuthScope,
  parseLivePayoutExecutionEnabled,
  evaluateRevolutBusinessPayoutExecutionGate,
  parseRevolutBusinessGrantedScopes,
  resolveConnectionStatus,
  resolveRevolutBusinessJwtIss,
  resolveRevolutBusinessRedirectUri,
  type RevolutBusinessDiagnosticsDto,
  type RevolutBusinessRelayDiagnostics,
} from "../../../shared/revolutBusinessOAuthSSOT.ts";
import { listCompanyBalanceAccounts } from "./companyBalanceResolveSSOT.ts";
import {
  assertRevolutBusinessRelayConfigured,
  getRevolutBusinessRelayBaseUrl,
  isRevolutBusinessRelayConfigured,
  probeRelayPublicHealth,
  relayEgressIpProbe,
  relayRevolutTokenExchange,
} from "./revolutBusinessRelayClient.ts";

export {
  REVOLUT_BUSINESS_CLIENT_ID_EXPECTED,
  REVOLUT_BUSINESS_OAUTH_SCOPE,
  REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED_VAULT_NAMES,
  REVOLUT_BUSINESS_OAUTH_VERSION,
  REVOLUT_BUSINESS_REDIRECT_URI_EDGE,
  REVOLUT_BUSINESS_RELAY_WHITELIST_IP,
  buildRevolutBusinessAuthorizationUrl,
  normalizeRevolutBusinessOAuthScope,
  evaluateRevolutBusinessPayoutExecutionGate,
  parseRevolutBusinessGrantedScopes,
  resolveRevolutBusinessJwtIss,
  resolveRevolutBusinessRedirectUri,
};


const VAULT_PROVIDER = "revolut";
const VAULT_ENV = "live";

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlFromJson(obj: unknown): string {
  return b64urlFromBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToPkcs8Buffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
    .replace(/-----END [A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function readRevolutBusinessClientId(): string | null {
  return (Deno.env.get("REVOLUT_BUSINESS_CLIENT_ID") ?? "").trim() || null;
}

export function clientIdHint(clientId: string | null): string | null {
  if (!clientId) return null;
  if (clientId.length <= 12) return clientId;
  return `${clientId.slice(0, 8)}…${clientId.slice(-4)}`;
}

export function clientIdMatchesCertificate(clientId: string | null): boolean {
  return Boolean(clientId && clientId === REVOLUT_BUSINESS_CLIENT_ID_EXPECTED);
}

export function readRevolutBusinessPrivateKey(): string | null {
  const raw = Deno.env.get("REVOLUT_BUSINESS_PRIVATE_KEY") ?? "";
  const trimmed = raw.trim();
  if (!trimmed.includes("BEGIN") || !trimmed.includes("PRIVATE KEY")) return null;
  return trimmed.replace(/\\n/g, "\n");
}

export function isLivePayoutExecutionEnabled(): boolean {
  return parseLivePayoutExecutionEnabled((k) => Deno.env.get(k));
}

/** Short-lived RS256 client assertion for Revolut token endpoint. */
export async function createRevolutBusinessClientAssertion(args?: {
  clientId?: string | null;
  privateKeyPem?: string | null;
  expiresInSeconds?: number;
}): Promise<string> {
  const clientId = (args?.clientId ?? readRevolutBusinessClientId())?.trim();
  const privateKeyPem = (args?.privateKeyPem ?? readRevolutBusinessPrivateKey())?.trim();
  if (!clientId) throw new Error("REVOLUT_BUSINESS_CLIENT_ID missing");
  if (!privateKeyPem) throw new Error("REVOLUT_BUSINESS_PRIVATE_KEY missing");

  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(60, Math.min(args?.expiresInSeconds ?? 300, 3600));
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: resolveRevolutBusinessJwtIss(),
    sub: clientId,
    aud: "https://revolut.com",
    exp,
  };
  const signingInput = `${b64urlFromJson(header)}.${b64urlFromJson(payload)}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Buffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`;
}

export type RevolutTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in: number;
  refresh_token?: string;
  /** Space- or comma-separated scopes when Revolut returns them. */
  scope?: string;
};

function scopeFromTokenJson(json: Record<string, unknown>): string | undefined {
  const raw = json?.scope;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

export async function exchangeRevolutBusinessAuthorizationCode(
  code: string,
): Promise<RevolutTokenResponse> {
  assertRevolutBusinessRelayConfigured();
  const assertion = await createRevolutBusinessClientAssertion();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code.trim(),
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  const res = await relayRevolutTokenExchange(body.toString());
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = typeof json?.error_description === "string"
      ? json.error_description
      : typeof json?.error === "string"
      ? json.error
      : `token_exchange_failed_${res.status}`;
    throw new Error(desc);
  }
  const access = String(json.access_token ?? "").trim();
  if (!access) throw new Error("token_exchange_missing_access_token");
  return {
    access_token: access,
    token_type: json.token_type,
    expires_in: Number(json.expires_in ?? 2400),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    // Post-consent only: token scope if present, else the Connect-requested READ,WRITE,PAY.
    // This is scopes_granted after successful exchange — never used pre-consent for capabilities.
    scope: scopeFromTokenJson(json) ?? REVOLUT_BUSINESS_OAUTH_SCOPE,
  };
}

export async function refreshRevolutBusinessAccessToken(
  refreshToken: string,
): Promise<RevolutTokenResponse> {
  assertRevolutBusinessRelayConfigured();
  const assertion = await createRevolutBusinessClientAssertion();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken.trim(),
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  const res = await relayRevolutTokenExchange(body.toString());
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = typeof json?.error_description === "string"
      ? json.error_description
      : typeof json?.error === "string"
      ? json.error
      : `token_refresh_failed_${res.status}`;
    throw new Error(desc);
  }
  const access = String(json.access_token ?? "").trim();
  if (!access) throw new Error("token_refresh_missing_access_token");
  return {
    access_token: access,
    token_type: json.token_type,
    expires_in: Number(json.expires_in ?? 2400),
    refresh_token: json.refresh_token ? String(json.refresh_token) : refreshToken,
    // Refresh often omits scope — leave undefined so persist keeps prior vault grant.
    scope: scopeFromTokenJson(json),
  };
}

async function upsertVaultSecret(
  supabase: AnySupabase,
  secretName: string,
  secretValue: string,
  updatedBy?: string | null,
): Promise<void> {
  const { error } = await supabase.from("payment_provider_vault").upsert(
    {
      provider: VAULT_PROVIDER,
      environment: VAULT_ENV,
      secret_name: secretName,
      secret_value: secretValue,
      updated_by: updatedBy ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider,environment,secret_name" },
  );
  if (error) throw error;
}

export async function persistRevolutBusinessTokens(args: {
  supabase: AnySupabase;
  tokens: RevolutTokenResponse;
  updatedBy?: string | null;
}): Promise<{ expires_at: string; scopes_granted: string[] }> {
  const expiresAt = new Date(Date.now() + Math.max(60, args.tokens.expires_in) * 1000).toISOString();
  await upsertVaultSecret(args.supabase, "business_access_token", args.tokens.access_token, args.updatedBy);
  // Mirror env secret names in vault (Edge cannot mutate Deno secrets at runtime).
  await upsertVaultSecret(args.supabase, "REVOLUT_BUSINESS_ACCESS_TOKEN", args.tokens.access_token, args.updatedBy);
  if (args.tokens.refresh_token) {
    await upsertVaultSecret(args.supabase, "business_refresh_token", args.tokens.refresh_token, args.updatedBy);
    await upsertVaultSecret(args.supabase, "REVOLUT_BUSINESS_REFRESH_TOKEN", args.tokens.refresh_token, args.updatedBy);
  }
  await upsertVaultSecret(args.supabase, "business_token_expires_at", expiresAt, args.updatedBy);
  await upsertVaultSecret(args.supabase, "REVOLUT_BUSINESS_TOKEN_EXPIRES_AT", expiresAt, args.updatedBy);
  const clientId = readRevolutBusinessClientId();
  if (clientId) {
    await upsertVaultSecret(args.supabase, "business_client_id", clientId, args.updatedBy);
  }

  // Persist granted scopes only when known (code exchange / refresh that returns scope).
  // Never invent WRITE/PAY before consent; never clear prior grant (incl. PAY) on scope-less refresh.
  let scopes_granted: string[] = [];
  const fromToken = parseRevolutBusinessGrantedScopes(args.tokens.scope);
  if (fromToken.length > 0) {
    const normalized = fromToken.join(",");
    for (const name of REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED_VAULT_NAMES) {
      await upsertVaultSecret(args.supabase, name, normalized, args.updatedBy);
    }
    scopes_granted = fromToken;
  } else {
    const existing = await readRevolutBusinessVaultGrantedScopes(args.supabase);
    scopes_granted = existing;
  }
  return { expires_at: expiresAt, scopes_granted };
}

const REVOLUT_BUSINESS_TOKEN_VAULT_NAMES = [
  "business_access_token",
  "business_refresh_token",
  "business_token_expires_at",
  "REVOLUT_BUSINESS_ACCESS_TOKEN",
  "REVOLUT_BUSINESS_REFRESH_TOKEN",
  "REVOLUT_BUSINESS_TOKEN_EXPIRES_AT",
  "business_oauth_pending_state",
  ...REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED_VAULT_NAMES,
] as const;

/** Invalidate stored prior tokens so Connect forces fresh READ,WRITE,PAY consent. */
export async function invalidateRevolutBusinessOAuthTokens(
  supabase: AnySupabase,
): Promise<{ deleted: number }> {
  const { data, error } = await supabase
    .from("payment_provider_vault")
    .delete()
    .eq("provider", VAULT_PROVIDER)
    .eq("environment", VAULT_ENV)
    .in("secret_name", [...REVOLUT_BUSINESS_TOKEN_VAULT_NAMES])
    .select("secret_name");
  if (error) throw error;
  return { deleted: Array.isArray(data) ? data.length : 0 };
}

export async function readRevolutBusinessVaultGrantedScopes(
  supabase: AnySupabase,
): Promise<string[]> {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_name, secret_value")
    .eq("provider", VAULT_PROVIDER)
    .eq("environment", VAULT_ENV)
    .in("secret_name", [...REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED_VAULT_NAMES]);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(String(row.secret_name), String(row.secret_value ?? ""));
  }
  const fromVault = parseRevolutBusinessGrantedScopes(
    map.get("business_oauth_scopes_granted")
      ?? map.get("REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED"),
  );
  if (fromVault.length > 0) return fromVault;
  // Explicit post-consent edge secret only — never REVOLUT_BUSINESS_OAUTH_SCOPE (requested).
  return parseRevolutBusinessGrantedScopes(
    Deno.env.get("REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED"),
  );
}

export async function readRevolutBusinessVaultTokens(supabase: AnySupabase): Promise<{
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  merchant_id: string | null;
  scopes_granted: string[];
}> {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_name, secret_value")
    .eq("provider", VAULT_PROVIDER)
    .eq("environment", VAULT_ENV)
    .in("secret_name", [
      "business_access_token",
      "business_refresh_token",
      "business_token_expires_at",
      "REVOLUT_BUSINESS_ACCESS_TOKEN",
      "REVOLUT_BUSINESS_REFRESH_TOKEN",
      "REVOLUT_BUSINESS_TOKEN_EXPIRES_AT",
      "merchant_id",
      ...REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED_VAULT_NAMES,
    ]);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(String(row.secret_name), String(row.secret_value ?? ""));
  }
  const scrub = (v: string | null | undefined) => {
    const t = String(v ?? "").trim();
    if (!t || t === "PENDING_CONSENT") return null;
    return t;
  };
  const access = scrub(
    map.get("business_access_token")
      ?? map.get("REVOLUT_BUSINESS_ACCESS_TOKEN")
      ?? Deno.env.get("REVOLUT_BUSINESS_ACCESS_TOKEN"),
  );
  const refresh = scrub(
    map.get("business_refresh_token")
      ?? map.get("REVOLUT_BUSINESS_REFRESH_TOKEN")
      ?? Deno.env.get("REVOLUT_BUSINESS_REFRESH_TOKEN"),
  );
  const expires = scrub(
    map.get("business_token_expires_at")
      ?? map.get("REVOLUT_BUSINESS_TOKEN_EXPIRES_AT")
      ?? Deno.env.get("REVOLUT_BUSINESS_TOKEN_EXPIRES_AT"),
  );
  const merchant_id =
    (map.get("merchant_id") ?? Deno.env.get("REVOLUT_SOURCE_BUSINESS_ACCOUNT_ID") ?? "").trim() || null;
  const scopes_granted = parseRevolutBusinessGrantedScopes(
    map.get("business_oauth_scopes_granted")
      ?? map.get("REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED")
      ?? Deno.env.get("REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED"),
  );
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: expires,
    merchant_id,
    scopes_granted,
  };
}

export async function storeOAuthPendingState(
  supabase: AnySupabase,
  state: string,
  preparedBy: string | null,
): Promise<void> {
  await upsertVaultSecret(
    supabase,
    "business_oauth_pending_state",
    JSON.stringify({
      state,
      prepared_by: preparedBy,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
    preparedBy,
  );
}

export async function consumeOAuthPendingState(
  supabase: AnySupabase,
  state: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_value")
    .eq("provider", VAULT_PROVIDER)
    .eq("environment", VAULT_ENV)
    .eq("secret_name", "business_oauth_pending_state")
    .maybeSingle();
  if (!data?.secret_value) return { ok: false, reason: "missing_pending_state" };
  let parsed: { state?: string; expires_at?: string };
  try {
    parsed = JSON.parse(String(data.secret_value));
  } catch {
    return { ok: false, reason: "invalid_pending_state" };
  }
  if (!state || state !== parsed.state) return { ok: false, reason: "state_mismatch" };
  if (parsed.expires_at && Date.parse(parsed.expires_at) < Date.now()) {
    return { ok: false, reason: "state_expired" };
  }
  await supabase
    .from("payment_provider_vault")
    .delete()
    .eq("provider", VAULT_PROVIDER)
    .eq("environment", VAULT_ENV)
    .eq("secret_name", "business_oauth_pending_state");
  return { ok: true };
}

export async function probeEdgeEgressPublicIp(): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const ip = String(json?.ip ?? "").trim();
    return ip || null;
  } catch {
    return null;
  }
}

export async function buildRevolutBusinessRelayDiagnostics(): Promise<RevolutBusinessRelayDiagnostics> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  const configured = isRevolutBusinessRelayConfigured();
  const health = configured && base ? await probeRelayPublicHealth() : {
    ok: false,
    mode: null,
    live_payout_execution_enabled: null,
  };
  let egress_ip: string | null = null;
  // Only probe signed egress if public health already succeeded (avoids long hangs).
  if (configured && health.ok) {
    try {
      const egress = await relayEgressIpProbe();
      egress_ip = egress.whitelist_candidate ?? egress.ipify ?? egress.ifconfig;
    } catch {
      egress_ip = null;
    }
  }
  return {
    configured,
    base_url: base,
    shared_secret_configured: secret.length >= 32,
    public_health_ok: configured ? health.ok : null,
    egress_ip,
    egress_ip_matches_whitelist: egress_ip
      ? egress_ip === REVOLUT_BUSINESS_RELAY_WHITELIST_IP
      : null,
    whitelist_ip: REVOLUT_BUSINESS_RELAY_WHITELIST_IP,
  };
}

export async function buildRevolutBusinessDiagnostics(args: {
  supabase: AnySupabase;
  includeAccounts?: boolean;
  probeEgress?: boolean;
}): Promise<RevolutBusinessDiagnosticsDto> {
  const clientId = readRevolutBusinessClientId();
  const privateKey = readRevolutBusinessPrivateKey();
  const vault = await readRevolutBusinessVaultTokens(args.supabase);
  const now = new Date();
  const initialConnectionStatus = resolveConnectionStatus({
    clientIdConfigured: Boolean(clientId),
    privateKeyConfigured: Boolean(privateKey),
    accessTokenConfigured: Boolean(vault.access_token),
    tokenExpiresAt: vault.expires_at,
    now,
  });

  let accounts: ReturnType<typeof mapRevolutAccountDiag>[] = [];
  let message: string | null = null;
  let workingToken = vault.access_token;
  let accounts_list_succeeded = false;
  let accounts_list_http_status: number | null = null;
  let accounts_list_error: string | null = null;
  let accounts_list_relay_hint: string | null = null;

  if (args.includeAccounts && workingToken) {
    const expired = vault.expires_at && Date.parse(vault.expires_at) <= now.getTime();
    if ((expired || initialConnectionStatus === "TOKEN_EXPIRED") && vault.refresh_token) {
      try {
        const refreshed = await refreshRevolutBusinessAccessToken(vault.refresh_token);
        const persisted = await persistRevolutBusinessTokens({
          supabase: args.supabase,
          tokens: refreshed,
        });
        workingToken = refreshed.access_token;
        vault.expires_at = persisted.expires_at;
      } catch (err) {
        message = err instanceof Error ? err.message : "token_refresh_failed";
        workingToken = null;
      }
    }
  }

  if (args.includeAccounts && workingToken) {
    try {
      const raw = await listCompanyBalanceAccounts(workingToken);
      accounts = raw.map(mapRevolutAccountDiag).filter((a) => a.id);
      accounts_list_succeeded = true;
    } catch (err) {
      accounts_list_succeeded = false;
      const status = typeof err === "object" && err && "status" in err
        ? Number((err as { status?: number }).status)
        : null;
      accounts_list_http_status = Number.isFinite(status) && status ? status : null;
      const body = typeof err === "object" && err && "body" in err
        ? (err as { body?: unknown }).body
        : null;
      const relayMessage = typeof err === "object" && err && "message" in err
        ? String((err as { message?: string }).message ?? "")
        : "";
      accounts_list_error = relayMessage || (err instanceof Error ? err.message : "accounts_list_failed");
      accounts_list_relay_hint = summarizeAccountsListFailureBody(body);
      message = accounts_list_error;
      console.warn("[revolut-business-oauth] accounts list failed", {
        status: accounts_list_http_status,
        error: accounts_list_error,
        relay_hint: accounts_list_relay_hint,
      });
    }
  }

  const gbp_accounts = accounts.filter((a) => a.is_gbp);
  // Prefer canonical Use-as-source table; vault merchant_id is legacy pointer only.
  let selected: string | null = null;
  let selectedLastVerifiedAt: string | null = null;
  let selectedAccountName: string | null = null;
  try {
    const { data: sourceRow } = await args.supabase
      .from("revolut_business_source_accounts")
      .select("revolut_account_id, account_name, last_verified_at, last_provider_sync_at")
      .eq("provider", "revolut_business")
      .eq("is_active", true)
      .eq("is_default_payout_source", true)
      .is("service_area_id", null)
      .maybeSingle();
    selected = (sourceRow?.revolut_account_id as string | null) ?? null;
    selectedAccountName = (sourceRow?.account_name as string | null) ?? null;
    selectedLastVerifiedAt = (
      (sourceRow?.last_verified_at as string | null)
      ?? (sourceRow?.last_provider_sync_at as string | null)
      ?? null
    );
  } catch {
    selected = null;
  }
  if (!selected) selected = vault.merchant_id;
  const selected_source_account_ok = selected
    ? accounts.some((a) => a.id === selected)
    : null;

  const expiresAt = vault.expires_at;
  const expiresIn = expiresAt && Number.isFinite(Date.parse(expiresAt))
    ? Math.max(0, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000))
    : null;
  const token_valid = Boolean(
    (workingToken ?? vault.access_token)
      && expiresAt
      && Number.isFinite(Date.parse(expiresAt))
      && Date.parse(expiresAt) > now.getTime(),
  );

  const relay = await buildRevolutBusinessRelayDiagnostics();
  const egress = args.probeEgress ? await probeEdgeEgressPublicIp() : null;
  // Exact selected account only — never first GBP / Main / highest balance.
  const gbpSource = selected
    ? (gbp_accounts.find((a) => a.id === selected) ?? null)
    : null;

  const connection_status = message && !workingToken && vault.access_token
    ? "ERROR"
    : resolveConnectionStatus({
      clientIdConfigured: Boolean(clientId),
      privateKeyConfigured: Boolean(privateKey),
      accessTokenConfigured: Boolean(workingToken ?? vault.access_token),
      tokenExpiresAt: vault.expires_at,
      now,
    });

  const oauth_connected = connection_status === "TOKEN_PRESENT";
  const payoutGate = evaluateRevolutBusinessPayoutExecutionGate({
    oauth_connected,
    token_valid,
    oauth_scopes_granted: vault.scopes_granted,
    live_payout_execution_enabled: isLivePayoutExecutionEnabled(),
    accounts_list_succeeded,
    selected_source_account_ok: oauth_connected && token_valid && accounts_list_succeeded
      ? selected_source_account_ok
      : null,
    live_balance_pence: gbpSource?.balance_pence ?? null,
  });

  return {
    version: REVOLUT_BUSINESS_OAUTH_VERSION,
    connection_status,
    client_id_configured: Boolean(clientId),
    client_id_source: "REVOLUT_BUSINESS_CLIENT_ID",
    client_id_matches_certificate: clientIdMatchesCertificate(clientId),
    client_id_hint: clientIdHint(clientId),
    certificate_configured: Boolean(privateKey),
    private_key_configured: Boolean(privateKey),
    oauth_connected,
    access_token_configured: Boolean(workingToken ?? vault.access_token),
    refresh_token_configured: Boolean(vault.refresh_token),
    token_valid,
    token_expires_at: vault.expires_at,
    token_expires_in_seconds: expiresIn,
    redirect_uri: resolveRevolutBusinessRedirectUri(),
    jwt_iss: resolveRevolutBusinessJwtIss(),
    oauth_scope: normalizeRevolutBusinessOAuthScope(REVOLUT_BUSINESS_OAUTH_SCOPE),
    oauth_scopes_granted: vault.scopes_granted,
    live_payout_execution_enabled: isLivePayoutExecutionEnabled(),
    live_payouts_executable: payoutGate.live_payouts_executable,
    live_payouts_blocked: payoutGate.live_payouts_blocked,
    payout_execution_locked: payoutGate.payout_execution_locked,
    admin_blocked_copy: payoutGate.admin_blocked_copy,
    selected_source_live_verifiable: payoutGate.selected_source_live_verifiable,
    live_balance_verified: payoutGate.live_balance_verified,
    payment_execution_blocked: payoutGate.payout_execution_locked,
    relay,
    egress_public_ip: egress,
    egress_ip_fixed_proven: Boolean(relay.egress_ip_matches_whitelist),
    whitelist_recommendation: relay.egress_ip_matches_whitelist
      ? `Whitelist ${REVOLUT_BUSINESS_RELAY_WHITELIST_IP} only (fixed Lightsail egress proven)`
      : "Route all Revolut Business API calls through the fixed-IP relay before whitelisting Edge egress",
    accounts,
    gbp_accounts,
    gbp_source_account_id: gbpSource?.id ?? null,
    gbp_balance_pence: gbpSource?.balance_pence ?? null,
    selected_source_account_id: selected,
    selected_source_account_ok,
    selected_source_account_label: selected
      ? (selectedAccountName
        ?? gbpSource?.name
        ?? (selected ? `Revolut Business GBP …${selected.slice(-6)}` : null))
      : null,
    selected_source_last_verified_at: selectedLastVerifiedAt,
    accounts_list_succeeded,
    accounts_list_http_status,
    accounts_list_error,
    accounts_list_relay_hint,
    message,
  };
}

function summarizeAccountsListFailureBody(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === "string") {
    const cleaned = body.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240);
    return cleaned || null;
  }
  if (typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const parts = [
    record.message,
    record.error,
    record.error_description,
    record.code,
  ].filter((v) => typeof v === "string" && v.trim()).map((v) => String(v).trim());
  return parts.length > 0 ? parts.join(" · ").slice(0, 240) : null;
}
