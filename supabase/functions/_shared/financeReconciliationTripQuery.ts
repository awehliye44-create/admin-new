/**
 * Financial Reconciliation trip list query — aligned with Trip History SSOT (`tripHistoryQuery.ts`).
 * Shows ALL financially terminal trips in scope; never filters to reconciliation mismatches.
 *
 * Lifecycle status alone must not exclude financial evidence:
 * cancelled / null driver_id trips with payment session, fare settlement, commission,
 * cancellation-fee, or receivable lineage remain in the audit universe.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { COUNTABLE_FINANCIAL_OUTCOMES } from "./financeSettlementSummary.ts";
import { SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";

export const FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_DEFAULT = 10_000;
export const FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_MAX = 10_000;

/**
 * Terminal inclusion OR — includes cancelled so fare-settlement / receivable-recovered
 * sources (e.g. MK-017) are not dropped solely on lifecycle status.
 * Application post-filter: {@link tripQualifiesForFinanceReconciliationAudit}.
 */
export const FINANCE_RECONCILIATION_TRIP_TERMINAL_OR =
  `financial_outcome.in.(${COUNTABLE_FINANCIAL_OUTCOMES.join(",")}),status.in.(completed,no_show,cancelled)`;

export function resolveFinanceReconciliationAuditLimit(
  raw: string | null | undefined,
  mode: "full" | "summary" | "statement",
): number {
  // Never default money/KPI paths to a silent 500-trip under-sample.
  // Page UIs paginate separately; period audits use the full safety max.
  if (mode === "statement" || mode === "summary" || mode === "full") {
    return Math.min(
      Number(raw || FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_DEFAULT),
      FINANCE_RECONCILIATION_TRIP_AUDIT_LIMIT_MAX,
    );
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

function positivePence(n: unknown): boolean {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) && v > 0;
}

/** Financial evidence that keeps a cancelled / thin-lifecycle trip in FR audit. */
export function tripHasFrFinancialEvidence(trip: {
  final_fare_pence?: number | null;
  commissionable_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  commission_pence?: number | null;
  driver_net_pence?: number | null;
  capture_amount_pence?: number | null;
  no_show_charge_pence?: number | null;
  cancellation_fee_pence?: number | null;
  arrival_cancellation_fee?: number | null;
  payment_coverage_status?: string | null;
  /** When true, payment session / receivable lineage already proven for this trip. */
  has_payment_session_capture?: boolean;
  has_receivable_lineage?: boolean;
  has_ten_credit?: boolean;
}): boolean {
  if (trip.has_payment_session_capture) return true;
  if (trip.has_receivable_lineage) return true;
  if (trip.has_ten_credit) return true;
  if (positivePence(trip.final_fare_pence)) return true;
  if (positivePence(trip.commissionable_fare_pence)) return true;
  if (positivePence(trip.gross_fare_pence)) return true;
  if (positivePence(trip.final_customer_fare_pence)) return true;
  if (positivePence(trip.commission_pence)) return true;
  if (positivePence(trip.driver_net_pence)) return true;
  if (positivePence(trip.capture_amount_pence)) return true;
  if (positivePence(trip.no_show_charge_pence)) return true;
  if (positivePence(trip.cancellation_fee_pence)) return true;
  if (positivePence(trip.arrival_cancellation_fee)) return true;
  const coverage = String(trip.payment_coverage_status ?? "").toLowerCase();
  if (coverage.includes("capture") || coverage.includes("partial")) return true;
  return false;
}

/**
 * Keep classic terminal rows; keep cancelled only when financial evidence exists.
 * Never require driver_id.
 */
export function tripQualifiesForFinanceReconciliationAudit(trip: {
  status?: string | null;
  financial_outcome?: string | null;
  final_fare_pence?: number | null;
  commissionable_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  commission_pence?: number | null;
  driver_net_pence?: number | null;
  capture_amount_pence?: number | null;
  no_show_charge_pence?: number | null;
  cancellation_fee_pence?: number | null;
  arrival_cancellation_fee?: number | null;
  payment_coverage_status?: string | null;
  has_payment_session_capture?: boolean;
  has_receivable_lineage?: boolean;
  has_ten_credit?: boolean;
}): boolean {
  const outcome = String(trip.financial_outcome ?? "").toUpperCase();
  if ((COUNTABLE_FINANCIAL_OUTCOMES as readonly string[]).includes(outcome)) {
    return true;
  }
  const status = String(trip.status ?? "").toLowerCase();
  if (status === "completed" || status === "no_show") return true;
  if (status === "cancelled" || status === "canceled") {
    return tripHasFrFinancialEvidence(trip);
  }
  // Unknown lifecycle with hard financial evidence — still include.
  return tripHasFrFinancialEvidence(trip);
}

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
