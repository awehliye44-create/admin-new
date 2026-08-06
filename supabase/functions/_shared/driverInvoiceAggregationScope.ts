/**
 * Driver wallet ledger aggregation scope rules (SSOT).
 *
 * - Explicit service_area_id: include only that SA (exact filter).
 * - Global / null scope: do NOT add service_area_id = NULL; include all areas.
 * - Legacy rows with null service_area_id under an explicit SA scope follow
 *   CANONICAL_LEGACY_NULL_SA = "exclude" (they are not attributed to the SA).
 */

export type AggregationScopeMode = "global" | "service_area";

export type ZeroTotalClassification =
  | "VALID_ZERO_EARNINGS"
  | "INVALID_AGGREGATION"
  | "INCOMPLETE_AGGREGATION";

export type LedgerRowLike = {
  id?: string;
  type: string;
  amount_pence: number;
  related_trip_id?: string | null;
  service_area_id?: string | null;
  driver_id?: string;
};

/** Documented rule for ledger rows missing service_area metadata under SA-scoped reports. */
export const CANONICAL_LEGACY_NULL_SA_RULE = "exclude_from_service_area_scope" as const;

export function resolveAggregationScope(
  serviceAreaId: string | null | undefined,
): AggregationScopeMode {
  const sa = (serviceAreaId ?? "").trim();
  return sa ? "service_area" : "global";
}

/**
 * Apply scope filter in memory (pure). Never treats "global" as service_area_id IS NULL.
 */
export function filterLedgerRowsByScope(
  rows: LedgerRowLike[],
  serviceAreaId: string | null | undefined,
): { scoped: LedgerRowLike[]; excludedByScope: LedgerRowLike[]; scope: AggregationScopeMode } {
  const scope = resolveAggregationScope(serviceAreaId);
  if (scope === "global") {
    return { scoped: [...rows], excludedByScope: [], scope };
  }
  const sa = String(serviceAreaId).trim();
  const scoped: LedgerRowLike[] = [];
  const excludedByScope: LedgerRowLike[] = [];
  for (const row of rows) {
    const rowSa = row.service_area_id == null ? null : String(row.service_area_id);
    if (rowSa === sa) scoped.push(row);
    else excludedByScope.push(row); // includes legacy null SA under explicit scope
  }
  return { scoped, excludedByScope, scope };
}

export type AggregationOutcome = {
  ok: boolean;
  scope: AggregationScopeMode;
  includedRowCount: number;
  eligibleEarningRowCount: number;
  netDriverEarningsPence: number;
  grossEarningsPence: number;
  platformCommissionPence: number;
  zeroTotalClassification: ZeroTotalClassification | null;
  failureCode: string | null;
};

const EARNING_TYPES = new Set([
  "TRIP_EARNING_NET",
  "CASH_TRIP_EARNING",
  "TIP_CREDIT",
  "DRIVER_TIP_CREDIT",
  "NO_SHOW_EARNING",
  "LATE_CANCEL_EARNING",
]);
const COMMISSION_TYPES = new Set(["PLATFORM_COMMISSION", "COMPANY_COMMISSION"]);
const BONUS_TYPES = new Set(["BONUS", "INCENTIVE"]);
const PENALTY_TYPES = new Set(["PENALTY", "DEDUCTION"]);
const ADJ_TYPES = new Set(["ADJUSTMENT", "REFUND_DEBIT", "LEDGER_REVERSAL"]);
const EXCLUDED = new Set([
  "TOP_UP",
  "WALLET_TOP_UP",
  "DRIVER_TOP_UP",
  "PAYOUT",
  "PAYOUT_RESERVATION",
  "PAYOUT_RESERVATION_HOLD",
  "PAYOUT_RESERVATION_RELEASE",
  "WEEKLY_PAYOUT",
  "CASHOUT",
  "WITHDRAWAL",
  "COMMISSION_WALLET_CREDIT",
  "COMMISSION_WALLET_DEBIT",
]);

