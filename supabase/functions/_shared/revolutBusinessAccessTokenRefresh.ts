/**
 * Canonical Revolut Business OAuth refresh — ON_DEMAND_DB_CLAIM_CAS.
 * Single logical owner: claim → refresh → CAS complete/fail.
 * All Business consumers should call ensureFreshRevolutBusinessAccessToken
 * before the first provider money or balance request.
 * Never logs tokens/keys. Never invokes Revolut /pay. Never auto-replays /pay after refresh.
 * Read-only GET callers may use withBusinessGetRetryAfterRefresh (one GET retry max).
 */

import { relayRevolutTokenExchange } from "./revolutBusinessRelayClient.ts";

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

const VAULT_PROVIDER = "revolut";
const VAULT_ENV = "live";
export const REFRESH_SKEW_SECONDS = 60;
export const REFRESH_CLAIM_TTL_SECONDS = 45;
const IN_PROGRESS_POLL_MS = 250;
const IN_PROGRESS_MAX_WAIT_MS = 20_000;

export type ClaimRefreshStatus =
  | "CLAIMED"
  | "TOKEN_ALREADY_FRESH"
  | "REFRESH_IN_PROGRESS";

export type ClaimRefreshResult = {
  status: ClaimRefreshStatus;
  provider: string;
  environment: string;
  credential_generation: number;
  access_token_expires_at: string | null;
  refresh_claim_expires_at: string | null;
  claim_token: string | null;
};

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

function readClientId(): string | null {
  return (Deno.env.get("REVOLUT_BUSINESS_CLIENT_ID") ?? "").trim() || null;
}

function readPrivateKeyPem(): string | null {
  const raw = (Deno.env.get("REVOLUT_BUSINESS_PRIVATE_KEY") ?? "").trim();
  if (!raw.includes("BEGIN") || !raw.includes("PRIVATE KEY")) return null;
  return raw.replace(/\\n/g, "\n");
}

function readJwtIss(): string {
  const fromEnv = (Deno.env.get("REVOLUT_BUSINESS_JWT_ISS") ?? "").trim();
  if (fromEnv) return fromEnv;
  return "adminonecab.net";
}

async function createClientAssertion(): Promise<string> {
  const clientId = readClientId();
  const privateKeyPem = readPrivateKeyPem();
  if (!clientId) throw new Error("REVOLUT_BUSINESS_CLIENT_ID missing");
  if (!privateKeyPem) throw new Error("REVOLUT_BUSINESS_PRIVATE_KEY missing");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: readJwtIss(),
    sub: clientId,
    aud: "https://revolut.com",
    exp: now + 300,
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

async function readVaultMap(supabase: AnySupabase): Promise<Map<string, string>> {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_name, secret_value")
    .eq("provider", VAULT_PROVIDER)
    .eq("environment", VAULT_ENV)
    .in("secret_name", [
      "business_access_token",
      "REVOLUT_BUSINESS_ACCESS_TOKEN",
      "business_refresh_token",
      "REVOLUT_BUSINESS_REFRESH_TOKEN",
      "business_token_expires_at",
      "REVOLUT_BUSINESS_TOKEN_EXPIRES_AT",
    ]);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(String(row.secret_name), String(row.secret_value ?? ""));
  }
  return map;
}

