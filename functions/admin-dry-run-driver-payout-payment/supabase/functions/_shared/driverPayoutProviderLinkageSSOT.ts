/**
 * Slice 2 â Revolut Business counterparty/recipient linkage SSOT.
 * Linkage only. Never initiates /pay or wallet mutation.
 */

/**
 * Pre-consent default when vault/env has no granted-scopes record.
 * Never hardcodes forever-READ once WRITE can be granted via vault after Connect.
 */
export const REVOLUT_BUSINESS_OAUTH_SCOPE_GRANTED = "READ";

export const PROVIDER_LINK_STATUS = {
  NOT_LINKED: "NOT_LINKED",
  MATCH_PENDING: "MATCH_PENDING",
  CREATE_PENDING: "CREATE_PENDING",
  COUNTERPARTY_LINKED: "COUNTERPARTY_LINKED",
  RECIPIENT_LINKED: "RECIPIENT_LINKED",
  PROVIDER_VERIFIED: "PROVIDER_VERIFIED",
  BLOCKED_BY_OAUTH_SCOPE: "BLOCKED_BY_OAUTH_SCOPE",
  CONFLICT: "CONFLICT",
  FAILED: "FAILED",
  DISABLED: "DISABLED",
} as const;

export type ProviderLinkStatus = (typeof PROVIDER_LINK_STATUS)[keyof typeof PROVIDER_LINK_STATUS];

export const LINKAGE_ERROR = {
  DESTINATION_NOT_FOUND: "DESTINATION_NOT_FOUND",
  DESTINATION_NOT_VERIFIED: "DESTINATION_NOT_VERIFIED",
  DESTINATION_DECRYPTION_FAILED: "DESTINATION_DECRYPTION_FAILED",
  INVALID_UK_BANK_DESTINATION: "INVALID_UK_BANK_DESTINATION",
  BLOCKED_BY_OAUTH_SCOPE: "BLOCKED_BY_OAUTH_SCOPE",
  COUNTERPARTY_MATCH_CONFLICT: "COUNTERPARTY_MATCH_CONFLICT",
  COUNTERPARTY_CREATE_FAILED: "COUNTERPARTY_CREATE_FAILED",
  RECIPIENT_ACCOUNT_CREATE_FAILED: "RECIPIENT_ACCOUNT_CREATE_FAILED",
  PROVIDER_RESPONSE_INVALID: "PROVIDER_RESPONSE_INVALID",
  RELAY_UNAVAILABLE: "RELAY_UNAVAILABLE",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
} as const;

/** Revolut Business OAuth scopes required for create mutations. */
export const REVOLUT_COUNTERPARTY_CREATE_SCOPE = "WRITE";
export const REVOLUT_RECIPIENT_CREATE_SCOPE = "WRITE";

const SCOPES_GRANTED_VAULT_NAMES = [
  "business_oauth_scopes_granted",
  "REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED",
] as const;

export function parseGrantedRevolutBusinessScopes(
  raw: string | null | undefined,
): string[] {
  const parts = String(raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const uniq: string[] = [];
  for (const p of parts) {
    if (!uniq.includes(p)) uniq.push(p);
  }
  return uniq;
}

/**
 * Sync env-only fallback. Uses SCOPES_GRANTED only â never REVOLUT_BUSINESS_OAUTH_SCOPE
 * (that name is the Connect *requested* scope and must not fake WRITE pre-consent).
 */
export function currentGrantedRevolutBusinessScopes(): string[] {
  const fromEnv = parseGrantedRevolutBusinessScopes(
    Deno.env.get("REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED"),
  );
  if (fromEnv.length > 0) return fromEnv;
  return [REVOLUT_BUSINESS_OAUTH_SCOPE_GRANTED];
}

/** Preferred: vault (post-exchange) â explicit SCOPES_GRANTED secret â READ default. */
export async function resolveGrantedRevolutBusinessScopes(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("payment_provider_vault")
      .select("secret_name, secret_value")
      .eq("provider", "revolut")
      .eq("environment", "live")
      .in("secret_name", [...SCOPES_GRANTED_VAULT_NAMES]);
    const map = new Map<string, string>();
    for (const row of data ?? []) {
      map.set(String(row.secret_name), String(row.secret_value ?? ""));
    }
    const fromVault = parseGrantedRevolutBusinessScopes(
      map.get("business_oauth_scopes_granted")
        ?? map.get("REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED"),
    );
    if (fromVault.length > 0) return fromVault;
  } catch {
    // fall through to env / default
  }
  return currentGrantedRevolutBusinessScopes();
}

export function revolutScopeAllows(args: {
  granted: string[];
  required: string;
}): boolean {
  const granted = args.granted.map((s) => s.trim().toUpperCase());
  const required = args.required.trim().toUpperCase();
  if (granted.includes(required)) return true;
  if (required === "WRITE" && (granted.includes("PAYMENT") || granted.includes("WRITE"))) {
    return true;
  }
  return false;
}

