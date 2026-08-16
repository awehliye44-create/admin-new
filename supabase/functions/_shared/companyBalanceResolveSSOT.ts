/**
 * Runtime company-balance resolution — Revolut Business /accounts only.
 * Never uses Driver Wallet, merchant order stubs, or invented £0.
 * Source account comes only from Use-as-source persistence — never inferred.
 */
// deno-lint-ignore no-explicit-any
type AnySupabase = any;

import {
  COMPANY_BALANCE_ERROR,
  resolveCompanyBalanceSnapshot,
  type CompanyBalanceSnapshot,
  type CompanyBalanceStatusCode,
} from "./companyBalanceSSOT.ts";
import { listRevolutAccounts, type RevolutAccount } from "./revolutApi.ts";
import {
  persistRevolutBusinessTokens,
  refreshRevolutBusinessAccessToken,
} from "./revolutBusinessOAuthSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayRevolutAccounts,
} from "./revolutBusinessRelayClient.ts";
import { loadPaymentSessionsNetCommissionPence } from "./payoutLedgerCompanyFundingCommissionSSOT.ts";
import { resolveLoadedOperationalReserve } from "./companyOperationalReserveLoadSSOT.ts";

/**
 * Production Revolut Business /accounts must use the fixed-IP relay when configured.
 * Direct Edge fetch to b2b.revolut.com is rejected (401/403 → AUTHENTICATION_REQUIRED)
 * because only the relay egress IP is whitelisted — same path as token refresh + /pay.
 *
 * Fallback policy:
 * - Relay configured → relay is authoritative. Never silently fall back to direct
 *   Edge fetch on relay auth/network failure (that would hide infrastructure issues).
 * - Relay not configured → direct `listRevolutAccounts` only (local/dev).
 */
export function normalizeRelayAccountsBody(body: unknown): RevolutAccount[] {
  if (Array.isArray(body)) return body as RevolutAccount[];
  if (body && typeof body === "object" && Array.isArray((body as { accounts?: unknown }).accounts)) {
    return (body as { accounts: RevolutAccount[] }).accounts;
  }
  return [];
}

export async function listCompanyBalanceAccounts(accessToken: string): Promise<RevolutAccount[]> {
  if (isRevolutBusinessRelayConfigured()) {
    const res = await relayRevolutAccounts(accessToken);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = typeof body === "object" && body && "message" in body
        ? String((body as { message?: string }).message)
        : typeof body === "object" && body && "error" in body
        ? String((body as { error?: string }).error)
        : `Revolut Business accounts relay error (${res.status})`;
      // Fail closed — do not fall back to direct public Edge fetch.
      throw { message, status: res.status, body };
    }
    return normalizeRelayAccountsBody(body);
  }
  // Dev/fallback only when relay is not configured.
  return listRevolutAccounts("live", accessToken);
}

async function readRevolutVault(supabase: AnySupabase, environment: "live" | "test"): Promise<{
  merchant_id: string | null;
  vault_merchant_id: string | null;
  business_access_token: string | null;
  business_refresh_token: string | null;
  token_expires_at: string | null;
  secret_key: string | null;
}> {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_name, secret_value")
    .eq("provider", "revolut")
    .eq("environment", environment);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(String(row.secret_name), String(row.secret_value ?? ""));
  }
  // Env fallbacks (never log values).
  const vault_merchant_id = (map.get("merchant_id") ?? "").trim() || null;
  const merchant_id = (
    vault_merchant_id
    ?? Deno.env.get("REVOLUT_SOURCE_BUSINESS_ACCOUNT_ID")
    ?? ""
  ).trim() || null;
  const business_access_token = (
    map.get("business_access_token")
    ?? map.get("REVOLUT_BUSINESS_ACCESS_TOKEN")
    ?? Deno.env.get("REVOLUT_BUSINESS_ACCESS_TOKEN")
    ?? ""
  ).trim() || null;
  const business_refresh_token = (
    map.get("business_refresh_token")
    ?? map.get("REVOLUT_BUSINESS_REFRESH_TOKEN")
    ?? Deno.env.get("REVOLUT_BUSINESS_REFRESH_TOKEN")
    ?? ""
  ).trim() || null;
  const token_expires_at = (
    map.get("business_token_expires_at")
    ?? map.get("REVOLUT_BUSINESS_TOKEN_EXPIRES_AT")
    ?? ""
  ).trim() || null;
  const secret_key = (map.get("secret_key") ?? "").trim() || null;
  return {
    merchant_id,
    vault_merchant_id,
    business_access_token,
    business_refresh_token,
    token_expires_at,
    secret_key,
  };
}

