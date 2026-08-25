/**
 * Step 9.4B — Revolut Business OAuth refresh-only SSOT.
 * Never /pay, payee, transfer, payout finalizer, or wallet writers.
 */
import { REVOLUT_BUSINESS_TOKEN_URL_PROD } from "../../../shared/revolutBusinessOAuthSSOT.ts";

export const BUSINESS_OAUTH_REFRESH_ONLY_PATH =
  "admin-refresh-revolut-business-oauth" as const;

export const ALLOWED_TOKEN_ENDPOINTS = [
  REVOLUT_BUSINESS_TOKEN_URL_PROD,
  "relay:/v1/revolut/auth/token",
] as const;

export const ALLOWED_TOKEN_TYPES = ["bearer", "Bearer"] as const;
export const MIN_EXPIRES_IN = 60;
export const MAX_EXPIRES_IN = 86_400;
/** Required for status GET /transaction after refresh. */
export const REQUIRED_SCOPE_TOKENS = ["READ"] as const;

export const FORBIDDEN_REFRESH_IMPORT_MARKERS = [
  "executeRevolutPay",
  '"/pay"',
  "createRevolutCounterparty",
  "finalize_driver_payout_completion",
  "creditCapturedCardTripLedger",
  "claim_driver_payout_submission",
  "relayApprovedDriverPayoutPay",
] as const;

export type SafeTokenFingerprint = {
  prefix_class: string;
  len: number;
  sha256_12: string;
};

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintSecret(value: string | null | undefined): Promise<SafeTokenFingerprint | null> {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const sha = await sha256Hex(v);
  let prefix_class = "other";
  if (v.startsWith("oa_prod_")) prefix_class = "oa_prod_";
  else if (v.startsWith("oa_sand_")) prefix_class = "oa_sand_";
  else if (v.includes("BEGIN") && v.includes("PRIVATE KEY")) prefix_class = "pem_private_key";
  return { prefix_class, len: v.length, sha256_12: sha.slice(0, 12) };
}

export type TokenResponseValidation =
  | {
    ok: true;
    access_token: string;
    refresh_token: string | null;
    token_type: string;
    expires_in: number;
    scope: string | null;
    scope_tokens: string[];
  }
  | {
    ok: false;
    code:
      | "missing_access_token"
      | "invalid_token_type"
      | "expires_in_out_of_bounds"
      | "scope_missing_required"
      | "malformed";
    message: string;
  };

export function parseScopeTokens(scope: string | null | undefined): string[] {
  if (!scope || !String(scope).trim()) return [];
  return String(scope)
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => (s === "PAYMENT" ? "PAY" : s));
}

export function validateBusinessOAuthTokenResponse(
  json: Record<string, unknown> | null | undefined,
  opts?: { requireScope?: boolean; priorScopeTokens?: string[] },
): TokenResponseValidation {
  if (!json || typeof json !== "object") {
    return { ok: false, code: "malformed", message: "empty_token_response" };
  }
  const access = String(json.access_token ?? "").trim();
  if (!access) {
    return { ok: false, code: "missing_access_token", message: "access_token missing" };
  }
  const tokenType = String(json.token_type ?? "bearer").trim();
  if (!ALLOWED_TOKEN_TYPES.map((t) => t.toLowerCase()).includes(tokenType.toLowerCase())) {
    return { ok: false, code: "invalid_token_type", message: `token_type=${tokenType}` };
  }
  const expiresIn = Number(json.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn < MIN_EXPIRES_IN || expiresIn > MAX_EXPIRES_IN) {
    return {
      ok: false,
      code: "expires_in_out_of_bounds",
      message: `expires_in=${String(json.expires_in)}`,
    };
  }
  const scopeRaw = typeof json.scope === "string" ? json.scope.trim() : null;
  let scopeTokens = parseScopeTokens(scopeRaw);
  if (scopeTokens.length === 0 && opts?.priorScopeTokens?.length) {
    scopeTokens = [...opts.priorScopeTokens];
  }
  const requireScope = opts?.requireScope !== false;
  if (requireScope) {
    const hasRequired = REQUIRED_SCOPE_TOKENS.every((r) => scopeTokens.includes(r));
    if (!hasRequired) {
      return {
        ok: false,
        code: "scope_missing_required",
        message: `scope=${scopeTokens.join(",") || "empty"}`,
      };
    }
  }
  const refresh = typeof json.refresh_token === "string" && json.refresh_token.trim()
    ? json.refresh_token.trim()
    : null;
  return {
    ok: true,
    access_token: access,
    refresh_token: refresh,
    token_type: tokenType.toLowerCase() === "bearer" ? "bearer" : tokenType,
    expires_in: Math.floor(expiresIn),
    scope: scopeRaw,
    scope_tokens: scopeTokens,
  };
}