function pick(map: Map<string, string>, ...names: string[]): string {
  for (const n of names) {
    const v = (map.get(n) ?? "").trim();
    if (v) return v;
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseClaimResult(raw: unknown): ClaimRefreshResult {
  const j = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const status = String(j.status ?? "");
  if (
    status !== "CLAIMED"
    && status !== "TOKEN_ALREADY_FRESH"
    && status !== "REFRESH_IN_PROGRESS"
  ) {
    throw new Error(`oauth_claim_unexpected_status:${status || "empty"}`);
  }
  return {
    status,
    provider: String(j.provider ?? VAULT_PROVIDER),
    environment: String(j.environment ?? VAULT_ENV),
    credential_generation: Number(j.credential_generation ?? 0),
    access_token_expires_at: typeof j.access_token_expires_at === "string"
      ? j.access_token_expires_at
      : null,
    refresh_claim_expires_at: typeof j.refresh_claim_expires_at === "string"
      ? j.refresh_claim_expires_at
      : null,
    claim_token: typeof j.claim_token === "string" ? j.claim_token : null,
  };
}

export async function claimRevolutBusinessOAuthRefresh(
  supabase: AnySupabase,
  args?: { skewSeconds?: number; claimTtlSeconds?: number },
): Promise<ClaimRefreshResult> {
  const { data, error } = await supabase.rpc("claim_revolut_business_oauth_refresh", {
    p_provider: VAULT_PROVIDER,
    p_environment: VAULT_ENV,
    p_skew_seconds: args?.skewSeconds ?? REFRESH_SKEW_SECONDS,
    p_claim_ttl_seconds: args?.claimTtlSeconds ?? REFRESH_CLAIM_TTL_SECONDS,
  });
  if (error) throw error;
  return parseClaimResult(data);
}

export async function completeRevolutBusinessOAuthRefresh(
  supabase: AnySupabase,
  args: {
    claimToken: string;
    expectedGeneration: number;
    accessToken: string;
    expiresAt: string;
    refreshToken?: string | null;
    scopesGranted?: string | null;
  },
): Promise<{ status: string; persisted: boolean; credential_generation?: number }> {
  const { data, error } = await supabase.rpc("complete_revolut_business_oauth_refresh", {
    p_claim_token: args.claimToken,
    p_expected_generation: args.expectedGeneration,
    p_access_token: args.accessToken,
    p_expires_at: args.expiresAt,
    p_refresh_token: args.refreshToken ?? null,
    p_scopes_granted: args.scopesGranted ?? null,
    p_provider: VAULT_PROVIDER,
    p_environment: VAULT_ENV,
  });
  if (error) throw error;
  const j = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return {
    status: String(j.status ?? "UNKNOWN"),
    persisted: Boolean(j.persisted),
    credential_generation: j.credential_generation != null
      ? Number(j.credential_generation)
      : undefined,
  };
}

export async function failRevolutBusinessOAuthRefresh(
  supabase: AnySupabase,
  args: { claimToken: string; errorCode: string },
): Promise<void> {
  const { error } = await supabase.rpc("fail_revolut_business_oauth_refresh", {
    p_claim_token: args.claimToken,
    p_error_code: args.errorCode.slice(0, 120),
    p_provider: VAULT_PROVIDER,
    p_environment: VAULT_ENV,
  });
  if (error) throw error;
}

async function exchangeRefreshToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope?: string;
}> {
  const assertion = await createClientAssertion();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  const res = await relayRevolutTokenExchange(body.toString());
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const desc = typeof json.error_description === "string"
      ? json.error_description
      : typeof json.error === "string"
      ? json.error
      : `token_refresh_http_${res.status}`;
    throw new Error(desc.slice(0, 180));
  }
  const nextAccess = String(json.access_token ?? "").trim();
  if (!nextAccess) throw new Error("token_refresh_missing_access_token");
  const nextRefresh = String(json.refresh_token ?? "").trim() || refreshToken;
  const expiresIn = Number(json.expires_in ?? 2400);
  const expiresAt = new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString();
  const scope = typeof json.scope === "string" ? json.scope.trim() : undefined;
  return {
    access_token: nextAccess,
    refresh_token: nextRefresh,
    expires_at: expiresAt,
    scope: scope || undefined,
  };
}

async function readAccessOrThrow(supabase: AnySupabase): Promise<string> {
  const fromEnv = (Deno.env.get("REVOLUT_BUSINESS_ACCESS_TOKEN") ?? "").trim();
  const map = await readVaultMap(supabase);
  const access = pick(map, "business_access_token", "REVOLUT_BUSINESS_ACCESS_TOKEN") || fromEnv;
  if (!access) throw new Error("access_token_missing");
  return access;
}

async function waitForFreshToken(
  supabase: AnySupabase,
): Promise<{ accessToken: string; note: string }> {
  const deadline = Date.now() + IN_PROGRESS_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(IN_PROGRESS_POLL_MS);
    const again = await claimRevolutBusinessOAuthRefresh(supabase);
    if (again.status === "TOKEN_ALREADY_FRESH") {
      return { accessToken: await readAccessOrThrow(supabase), note: "waited_for_peer_refresh" };
    }
    if (again.status === "CLAIMED") {
      // Peer abandoned; this caller became claimant — handle below by rethrowing to outer.
      throw Object.assign(new Error("REFRESH_CLAIM_ACQUIRED_AFTER_WAIT"), {
        claim: again,
      });
    }
  }
  throw new Error("REFRESH_IN_PROGRESS_TIMEOUT");
}

