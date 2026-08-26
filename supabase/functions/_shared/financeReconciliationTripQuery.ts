/**
 * Financial Reconciliation trip list query — aligned with Trip History SSOT (`tripHistoryQuery.ts`).
 * Shows ALL financially terminal trips in scope; never filters to reconciliation mismatches.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { COUNTABLE_FINANCIAL_OUTCOMES } from "./financeSettlementSummary.ts";
import { SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";

export const FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_DEFAULT = 10_000;
export const FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_MAX = 10_000;

export const FINANCE_RECONCILIATION_TRIP_TERMINAL_OR = `financial_outcome.in.(${COUNTABLE_FINANCIAL_OUTCOMES.join(",")}),status.in.(completed,no_show)`;

export function resolveFinanceReconciliationAuditLimit(
  raw: string | null | undefined,
  mode: "full" | "summary" | "statement",
): number {
  if (mode === "statement") {
    return Math.min(Number(raw || FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_MAX), FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_MAX);
  }
  if (mode === "summary") {
    return Math.min(Number(raw || 500), 2000);
  }
  return Math.min(
    Number(raw || FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_DEFAULT),
    FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_MAX,
  );
}

export async function applyFinanceReconciliationTripLocationFilter<T extends {
  eq: (col: string, val: string) => T;
  or: (filter: string) => T;
  in: (col: string, vals: string[]) => T;
}>(
  query: T,
  supabase: SupabaseClient,
  filter: {
    regionId?: string | null;
    serviceAreaId?: string | null;
    /** When set, region expansion never includes DRIVER_COLLECTED service areas. */
    allowedServiceAreaIds?: readonly string[] | null;
  },
): Promise<T> {
  if (filter.serviceAreaId) {
    return query.eq("service_area_id", filter.serviceAreaId);
  }

  const allowed = filter.allowedServiceAreaIds
    ? new Set(filter.allowedServiceAreaIds)
    : null;

  if (filter.regionId) {
    const { data: areas } = await supabase
      .from("service_areas")
      .select("id")
      .eq("region_id", filter.regionId);
    let areaIds = (areas ?? []).map((a) => a.id as string).filter(Boolean);
    if (allowed) areaIds = areaIds.filter((id) => allowed.has(id));
    if (areaIds.length > 0) {
      return query.in("service_area_id", areaIds);
    }
    // Region has no PLATFORM SAs — empty universe.
    return query.eq("service_area_id", "00000000-0000-0000-0000-000000000000");
  }

  if (allowed) {
    const ids = [...allowed];
    if (ids.length === 0) {
      return query.eq("service_area_id", "00000000-0000-0000-0000-000000000000");
    }
    return query.in("service_area_id", ids);
  }

  return query;
}

export const FINANCE_RECONCILIATION_TRIP_FINANCIAL_MODEL =
  SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED;

export function buildFinanceReconciliationTripQuery(
  supabase: SupabaseClient,
  args: {
    periodFrom: string;
    periodTo: string;
    auditLimit: number;
    select: string;
  },
) {
  return supabase
    .from("trips")
    .select(args.select)
    .eq("financial_model", FINANCE_RECONCILIATION_TRIP_FINANCIAL_MODEL)
    .gte("completed_at", args.periodFrom)
    .lte("completed_at", args.periodTo)
    .or(FINANCE_RECONCILIATION_TRIP_TERMINAL_OR)
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(args.auditLimit);
}