async function ensureBusinessAccessToken(args: {
  supabase: AnySupabase;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
}): Promise<string | null> {
  const expiresMs = args.expires_at ? Date.parse(args.expires_at) : NaN;
  const expired = !args.access_token
    || !Number.isFinite(expiresMs)
    || expiresMs <= Date.now() + 60_000;
  if (!expired && args.access_token) return args.access_token;
  if (!args.refresh_token) return args.access_token;
  try {
    const refreshed = await refreshRevolutBusinessAccessToken(args.refresh_token);
    await persistRevolutBusinessTokens({
      supabase: args.supabase,
      tokens: refreshed,
    });
    return refreshed.access_token;
  } catch (err) {
    console.warn(
      "[company-balance] business token refresh failed",
      err instanceof Error ? err.message : String(err),
    );
    return args.access_token;
  }
}

type PersistedSourceAccount = {
  id: string;
  revolut_account_id: string;
  account_name: string | null;
  account_status: string | null;
  currency: string;
  last_provider_sync_at: string | null;
};

async function readPersistedSourceAccount(
  supabase: AnySupabase,
  service_area_id?: string | null,
): Promise<PersistedSourceAccount | null> {
  try {
    let query = supabase
      .from("revolut_business_source_accounts")
      .select(
        "id, revolut_account_id, account_name, account_status, currency, last_provider_sync_at, service_area_id",
      )
      .eq("provider", "revolut_business")
      .eq("is_active", true)
      .eq("is_default_payout_source", true)
      .limit(5);
    if (service_area_id) {
      query = query.or(`service_area_id.eq.${service_area_id},service_area_id.is.null`);
    } else {
      query = query.is("service_area_id", null);
    }
    const { data, error } = await query;
    if (error) {
      // Table may not exist yet in older environments — fall through to vault.
      console.warn("[company-balance] source account table read failed", error.message);
      return null;
    }
    const rows = (data ?? []) as PersistedSourceAccount[];
    if (rows.length === 0) return null;
    // Prefer service-area scoped when filter present; otherwise global.
    if (service_area_id) {
      const scoped = rows.find((r) => (r as { service_area_id?: string | null }).service_area_id === service_area_id);
      if (scoped) return scoped;
    }
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[company-balance] source account read threw", err);
    return null;
  }
}

async function persistSourceBalanceSnapshot(args: {
  supabase: AnySupabase;
  revolut_account_id: string;
  balance_pence: number;
  available_pence: number;
  account_name?: string | null;
  account_status?: string | null;
}): Promise<void> {
  try {
    const now = new Date().toISOString();
    await args.supabase
      .from("revolut_business_source_accounts")
      .update({
        last_balance_pence: args.balance_pence,
        last_available_balance_pence: args.available_pence,
        last_verified_at: now,
        last_provider_sync_at: now,
        account_name: args.account_name ?? undefined,
        account_status: args.account_status ?? undefined,
        updated_at: now,
      })
      .eq("provider", "revolut_business")
      .eq("revolut_account_id", args.revolut_account_id);
  } catch (err) {
    console.warn("[company-balance] source balance persist failed", err);
  }
}

function accountBalanceToPence(account: RevolutAccount): {
  current_pence: number | null;
  available_pence: number | null;
} {
  // Revolut Business balances are major units (e.g. 12.34 GBP) unless clearly integer pence.
  const raw = account.balance;
  if (raw == null || !Number.isFinite(Number(raw))) {
    return { current_pence: null, available_pence: null };
  }
  const n = Number(raw);
  // Heuristic: values with fraction → major units; large integers may already be minor units.
  const pence = Number.isInteger(n) && Math.abs(n) >= 1000 && String(n).length >= 4 && !String(raw).includes(".")
    ? Math.round(n)
    : Math.round(n * 100);
  return { current_pence: pence, available_pence: pence };
}