export function counterpartyIdempotencyKey(driverId: string, destinationId: string): string {
  return `driver-counterparty:${driverId}:${destinationId}`;
}

export function recipientIdempotencyKey(driverId: string, destinationId: string): string {
  return `driver-recipient:${driverId}:${destinationId}`;
}

export function maskProviderId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (trimmed.length <= 8) return "â¢â¢â¢â¢";
  return `${trimmed.slice(0, 4)}â¦${trimmed.slice(-4)}`;
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 fingerprint â never store raw fingerprint input. */
export async function bankDestinationFingerprint(args: {
  sortCode: string;
  accountNumber: string;
  currency: string;
  country: string;
}): Promise<string> {
  const sort = args.sortCode.replace(/\D/g, "");
  const acct = args.accountNumber.replace(/\D/g, "");
  const currency = args.currency.trim().toUpperCase();
  const country = args.country.trim().toUpperCase();
  const material = `ukbank|${country}|${currency}|${sort}|${acct}`;
  const seed = Deno.env.get("PAYOUT_DESTINATION_ENCRYPTION_KEY")?.trim()
    || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    || "onecab-payout-destination-default-key";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(seed),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(material));
  return encodeHex(new Uint8Array(sig));
}

export function normalizeAccountHolderName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Revolut Business POST /counterparty for non-Revtag bank details requires
 * `individual_name` (personal) or `company_name` (business) â not flat `name`.
 * See Revolut docs: Create a counterparty â Counterparty name.
 */
export function splitIndividualName(fullName: string): {
  first_name: string;
  last_name: string;
} {
  const normalized = normalizeAccountHolderName(fullName);
  if (!normalized) {
    return { first_name: "Driver", last_name: "Account" };
  }
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: parts[0] };
  }
  return {
    first_name: parts[0].slice(0, 40),
    last_name: parts.slice(1).join(" ").slice(0, 40),
  };
}

export type RevolutUkBankCounterpartyKind = "personal" | "business";

/**
 * Build Revolut Business UK bank counterparty create body.
 * Drivers use personal/`individual_name`. Never includes flat `name` for bank rails.
 * Uses top-level account_no + sort_code per Business API create examples.
 * Callers must never log the returned body (contains bank details).
 */
export function buildRevolutUkBankCounterpartyCreateBody(args: {
  kind: RevolutUkBankCounterpartyKind;
  accountHolderName: string;
  sortCode: string;
  accountNumber: string;
  currency?: string;
  bankCountry?: string;
}): Record<string, unknown> {
  const currency = (args.currency ?? "GBP").toUpperCase();
  const bank_country = (args.bankCountry ?? "GB").toUpperCase();
  const sort_code = digitsOnly(args.sortCode);
  const account_no = digitsOnly(args.accountNumber);
  const holder = normalizeAccountHolderName(args.accountHolderName);

  const body: Record<string, unknown> = {
    bank_country,
    currency,
    account_no,
    sort_code,
  };

  if (args.kind === "business") {
    body.company_name = holder || "Company";
  } else {
    // personal / driver UK bank â Revolut rejects flat `name` + profile_type alone
    body.individual_name = splitIndividualName(holder || "Driver Account");
  }

  return body;
}

export type ScopeCapability = {
  oauth_scopes_granted: string[];
  can_list_counterparties: boolean;
  can_create_counterparties: boolean;
  can_list_recipient_accounts: boolean;
  can_create_recipient_accounts: boolean;
  required_scope_for_create: string;
};

export function resolveRevolutLinkageCapabilities(
  grantedScopes: string[] = currentGrantedRevolutBusinessScopes(),
): ScopeCapability {
  const canWrite = revolutScopeAllows({
    granted: grantedScopes,
    required: REVOLUT_COUNTERPARTY_CREATE_SCOPE,
  });
  const canRead = grantedScopes.some((s) => {
    const u = s.toUpperCase();
    return u === "READ" || u === "WRITE" || u === "PAYMENT" || u === "PAY";
  });
  return {
    oauth_scopes_granted: grantedScopes,
    can_list_counterparties: canRead,
    can_create_counterparties: canWrite,
    can_list_recipient_accounts: canRead,
    can_create_recipient_accounts: canWrite,
    required_scope_for_create: REVOLUT_COUNTERPARTY_CREATE_SCOPE,
  };
}

