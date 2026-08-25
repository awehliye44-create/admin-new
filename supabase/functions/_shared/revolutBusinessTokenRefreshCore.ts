/**
 * Minimal Business OAuth refresh + vault persist for Step 9.4B temp Edge.
 * Does not import revolutApi /pay helpers.
 */
import {
  REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED_VAULT_NAMES,
  parseRevolutBusinessGrantedScopes,
  resolveRevolutBusinessJwtIss,
} from "../../../shared/revolutBusinessOAuthSSOT.ts";
import {
  isRefreshOnlyRelayConfigured,
  relayRefreshOnlyTokenExchange,
} from "./revolutBusinessRefreshOnlyRelay.ts";

export function assertRefreshOnlyRelayConfigured(): void {
  if (!isRefreshOnlyRelayConfigured()) {
    throw new Error("revolut_business_relay_not_configured");
  }
}

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

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

export function readRefreshOnlyPrivateKey(): string | null {
  const raw = Deno.env.get("REVOLUT_BUSINESS_PRIVATE_KEY") ?? "";
  const trimmed = raw.trim();
  if (!trimmed.includes("BEGIN") || !trimmed.includes("PRIVATE KEY")) return null;
  return trimmed.replace(/\\n/g, "\n");
}

export function readRefreshOnlyClientId(): string | null {
  return (Deno.env.get("REVOLUT_BUSINESS_CLIENT_ID") ?? "").trim() || null;
}

async function createClientAssertion(): Promise<string> {
  const clientId = readRefreshOnlyClientId();
  const privateKeyPem = readRefreshOnlyPrivateKey();
  if (!clientId) throw new Error("REVOLUT_BUSINESS_CLIENT_ID missing");
  if (!privateKeyPem) throw new Error("REVOLUT_BUSINESS_PRIVATE_KEY missing");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: resolveRevolutBusinessJwtIss(),
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

export type RefreshOnlyTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

export async function refreshOnlyBusinessAccessToken(
  refreshToken: string,
): Promise<RefreshOnlyTokenResponse> {
  assertRefreshOnlyRelayConfigured();
  const assertion = await createClientAssertion();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken.trim(),
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  const res = await relayRefreshOnlyTokenExchange(body.toString());
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const desc = typeof json.error_description === "string"
      ? json.error_description
      : typeof json.error === "string"
      ? json.error
      : `token_refresh_failed_${res.status}`;
    throw new Error(desc.slice(0, 180));
  }
  const access = String(json.access_token ?? "").trim();
  if (!access) throw new Error("token_refresh_missing_access_token");
  return {
    access_token: access,
    token_type: typeof json.token_type === "string" ? json.token_type : "bearer",
    expires_in: Number(json.expires_in ?? 2400),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
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

export async function readRefreshOnlyVaultTokens(supabase: AnySupabase): Promise<{
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
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
  return {
    access_token: scrub(map.get("business_access_token") ?? map.get("REVOLUT_BUSINESS_ACCESS_TOKEN")),
    refresh_token: scrub(map.get("business_refresh_token") ?? map.get("REVOLUT_BUSINESS_REFRESH_TOKEN")),
    expires_at: scrub(map.get("business_token_expires_at") ?? map.get("REVOLUT_BUSINESS_TOKEN_EXPIRES_AT")),
    scopes_granted: parseRevolutBusinessGrantedScopes(
      map.get("business_oauth_scopes_granted")
        ?? map.get("REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED"),
    ),
  };
}

export async function persistRefreshOnlyTokens(args: {
  supabase: AnySupabase;
  tokens: RefreshOnlyTokenResponse;
  updatedBy?: string | null;
}): Promise<{ expires_at: string; scopes_granted: string[] }> {
  const expiresAt = new Date(Date.now() + Math.max(60, args.tokens.expires_in) * 1000).toISOString();
  await upsertVaultSecret(args.supabase, "business_access_token", args.tokens.access_token, args.updatedBy);
  await upsertVaultSecret(args.supabase, "REVOLUT_BUSINESS_ACCESS_TOKEN", args.tokens.access_token, args.updatedBy);
  if (args.tokens.refresh_token) {
    await upsertVaultSecret(args.supabase, "business_refresh_token", args.tokens.refresh_token, args.updatedBy);
    await upsertVaultSecret(args.supabase, "REVOLUT_BUSINESS_REFRESH_TOKEN", args.tokens.refresh_token, args.updatedBy);
  }
  await upsertVaultSecret(args.supabase, "business_token_expires_at", expiresAt, args.updatedBy);
  await upsertVaultSecret(args.supabase, "REVOLUT_BUSINESS_TOKEN_EXPIRES_AT", expiresAt, args.updatedBy);
  const clientId = readRefreshOnlyClientId();
  if (clientId) {
    await upsertVaultSecret(args.supabase, "business_client_id", clientId, args.updatedBy);
  }
  let scopes_granted: string[] = [];
  const fromToken = parseRevolutBusinessGrantedScopes(args.tokens.scope);
  if (fromToken.length > 0) {
    const normalized = fromToken.join(",");
    for (const name of REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED_VAULT_NAMES) {
      await upsertVaultSecret(args.supabase, name, normalized, args.updatedBy);
    }
    scopes_granted = fromToken;
  } else {
    const existing = await readRefreshOnlyVaultTokens(args.supabase);
    scopes_granted = existing.scopes_granted;
  }
  return { expires_at: expiresAt, scopes_granted };
}
