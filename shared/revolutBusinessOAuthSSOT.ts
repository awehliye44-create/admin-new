/**
 * Revolut Business API OAuth SSOT — authorization URL + safe diagnostics shapes.
 * Token values never belong in DTOs returned to the browser.
 */

export const REVOLUT_BUSINESS_OAUTH_VERSION = "revolut_business_oauth_ssot_v4";

/**
 * LIVE payout / company-transfer execution gate.
 * Default false — OAuth may request PAY scope for consent, but execution stays off until env unlock.
 */
export function parseLivePayoutExecutionEnabled(
  envGet?: (key: string) => string | undefined | null,
): boolean {
  const read = envGet ?? (() => undefined);
  const a = String(read("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "").trim().toLowerCase();
  const b = String(read("ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED") ?? "").trim().toLowerCase();
  return a === "true" || b === "true";
}

/**
 * Defaults match the live Revolut certificate registration (adminonecab.net).
 * Override via Deno env REVOLUT_BUSINESS_REDIRECT_URI / REVOLUT_BUSINESS_JWT_ISS
 * when the certificate redirect host is changed (e.g. to the Edge callback).
 */
export const REVOLUT_BUSINESS_REDIRECT_URI_DEFAULT =
  "https://adminonecab.net/auth/revolut/callback";

export const REVOLUT_BUSINESS_JWT_ISS_DEFAULT = "adminonecab.net";

/** Backend-only Edge callback (preferred once Revolut redirect URI is updated). */
export const REVOLUT_BUSINESS_REDIRECT_URI_EDGE =
  "https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/admin-revolut-business-oauth-callback";

export const REVOLUT_BUSINESS_JWT_ISS_EDGE = "thazislrdkjpvvghtvzo.supabase.co";

/** @deprecated use resolveRevolutBusinessRedirectUri() */
export const REVOLUT_BUSINESS_REDIRECT_URI = REVOLUT_BUSINESS_REDIRECT_URI_DEFAULT;

/** @deprecated use resolveRevolutBusinessJwtIss() */
export const REVOLUT_BUSINESS_JWT_ISS = REVOLUT_BUSINESS_JWT_ISS_DEFAULT;

/** Legacy alias */
export const REVOLUT_BUSINESS_REDIRECT_URI_LEGACY_ADMIN =
  REVOLUT_BUSINESS_REDIRECT_URI_DEFAULT;

export function resolveRevolutBusinessRedirectUri(envGet?: (k: string) => string | undefined): string {
  const read = envGet ?? ((k: string) => {
    try {
      return typeof globalThis !== "undefined"
        && "Deno" in globalThis
        // deno-lint-ignore no-explicit-any
        && typeof (globalThis as any).Deno?.env?.get === "function"
        // deno-lint-ignore no-explicit-any
        ? (globalThis as any).Deno.env.get(k) as string | undefined
        : undefined;
    } catch {
      return undefined;
    }
  });
  const fromEnv = String(read("REVOLUT_BUSINESS_REDIRECT_URI") ?? "").trim();
  return fromEnv || REVOLUT_BUSINESS_REDIRECT_URI_DEFAULT;
}

export function resolveRevolutBusinessJwtIss(envGet?: (k: string) => string | undefined): string {
  const read = envGet ?? ((k: string) => {
    try {
      return typeof globalThis !== "undefined"
        && "Deno" in globalThis
        // deno-lint-ignore no-explicit-any
        && typeof (globalThis as any).Deno?.env?.get === "function"
        // deno-lint-ignore no-explicit-any
        ? (globalThis as any).Deno.env.get(k) as string | undefined
        : undefined;
    } catch {
      return undefined;
    }
  });
  const fromEnv = String(read("REVOLUT_BUSINESS_JWT_ISS") ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    return new URL(resolveRevolutBusinessRedirectUri(read)).host;
  } catch {
    return REVOLUT_BUSINESS_JWT_ISS_DEFAULT;
  }
}



export const REVOLUT_BUSINESS_TOKEN_URL_PROD =
  "https://b2b.revolut.com/api/1.0/auth/token";

export const REVOLUT_BUSINESS_AUTHORIZE_BASE =
  "https://business.revolut.com/app-confirm";

/**
 * Revolut Business consent scopes for Connect (authorize URL).
 * Official format is comma-separated (see Revolut Business API docs: scope=READ,WRITE,PAY).
 * Requesting PAY grants payment permission after user consent — it does NOT unlock /pay execution
 * while LIVE_PAYOUT_EXECUTION_ENABLED=false and the relay denylist remains.
 */
export const REVOLUT_BUSINESS_OAUTH_SCOPE = "READ,WRITE,PAY";

/**
 * Pre-consent / unknown default for linkage capability checks.
 * Never pretends WRITE/PAY are granted; vault/env SCOPES_GRANTED overrides after real consent.
 * Never use REVOLUT_BUSINESS_OAUTH_SCOPE (requested) as a stand-in for granted capabilities.
 */
export const REVOLUT_BUSINESS_OAUTH_SCOPE_GRANTED_DEFAULT = "READ";

/** Vault + optional edge-secret names for scopes actually granted post-exchange. */
export const REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED_VAULT_NAMES = [
  "business_oauth_scopes_granted",
  "REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED",
] as const;

/** Allowed OAuth consent scopes (Revolut Business). PAYMENT is normalized to PAY. */
export const REVOLUT_BUSINESS_OAUTH_SCOPE_ALLOWED = ["READ", "WRITE", "PAY"] as const;

/** Rejected on Connect / consent URLs (alias handled separately). */
export const REVOLUT_BUSINESS_OAUTH_SCOPE_FORBIDDEN = [] as const;

export function parseRevolutBusinessGrantedScopes(
  raw: string | null | undefined,
): string[] {
  const parts = String(raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => (s === "PAYMENT" ? "PAY" : s));
  const uniq: string[] = [];
  for (const p of parts) {
    if (!uniq.includes(p)) uniq.push(p);
  }
  return uniq;
}

export function normalizeRevolutBusinessOAuthScope(scope: string): string {
  const uniq = parseRevolutBusinessGrantedScopes(scope);
  const allowed = new Set<string>(REVOLUT_BUSINESS_OAUTH_SCOPE_ALLOWED);
  for (const part of uniq) {
    if (!allowed.has(part)) {
      throw new Error(`Revolut Business OAuth must not request ${part}`);
    }
  }
  if (uniq.length === 0) return REVOLUT_BUSINESS_OAUTH_SCOPE;
  // Stable Revolut order when the Connect default set is present.
  if (
    uniq.includes("READ") && uniq.includes("WRITE") && uniq.includes("PAY") && uniq.length === 3
  ) {
    return REVOLUT_BUSINESS_OAUTH_SCOPE;
  }
  return uniq.join(",");
}

/** Live ONECAB Business API certificate Client ID (not legacy/deleted certs). */
export const REVOLUT_BUSINESS_CLIENT_ID_EXPECTED =
  "nxcWDqtt6QzxEnnXCUhOw4fr8C7E1wX1WdMv6chwQNI";

/** Revolut production IP whitelist — Lightsail static egress. */
export const REVOLUT_BUSINESS_RELAY_WHITELIST_IP = "63.186.194.116";

export type RevolutBusinessConnectionStatus =
  | "NOT_CONFIGURED"
  | "AWAITING_CONSENT"
  | "TOKEN_PRESENT"
  | "TOKEN_EXPIRED"
  | "ERROR";

export type RevolutBusinessAccountDiag = {
  id: string;
  name: string | null;
  currency: string | null;
  state: string | null;
  balance_major: number | null;
  balance_pence: number | null;
  is_gbp: boolean;
};

export type RevolutBusinessRelayDiagnostics = {
  configured: boolean;
  base_url: string | null;
  shared_secret_configured: boolean;
  public_health_ok: boolean | null;
  egress_ip: string | null;
  egress_ip_matches_whitelist: boolean | null;
  whitelist_ip: string;
};

export type RevolutBusinessDiagnosticsDto = {
  version: string;
  connection_status: RevolutBusinessConnectionStatus;
  client_id_configured: boolean;
  client_id_source: string;
  client_id_matches_certificate: boolean;
  client_id_hint: string | null;
  certificate_configured: boolean;
  private_key_configured: boolean;
  oauth_connected: boolean;
  access_token_configured: boolean;
  refresh_token_configured: boolean;
  token_valid: boolean;
  token_expires_at: string | null;
  token_expires_in_seconds: number | null;
  redirect_uri: string;
  jwt_iss: string;
  /** Scopes requested on Connect authorize URL (includes PAY for consent; not an execution unlock). */
  oauth_scope: string;
  /** Scopes actually granted after exchange — from vault/token; empty before consent. */
  oauth_scopes_granted: string[];
  live_payout_execution_enabled: boolean;
  /** Always true while LIVE=false / relay denylist — PAY consent ≠ payment execution. */
  payment_execution_blocked: boolean;
  relay: RevolutBusinessRelayDiagnostics;
  egress_public_ip: string | null;
  egress_ip_fixed_proven: boolean;
  whitelist_recommendation: string;
  accounts: RevolutBusinessAccountDiag[];
  gbp_accounts: RevolutBusinessAccountDiag[];
  gbp_source_account_id: string | null;
  gbp_balance_pence: number | null;
  selected_source_account_id: string | null;
  selected_source_account_ok: boolean | null;
  selected_source_account_label?: string | null;
  selected_source_last_verified_at?: string | null;
  message: string | null;
};

export function buildRevolutBusinessAuthorizationUrl(args: {
  clientId: string;
  redirectUri?: string;
  scope?: string;
  state?: string | null;
}): string {
  const clientId = String(args.clientId ?? "").trim();
  if (!clientId) throw new Error("client_id required");
  const redirectUri = String(args.redirectUri ?? resolveRevolutBusinessRedirectUri()).trim();
  const scope = normalizeRevolutBusinessOAuthScope(
    String(args.scope ?? REVOLUT_BUSINESS_OAUTH_SCOPE).trim() || REVOLUT_BUSINESS_OAUTH_SCOPE,
  );
  const url = new URL(REVOLUT_BUSINESS_AUTHORIZE_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  if (args.state) url.searchParams.set("state", String(args.state));
  return url.toString();
}


export function majorUnitsToPence(balance: unknown): number | null {
  if (balance == null || !Number.isFinite(Number(balance))) return null;
  const n = Number(balance);
  if (Number.isInteger(n) && Math.abs(n) >= 1000 && String(n).length >= 4 && !String(balance).includes(".")) {
    return Math.round(n);
  }
  return Math.round(n * 100);
}

export function mapRevolutAccountDiag(row: {
  id?: unknown;
  name?: unknown;
  currency?: unknown;
  state?: unknown;
  balance?: unknown;
}): RevolutBusinessAccountDiag {
  const currency = row.currency == null ? null : String(row.currency).toUpperCase();
  const balance_pence = majorUnitsToPence(row.balance);
  return {
    id: String(row.id ?? ""),
    name: row.name == null ? null : String(row.name),
    currency,
    state: row.state == null ? null : String(row.state),
    balance_major: balance_pence == null ? null : balance_pence / 100,
    balance_pence,
    is_gbp: currency === "GBP",
  };
}

export function resolveConnectionStatus(args: {
  clientIdConfigured: boolean;
  privateKeyConfigured: boolean;
  accessTokenConfigured: boolean;
  tokenExpiresAt: string | null;
  now?: Date;
}): RevolutBusinessConnectionStatus {
  if (!args.clientIdConfigured || !args.privateKeyConfigured) return "NOT_CONFIGURED";
  if (!args.accessTokenConfigured) return "AWAITING_CONSENT";
  if (args.tokenExpiresAt) {
    const exp = Date.parse(args.tokenExpiresAt);
    if (Number.isFinite(exp) && exp <= (args.now ?? new Date()).getTime()) {
      return "TOKEN_EXPIRED";
    }
  }
  return "TOKEN_PRESENT";
}
