/**
 * Slice 2 — ensure a usable Revolut Business access token before counterparty ops.
 * Refreshes via fixed-egress relay when vault access token is missing/expired.
 * Never logs token or private-key material. Never calls /pay.
 */

import { relayRevolutTokenExchange } from "./revolutBusinessRelayClient.ts";

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

const VAULT_PROVIDER = "revolut";
const VAULT_ENV = "live";
const REFRESH_SKEW_MS = 60_000;

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

async function upsertVaultSecret(
  supabase: AnySupabase,
  secretName: string,
  secretValue: string,
): Promise<void> {
  const { error } = await supabase.from("payment_provider_vault").upsert(
    {
      provider: VAULT_PROVIDER,
      environment: VAULT_ENV,
      secret_name: secretName,
      secret_value: secretValue,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider,environment,secret_name" },
  );
  if (error) throw error;
}

async function readVaultMap(supabase: AnySupabase): Promise<Map<string, string>> {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_name, secret_value")
    .eq("provider", VAULT_PROVIDER)
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

/**
 * Returns a usable access token. Refreshes via relay when expired/near-expiry.
 * Falls back to current vault/env token when refresh is unnecessary.
 */
export async function ensureFreshRevolutBusinessAccessToken(
  supabase: AnySupabase,
): Promise<{ accessToken: string; refreshed: boolean; note: string }> {
  const fromEnv = (Deno.env.get("REVOLUT_BUSINESS_ACCESS_TOKEN") ?? "").trim();
  const map = await readVaultMap(supabase);
  let access = pick(map, "business_access_token", "REVOLUT_BUSINESS_ACCESS_TOKEN") || fromEnv;
  const refresh = pick(map, "business_refresh_token", "REVOLUT_BUSINESS_REFRESH_TOKEN");
  const expiresRaw = pick(map, "business_token_expires_at", "REVOLUT_BUSINESS_TOKEN_EXPIRES_AT");
  const expiresMs = expiresRaw ? Date.parse(expiresRaw) : NaN;
  const expired = !access
    || (Number.isFinite(expiresMs) && expiresMs <= Date.now() + REFRESH_SKEW_MS);

  if (!expired && access) {
    return { accessToken: access, refreshed: false, note: "vault_token_fresh" };
  }
  if (!refresh) {
    if (access) return { accessToken: access, refreshed: false, note: "expired_no_refresh_token" };
    throw new Error("access_token_missing");
  }

  const assertion = await createClientAssertion();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
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
  const nextRefresh = String(json.refresh_token ?? "").trim() || refresh;
  const expiresIn = Number(json.expires_in ?? 2400);
  const expiresAt = new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString();

  await upsertVaultSecret(supabase, "business_access_token", nextAccess);
  await upsertVaultSecret(supabase, "REVOLUT_BUSINESS_ACCESS_TOKEN", nextAccess);
  await upsertVaultSecret(supabase, "business_refresh_token", nextRefresh);
  await upsertVaultSecret(supabase, "REVOLUT_BUSINESS_REFRESH_TOKEN", nextRefresh);
  await upsertVaultSecret(supabase, "business_token_expires_at", expiresAt);
  await upsertVaultSecret(supabase, "REVOLUT_BUSINESS_TOKEN_EXPIRES_AT", expiresAt);

  return { accessToken: nextAccess, refreshed: true, note: "refreshed_via_relay" };
}