/** Digits-only UK bank compare helpers â never log plaintext inputs. */
export function digitsOnly(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function ukBankDetailsMatch(args: {
  sortCode: string;
  accountNumber: string;
  candidateSortCode: string | null | undefined;
  candidateAccountNumber: string | null | undefined;
}): boolean {
  const sort = digitsOnly(args.sortCode);
  const acct = digitsOnly(args.accountNumber);
  const candSort = digitsOnly(args.candidateSortCode);
  const candAcct = digitsOnly(args.candidateAccountNumber);
  if (sort.length !== 6 || acct.length < 8 || candSort.length !== 6 || candAcct.length < 8) {
    return false;
  }
  return sort === candSort && acct === candAcct;
}

export type RevolutCounterpartyAccountLike = {
  id?: unknown;
  account_no?: unknown;
  account_number?: unknown;
  sort_code?: unknown;
  type?: unknown;
  currency?: unknown;
};

export type RevolutCounterpartyLike = {
  id?: unknown;
  name?: unknown;
  accounts?: RevolutCounterpartyAccountLike[] | null;
};

export type CounterpartyMatchHit = {
  counterparty_id: string;
  recipient_account_id: string;
};

/**
 * Match a UK bank destination against Revolut Business counterparties list.
 * Returns unique hit, null (none), or throws conflict via multiHit flag.
 */
export function matchUkBankAgainstCounterparties(args: {
  sortCode: string;
  accountNumber: string;
  counterparties: RevolutCounterpartyLike[];
}): { status: "none" | "unique" | "conflict"; hit: CounterpartyMatchHit | null; hit_count: number } {
  const hits: CounterpartyMatchHit[] = [];
  for (const cp of args.counterparties) {
    const cpId = String(cp?.id ?? "").trim();
    if (!cpId) continue;
    const accounts = Array.isArray(cp.accounts) ? cp.accounts : [];
    for (const acct of accounts) {
      const acctId = String(acct?.id ?? "").trim();
      if (!acctId) continue;
      const currency = String(acct?.currency ?? "GBP").toUpperCase();
      if (currency && currency !== "GBP") continue;
      const candSort = String(acct?.sort_code ?? "");
      const candAcct = String(acct?.account_no ?? acct?.account_number ?? "");
      if (
        ukBankDetailsMatch({
          sortCode: args.sortCode,
          accountNumber: args.accountNumber,
          candidateSortCode: candSort,
          candidateAccountNumber: candAcct,
        })
      ) {
        hits.push({ counterparty_id: cpId, recipient_account_id: acctId });
      }
    }
  }
  const uniqueKeys = new Set(hits.map((h) => `${h.counterparty_id}:${h.recipient_account_id}`));
  if (uniqueKeys.size === 0) return { status: "none", hit: null, hit_count: 0 };
  if (uniqueKeys.size > 1) return { status: "conflict", hit: null, hit_count: uniqueKeys.size };
  return { status: "unique", hit: hits[0], hit_count: 1 };
}

/** Money-safety invariants for Slice 2 runners â must always hold. */
export function assertSlice2MoneySafety(flags: {
  revolut_pay_called: boolean;
  wallet_mutated: boolean;
  live_payout_execution_enabled: boolean;
}): void {
  if (flags.revolut_pay_called) throw new Error("slice2_invariant_pay_called");
  if (flags.wallet_mutated) throw new Error("slice2_invariant_wallet_mutated");
  if (flags.live_payout_execution_enabled) throw new Error("slice2_invariant_live_payout_enabled");
}

export function decideLinkageAfterDiscovery(args: {
  capabilities: ScopeCapability;
  matchStatus: "none" | "unique" | "conflict" | "discovery_unavailable";
}): {
  provider_link_status: ProviderLinkStatus;
  blocking_reason: string | null;
  may_create: boolean;
} {
  if (args.matchStatus === "conflict") {
    return {
      provider_link_status: PROVIDER_LINK_STATUS.CONFLICT,
      blocking_reason: LINKAGE_ERROR.COUNTERPARTY_MATCH_CONFLICT,
      may_create: false,
    };
  }
  if (args.matchStatus === "unique") {
    return {
      provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
      blocking_reason: null,
      may_create: false,
    };
  }
  // Match-before-create requires list discovery; never create when list was unavailable.
  if (args.matchStatus === "discovery_unavailable") {
    if (!args.capabilities.can_create_counterparties) {
      return {
        provider_link_status: PROVIDER_LINK_STATUS.BLOCKED_BY_OAUTH_SCOPE,
        blocking_reason: LINKAGE_ERROR.BLOCKED_BY_OAUTH_SCOPE,
        may_create: false,
      };
    }
    return {
      provider_link_status: PROVIDER_LINK_STATUS.FAILED,
      blocking_reason: LINKAGE_ERROR.RELAY_UNAVAILABLE,
      may_create: false,
    };
  }

  // matchStatus === "none" â create only with WRITE
  if (!args.capabilities.can_create_counterparties) {
    return {
      provider_link_status: PROVIDER_LINK_STATUS.BLOCKED_BY_OAUTH_SCOPE,
      blocking_reason: LINKAGE_ERROR.BLOCKED_BY_OAUTH_SCOPE,
      may_create: false,
    };
  }
  return {
    provider_link_status: PROVIDER_LINK_STATUS.CREATE_PENDING,
    blocking_reason: null,
    may_create: true,
  };
}