export function classifyLedgerType(type: string): "earning" | "commission" | "bonus" | "penalty" | "adjustment" | "excluded" {
  const t = (type ?? "").toUpperCase();
  if (EXCLUDED.has(t) || t.startsWith("PAYOUT")) return "excluded";
  if (EARNING_TYPES.has(t)) return "earning";
  if (COMMISSION_TYPES.has(t)) return "commission";
  if (BONUS_TYPES.has(t)) return "bonus";
  if (PENALTY_TYPES.has(t)) return "penalty";
  if (ADJ_TYPES.has(t)) return "adjustment";
  return "excluded";
}

/**
 * Pure aggregation used by tests and pre-send validation.
 * queryFailed distinguishes empty-period zero from filter/query failure.
 */
export function aggregateLedgerRowsPure(
  rows: LedgerRowLike[],
  args: {
    serviceAreaId?: string | null;
    queryFailed?: boolean;
    /** When true, a null SA filter was incorrectly applied at query time. */
    nullServiceAreaFilterApplied?: boolean;
  } = {},
): AggregationOutcome {
  if (args.queryFailed) {
    return {
      ok: false,
      scope: resolveAggregationScope(args.serviceAreaId),
      includedRowCount: 0,
      eligibleEarningRowCount: 0,
      netDriverEarningsPence: 0,
      grossEarningsPence: 0,
      platformCommissionPence: 0,
      zeroTotalClassification: "INCOMPLETE_AGGREGATION",
      failureCode: "AGGREGATION_QUERY_FAILED",
    };
  }
  if (args.nullServiceAreaFilterApplied && resolveAggregationScope(args.serviceAreaId) === "global") {
    return {
      ok: false,
      scope: "global",
      includedRowCount: 0,
      eligibleEarningRowCount: 0,
      netDriverEarningsPence: 0,
      grossEarningsPence: 0,
      platformCommissionPence: 0,
      zeroTotalClassification: "INVALID_AGGREGATION",
      failureCode: "NULL_SERVICE_AREA_FILTER_MISUSE",
    };
  }

  const { scoped, scope } = filterLedgerRowsByScope(rows, args.serviceAreaId);
  let gross = 0;
  let commission = 0;
  let bonuses = 0;
  let penalties = 0;
  let adjustments = 0;
  let included = 0;
  let earningRows = 0;

  for (const row of scoped) {
    const bucket = classifyLedgerType(row.type);
    if (bucket === "excluded") continue;
    included += 1;
    const amt = Number(row.amount_pence ?? 0);
    switch (bucket) {
      case "earning":
        gross += amt;
        earningRows += 1;
        break;
      case "commission":
        commission += Math.abs(amt);
        break;
      case "bonus":
        bonuses += amt;
        break;
      case "penalty":
        penalties += Math.abs(amt);
        break;
      case "adjustment":
        adjustments += amt;
        break;
    }
  }

  const net = gross - commission + bonuses - penalties + adjustments;
  if (net === 0 && included === 0 && earningRows === 0) {
    return {
      ok: true,
      scope,
      includedRowCount: 0,
      eligibleEarningRowCount: 0,
      netDriverEarningsPence: 0,
      grossEarningsPence: 0,
      platformCommissionPence: 0,
      zeroTotalClassification: "VALID_ZERO_EARNINGS",
      failureCode: null,
    };
  }
  if (net === 0 && included > 0) {
    return {
      ok: true,
      scope,
      includedRowCount: included,
      eligibleEarningRowCount: earningRows,
      netDriverEarningsPence: 0,
      grossEarningsPence: gross,
      platformCommissionPence: commission,
      zeroTotalClassification: "VALID_ZERO_EARNINGS",
      failureCode: null,
    };
  }
  return {
    ok: true,
    scope,
    includedRowCount: included,
    eligibleEarningRowCount: earningRows,
    netDriverEarningsPence: net,
    grossEarningsPence: gross,
    platformCommissionPence: commission,
    zeroTotalClassification: null,
    failureCode: null,
  };
}