/**
 * Returns a usable access token via durable claim + CAS persist.
 * Non-claimants wait/re-read. Never replays /pay.
 */
export async function ensureFreshRevolutBusinessAccessToken(
  supabase: AnySupabase,
): Promise<{ accessToken: string; refreshed: boolean; note: string }> {
  let claim = await claimRevolutBusinessOAuthRefresh(supabase);

  if (claim.status === "TOKEN_ALREADY_FRESH") {
    return {
      accessToken: await readAccessOrThrow(supabase),
      refreshed: false,
      note: "vault_token_fresh",
    };
  }

  if (claim.status === "REFRESH_IN_PROGRESS") {
    try {
      const waited = await waitForFreshToken(supabase);
      return { accessToken: waited.accessToken, refreshed: false, note: waited.note };
    } catch (err) {
      if (
        err instanceof Error
        && err.message === "REFRESH_CLAIM_ACQUIRED_AFTER_WAIT"
        && "claim" in err
      ) {
        claim = (err as { claim: ClaimRefreshResult }).claim;
      } else {
        throw err;
      }
    }
  }

  if (claim.status !== "CLAIMED" || !claim.claim_token) {
    throw new Error("oauth_refresh_claim_unavailable");
  }

  const map = await readVaultMap(supabase);
  const refresh = pick(map, "business_refresh_token", "REVOLUT_BUSINESS_REFRESH_TOKEN");
  if (!refresh) {
    await failRevolutBusinessOAuthRefresh(supabase, {
      claimToken: claim.claim_token,
      errorCode: "missing_refresh_token",
    });
    const access = pick(map, "business_access_token", "REVOLUT_BUSINESS_ACCESS_TOKEN");
    if (access) {
      return { accessToken: access, refreshed: false, note: "expired_no_refresh_token" };
    }
    throw new Error("access_token_missing");
  }

  try {
    const tokens = await exchangeRefreshToken(refresh);
    const completed = await completeRevolutBusinessOAuthRefresh(supabase, {
      claimToken: claim.claim_token,
      expectedGeneration: claim.credential_generation,
      accessToken: tokens.access_token,
      expiresAt: tokens.expires_at,
      refreshToken: tokens.refresh_token,
      scopesGranted: tokens.scope ?? null,
    });
    if (!completed.persisted || completed.status !== "COMPLETED") {
      // Peer may have won; do not overwrite — re-read vault.
      if (completed.status === "STALE_GENERATION" || completed.status === "CLAIM_MISMATCH") {
        return {
          accessToken: await readAccessOrThrow(supabase),
          refreshed: false,
          note: `stale_claim_${completed.status.toLowerCase()}`,
        };
      }
      throw new Error(`oauth_refresh_persist_failed:${completed.status}`);
    }
    return {
      accessToken: tokens.access_token,
      refreshed: true,
      note: "refreshed_via_durable_claim",
    };
  } catch (err) {
    const code = err instanceof Error ? err.message.slice(0, 80) : "refresh_failed";
    try {
      await failRevolutBusinessOAuthRefresh(supabase, {
        claimToken: claim.claim_token,
        errorCode: code,
      });
    } catch {
      // claim may already be cleared
    }
    throw err;
  }
}

/**
 * Read-only Business GET with at most one refresh + one GET retry.
 * Never used for /pay. Callers must not replay payment after refresh.
 */
export async function withBusinessGetRetryAfterRefresh<T>(args: {
  supabase: AnySupabase;
  getOnce: (accessToken: string) => Promise<{ ok: boolean; status: number; body: T }>;
}): Promise<{ ok: boolean; status: number; body: T; refreshed: boolean; retried: boolean }> {
  const firstTok = await ensureFreshRevolutBusinessAccessToken(args.supabase);
  const first = await args.getOnce(firstTok.accessToken);
  if (first.ok || first.status !== 401) {
    return { ...first, refreshed: firstTok.refreshed, retried: false };
  }
  // One refresh (if not already) + exactly one GET retry — never /pay.
  const secondTok = await ensureFreshRevolutBusinessAccessToken(args.supabase);
  const second = await args.getOnce(secondTok.accessToken);
  return {
    ...second,
    refreshed: firstTok.refreshed || secondTok.refreshed,
    retried: true,
  };
}