function maskSourceLabel(args: {
  currency: string;
  accountId: string;
  accountName?: string | null;
}): string {
  const tail = args.accountId.slice(-6);
  const name = (args.accountName ?? "").trim();
  if (name) return `${name} (${args.currency} …${tail})`;
  return `Revolut Business ${args.currency} …${tail}`;
}

export async function resolveLiveCompanyBalanceSnapshot(args: {
  supabase?: AnySupabase;
  service_area_id?: string | null;
  currency?: string | null;
  approved_payables_pending_pence?: number | null;
  driver_liability_pence?: number | null;
  driver_payout_reserved_pence?: number | null;
  customer_refund_reserved_pence?: number | null;
  operational_reserve_pence?: number | null;
  refresh?: boolean;
}): Promise<CompanyBalanceSnapshot> {
  const currency = String(args.currency ?? "GBP").toUpperCase();
  const base = {
    service_area_id: args.service_area_id ?? null,
    currency,
    approved_payables_pending_pence: args.approved_payables_pending_pence ?? null,
    driver_liability_pence: args.driver_liability_pence ?? null,
    driver_payout_reserved_pence: args.driver_payout_reserved_pence ?? null,
    customer_refund_reserved_pence: args.customer_refund_reserved_pence ?? null,
    operational_reserve_pence: args.operational_reserve_pence ?? null,
  };

  if (!args.supabase) {
    return resolveCompanyBalanceSnapshot({
      ...base,
      status_code: COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED,
    });
  }

  let merchant_id: string | null = null;
  let businessToken: string | null = null;
  let persisted: PersistedSourceAccount | null = null;
  let accountName: string | null = null;
  try {
    persisted = await readPersistedSourceAccount(args.supabase, args.service_area_id);
    const live = await readRevolutVault(args.supabase, "live");
    // Canonical source = revolut_business_source_accounts only (Use as source).
    // Never infer from first GBP, Main, highest balance, or env.
    // Heal only: if Use-as-source wrote vault merchant_id but table row is missing
    // (e.g. table created after selection), backfill the SSOT row — do not invent.
    if (!persisted && live.vault_merchant_id) {
      const now = new Date().toISOString();
      const accountId = live.vault_merchant_id;
      try {
        await args.supabase
          .from("revolut_business_source_accounts")
          .update({ is_default_payout_source: false, updated_at: now })
          .eq("provider", "revolut_business")
          .eq("is_default_payout_source", true)
          .is("service_area_id", null);
        const { error: healError } = await args.supabase.from("revolut_business_source_accounts").upsert(
          {
            provider: "revolut_business",
            currency,
            revolut_account_id: accountId,
            is_active: true,
            is_default_payout_source: true,
            service_area_id: null,
            updated_at: now,
          },
          { onConflict: "provider,revolut_account_id" },
        );
        if (healError) {
          console.warn("[company-balance] vault→table heal failed", healError.message);
        } else {
          persisted = await readPersistedSourceAccount(args.supabase, args.service_area_id);
        }
      } catch (healErr) {
        console.warn("[company-balance] vault→table heal threw", healErr);
      }
    }
    merchant_id = persisted?.revolut_account_id ?? null;
    accountName = persisted?.account_name ?? null;
    businessToken = await ensureBusinessAccessToken({
      supabase: args.supabase,
      access_token: live.business_access_token,
      refresh_token: live.business_refresh_token,
      expires_at: live.token_expires_at,
    });
    if (!businessToken) {
      // Merchant sk_* is not a Business API token — do not use it as cash evidence.
      businessToken = null;
    }
  } catch (err) {
    console.warn("[company-balance] vault read failed", err);
    return resolveCompanyBalanceSnapshot({
      ...base,
      status_code: COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE,
    });
  }

  if (!merchant_id) {
    return resolveCompanyBalanceSnapshot({
      ...base,
      status_code: COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED,
      source_account_label: "Revolut Business source account not configured",
    });
  }

  if (!businessToken) {
    return resolveCompanyBalanceSnapshot({
      ...base,
      status_code: "AUTHENTICATION_REQUIRED",
      source_account_id: merchant_id,
      source_account_label: maskSourceLabel({
        currency,
        accountId: merchant_id,
        accountName,
      }),
      last_provider_sync_at: persisted?.last_provider_sync_at ?? null,
    });
  }

  try {
    const accounts = await listCompanyBalanceAccounts(businessToken);
    // Exact selected account only — never fall back to first GBP / Main / highest balance.
    const match = accounts.find((a) => String(a.id) === merchant_id) ?? null;
    if (!match) {
      return resolveCompanyBalanceSnapshot({
        ...base,
        status_code: COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED,
        source_account_id: merchant_id,
        source_account_label: maskSourceLabel({
          currency,
          accountId: merchant_id,
          accountName,
        }),
        last_provider_sync_at: persisted?.last_provider_sync_at ?? null,
      });
    }
    const acctCurrency = String(match.currency ?? currency).toUpperCase();
    if (acctCurrency !== currency) {
      return resolveCompanyBalanceSnapshot({
        ...base,
        status_code: "CURRENCY_MISMATCH",
        source_account_id: String(match.id),
        source_account_label: maskSourceLabel({
          currency: acctCurrency,
          accountId: String(match.id),
          accountName: accountName ?? (match as { name?: string }).name ?? null,
        }),
      });
    }
    const bal = accountBalanceToPence(match);
    if (bal.available_pence == null) {
      return resolveCompanyBalanceSnapshot({
        ...base,
        status_code: COMPANY_BALANCE_ERROR.BALANCE_STALE,
        source_account_id: String(match.id),
        source_account_label: maskSourceLabel({
          currency: acctCurrency,
          accountId: String(match.id),
          accountName: accountName ?? (match as { name?: string }).name ?? null,
        }),
        last_provider_sync_at: persisted?.last_provider_sync_at ?? null,
      });
    }
    const label = maskSourceLabel({
      currency: acctCurrency,
      accountId: String(match.id),
      accountName: accountName ?? (match as { name?: string }).name ?? null,
    });
    await persistSourceBalanceSnapshot({
      supabase: args.supabase,
      revolut_account_id: String(match.id),
      balance_pence: bal.current_pence ?? bal.available_pence,
      available_pence: bal.available_pence,
      account_name: accountName ?? (match as { name?: string }).name ?? null,
      account_status: (match as { state?: string }).state ?? null,
    });
    const syncedAt = new Date().toISOString();
    return resolveCompanyBalanceSnapshot({
      ...base,
      provider_current_balance_pence: bal.current_pence,
      provider_cash_balance_pence: bal.available_pence,
      provider_available_balance_pence: bal.available_pence,
      company_ledger_balance_pence: bal.available_pence,
      source_account_id: String(match.id),
      source_account_label: label,
      status_code: "AVAILABLE" as CompanyBalanceStatusCode,
      last_provider_sync_at: syncedAt,
      refresh_requested: args.refresh === true,
    });
  } catch (err) {
    const status = typeof err === "object" && err && "status" in err
      ? Number((err as { status?: number }).status)
      : 0;
    const msg = err instanceof Error ? err.message : String(err);
    const code = status === 401 || status === 403
      ? "AUTHENTICATION_REQUIRED"
      : msg.includes("relay_not_configured") || msg.includes("relay_unreachable")
      ? COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE
      : COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE;
    console.warn("[company-balance] revolut business accounts failed", {
      status,
      error: msg,
    });
    return resolveCompanyBalanceSnapshot({
      ...base,
      status_code: code,
      source_account_id: merchant_id,
      source_account_label: maskSourceLabel({
        currency,
        accountId: merchant_id,
        accountName,
      }),
      last_provider_sync_at: persisted?.last_provider_sync_at ?? null,
    });
  }
}

