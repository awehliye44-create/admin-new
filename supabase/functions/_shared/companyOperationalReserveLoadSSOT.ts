/**
 * Edge loader for Slice 10 operational reserve policy.
 * Canonical table only — legacy admin_settings alone does NOT unlock final funds.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  OPERATIONAL_RESERVE_ERROR,
  parsePolicyRow,
  resolveOperationalReserveAmount,
  type CompanyOperationalReservePolicy,
  type ResolvedOperationalReserve,
} from "../../../shared/companyOperationalReserveSSOT.ts";

export async function loadActiveOperationalReservePolicy(
  supabase: SupabaseClient,
  args: {
    service_area_id?: string | null;
    currency?: string | null;
    as_of?: string | null;
  } = {},
): Promise<{
  policy: CompanyOperationalReservePolicy | null;
  error_code: string | null;
}> {
  const currency = String(args.currency ?? "GBP").trim().toUpperCase() || "GBP";
  const asOf = args.as_of ?? new Date().toISOString();
  try {
    const { data, error } = await supabase.rpc(
      "resolve_active_company_operational_reserve_prefer_sa",
      {
        p_service_area_id: args.service_area_id ?? null,
        p_currency: currency,
        p_as_of: asOf,
      },
    );
    if (error) {
      // Table/RPC may not exist yet during rolling deploy — fail closed.
      return {
        policy: null,
        error_code: OPERATIONAL_RESERVE_ERROR.QUERY_FAILED,
      };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return {
        policy: null,
        error_code: OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED,
      };
    }
    const policy = parsePolicyRow(row);
    if (!policy) {
      return {
        policy: null,
        error_code: OPERATIONAL_RESERVE_ERROR.INVALID,
      };
    }
    return { policy, error_code: null };
  } catch {
    return {
      policy: null,
      error_code: OPERATIONAL_RESERVE_ERROR.QUERY_FAILED,
    };
  }
}

/** Resolve ACTIVE reserve amount for eligible cash (PERCENTAGE uses eligible). */
export async function resolveLoadedOperationalReserve(
  supabase: SupabaseClient,
  args: {
    service_area_id?: string | null;
    currency?: string | null;
    eligible_company_cash_pence: number | null;
    as_of?: string | null;
  },
): Promise<ResolvedOperationalReserve & { error_code: string | null }> {
  const loaded = await loadActiveOperationalReservePolicy(supabase, args);
  if (!loaded.policy) {
    return {
      status: "NOT_CONFIGURED",
      amount_pence: null,
      policy: null,
      reason_code: (loaded.error_code as ResolvedOperationalReserve["reason_code"])
        ?? OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED,
      error_code: loaded.error_code ?? OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED,
    };
  }
  const resolved = resolveOperationalReserveAmount({
    policy: loaded.policy,
    currency: String(args.currency ?? "GBP").toUpperCase(),
    service_area_id: args.service_area_id,
    eligible_company_cash_pence: args.eligible_company_cash_pence,
    as_of: args.as_of,
  });
  return {
    ...resolved,
    error_code: resolved.reason_code,
  };
}

/** List recent policies for admin settings (all statuses). */
export async function listOperationalReservePolicies(
  supabase: SupabaseClient,
  args: { service_area_id?: string | null; currency?: string | null; limit?: number } = {},
): Promise<CompanyOperationalReservePolicy[]> {
  let q = supabase
    .from("company_operational_refund_reserves")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(args.limit ?? 20);
  if (args.service_area_id) {
    q = q.or(`service_area_id.eq.${args.service_area_id},service_area_id.is.null`);
  }
  if (args.currency) {
    q = q.ilike("currency", String(args.currency).trim());
  }
  const { data, error } = await q;
  if (error) return [];
  return (data ?? [])
    .map((row) => parsePolicyRow(row))
    .filter((p): p is CompanyOperationalReservePolicy => p != null);
}