export function classifyRefreshHttpFailure(status: number, body: Record<string, unknown> | null): {
  code: "REVOLUT_BUSINESS_REAUTHORISATION_REQUIRED" | "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED";
  message: string;
  write: false;
} {
  const desc = String(
    body?.error_description ?? body?.error ?? `http_${status}`,
  ).slice(0, 180);
  const err = String(body?.error ?? "").toLowerCase();
  if (
    status === 400 || status === 401 || status === 403
  ) {
    if (
      /invalid_grant|expired|revoked|reauth|unauthorized_client|invalid_token/i.test(desc)
      || /invalid_grant|invalid_token/.test(err)
    ) {
      return {
        code: "REVOLUT_BUSINESS_REAUTHORISATION_REQUIRED",
        message: desc,
        write: false,
      };
    }
    return { code: "PROVIDER_REJECTED", message: desc, write: false };
  }
  if (status === 429 || status >= 500 || status === 0) {
    return { code: "PROVIDER_UNAVAILABLE", message: desc, write: false };
  }
  return { code: "PROVIDER_REJECTED", message: desc, write: false };
}

/**
 * Concurrent stale refresh must not overwrite a newer vault expiry.
 * refreshStartedAtMs = wall clock when this refresh began.
 * vaultExpiresAtIso = vault value re-read after provider response, before write.
 * If vault already has a later expiry than this refresh started (another writer won), skip.
 */
export function shouldPersistRefreshAgainstConcurrentVault(args: {
  refreshStartedAtMs: number;
  vaultExpiresAtIso: string | null;
  vaultUpdatedAtIso?: string | null;
}): { persist: boolean; reason: string } {
  const vaultExp = args.vaultExpiresAtIso ? Date.parse(args.vaultExpiresAtIso) : NaN;
  if (Number.isFinite(vaultExp) && vaultExp > args.refreshStartedAtMs + 30_000) {
    return {
      persist: false,
      reason: "vault_already_has_newer_expiry",
    };
  }
  const updated = args.vaultUpdatedAtIso ? Date.parse(args.vaultUpdatedAtIso) : NaN;
  if (Number.isFinite(updated) && updated > args.refreshStartedAtMs) {
    return { persist: false, reason: "vault_updated_during_refresh" };
  }
  return { persist: true, reason: "ok" };
}

export function resolveRefreshTokenToStore(args: {
  providerRefreshToken: string | null;
  existingRefreshToken: string;
}): { refresh_token: string; rotated: boolean } {
  if (args.providerRefreshToken && args.providerRefreshToken !== args.existingRefreshToken) {
    return { refresh_token: args.providerRefreshToken, rotated: true };
  }
  // Provider omitted refresh → preserve existing (Revolut refresh contract).
  return { refresh_token: args.existingRefreshToken, rotated: false };
}

export function assertRefreshOnlySourceHasNoMoneyWriters(source: string): {
  ok: boolean;
  hits: string[];
} {
  // Ignore the allow-list constant that documents forbidden markers.
  const scrubbed = source.replace(
    /export const FORBIDDEN_REFRESH_IMPORT_MARKERS[\s\S]*?\] as const;/g,
    "",
  );
  const hits = FORBIDDEN_REFRESH_IMPORT_MARKERS.filter((m) => scrubbed.includes(m));
  return { ok: hits.length === 0, hits };
}

export function buildSafeRefreshResponse(args: {
  environment: "live";
  token_type: string;
  expires_at: string;
  scope_tokens: string[];
  access_before: SafeTokenFingerprint | null;
  access_after: SafeTokenFingerprint;
  refresh_before: SafeTokenFingerprint | null;
  refresh_after: SafeTokenFingerprint;
  refresh_rotated: boolean;
  private_key: SafeTokenFingerprint | null;
}): Record<string, unknown> {
  return {
    success: true,
    environment: args.environment,
    token_type: args.token_type,
    expires_at: args.expires_at,
    scope_classification: args.scope_tokens,
    required_scope_present: REQUIRED_SCOPE_TOKENS.every((r) =>
      args.scope_tokens.includes(r)
    ),
    access_token_fingerprint: {
      before: args.access_before,
      after: args.access_after,
      changed: args.access_before?.sha256_12 !== args.access_after.sha256_12,
    },
    refresh_token_fingerprint: {
      before: args.refresh_before,
      after: args.refresh_after,
      changed: args.refresh_before?.sha256_12 !== args.refresh_after.sha256_12,
      rotated: args.refresh_rotated,
    },
    private_key_fingerprint: args.private_key,
    private_key_unchanged: true,
    revolut_pay_called: false,
    provider_mutation: "TOKEN_REFRESH_ONLY",
  };
}