/**
 * Slice 10 gate for Payout Ledger / company transfers.
 * Loads Payment Sessions net commission (classified cash) + operational reserve,
 * then recomposes Company Balance. Never invents £0 when sources fail closed.
 */
export async function resolveLiveCompanyBalanceWithSlice10Gate(args: {
  supabase?: AnySupabase;
  service_area_id?: string | null;
  currency?: string | null;
  approved_payables_pending_pence?: number | null;
  driver_liability_pence?: number | null;
  driver_payout_reserved_pence?: number | null;
  customer_refund_reserved_pence?: number | null;
  operational_reserve_pence?: number | null;
  classified_company_cash_pence?: number | null;
  refresh?: boolean;
}): Promise<CompanyBalanceSnapshot> {
  const live = await resolveLiveCompanyBalanceSnapshot({
    supabase: args.supabase,
    service_area_id: args.service_area_id,
    currency: args.currency,
    approved_payables_pending_pence: args.approved_payables_pending_pence,
    driver_liability_pence: args.driver_liability_pence,
    driver_payout_reserved_pence: args.driver_payout_reserved_pence,
    customer_refund_reserved_pence: args.customer_refund_reserved_pence,
    refresh: args.refresh,
  });

  let classified = args.classified_company_cash_pence ?? null;
  if (classified == null && args.supabase) {
    try {
      const commission = await loadPaymentSessionsNetCommissionPence(args.supabase, {
        service_area_id: args.service_area_id ?? null,
      });
      classified = commission.net_onecab_commission_pence;
    } catch (err) {
      console.warn("[company-balance] PS net commission load failed", err);
      classified = null;
    }
  }

  let reservePence = args.operational_reserve_pence ?? null;
  let reserveReason: string | null = null;
  if (reservePence == null && args.supabase) {
    const eligibleForReserve =
      live.company_available_before_operational_reserve_pence
      ?? live.provider_cash_balance_pence
      ?? live.company_ledger_balance_pence;
    try {
      const reserve = await resolveLoadedOperationalReserve(args.supabase, {
        service_area_id: args.service_area_id ?? null,
        currency: args.currency ?? live.currency ?? "GBP",
        eligible_company_cash_pence: eligibleForReserve,
      });
      reservePence = reserve.amount_pence;
      reserveReason = String(reserve.reason_code ?? reserve.error_code ?? "").trim() || null;
    } catch (err) {
      console.warn("[company-balance] operational reserve load failed", err);
      reservePence = null;
      reserveReason = "OPERATIONAL_RESERVE_QUERY_FAILED";
    }
  }

  const statusCode: CompanyBalanceStatusCode | string | null =
    live.status === "LIVE" || live.status_code === "AVAILABLE"
      ? "AVAILABLE"
      : (live.status_code ?? live.unavailable_reason ?? live.status);

  return resolveCompanyBalanceSnapshot({
    service_area_id: live.service_area_id,
    currency: live.currency,
    company_ledger_balance_pence: live.company_ledger_balance_pence,
    provider_cash_balance_pence: live.provider_cash_balance_pence,
    provider_current_balance_pence: live.provider_current_balance_pence,
    provider_available_balance_pence: live.provider_available_balance_pence,
    approved_payables_pending_pence:
      args.approved_payables_pending_pence ?? live.approved_payables_pending_pence,
    driver_liability_pence: args.driver_liability_pence ?? live.driver_liability_pence,
    driver_payout_reserved_pence:
      args.driver_payout_reserved_pence ?? live.driver_payout_reserved_pence,
    customer_refund_reserved_pence:
      args.customer_refund_reserved_pence ?? live.customer_refund_reserved_pence,
    operational_reserve_pence: reservePence,
    operational_reserve_reason_code: reserveReason,
    classified_company_cash_pence: classified,
    source_account_id: live.source_account_id,
    source_account_label: live.source_account_label,
    status_code: statusCode,
    last_provider_sync_at: live.last_provider_sync_at,
    refresh_requested: args.refresh === true,
  });
}

export { COMPANY_BALANCE_ERROR };
