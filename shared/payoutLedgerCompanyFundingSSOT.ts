/**
 * Payout Ledger company-funding card rollups (pure).
 * Never mutates wallets / reservations / provider payments.
 */

export const SLICE8_FUNDING_PROOF = {
  AHMED_ID: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
  AHMED_LIVE_PENCE: 1001,
  AHMED_RESERVED_PENCE: 1001,
  BOSTEYO_ID: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
  BOSTEYO_COMPLETED_PENCE: 408,
  REVOLUT_SOURCE_PENCE: 1526,
  EXPECTED_LIABILITY_PENCE: 1001,
  EXPECTED_RESERVED_PENCE: 1001,
  EXPECTED_COMPLETED_MONTH_PENCE: 408,
  EXPECTED_AVAILABLE_PENCE: 525,
  /** Payment Sessions SSOT canonical net commission (consume — never recalc gross/fees). */
  EXPECTED_NET_COMMISSION_PENCE: 172,
  /** before_reserve − net_commission when residue is unclassified. */
  EXPECTED_OTHER_COMPANY_CASH_PENCE: 353,
} as const;

export const PAYMENT_SESSIONS_NET_COMMISSION_SOURCE =
  "Payment Sessions SSOT · summary.net_onecab_commission_pence";

export type CompanyFundingClassificationKind =
  | "NET_COMMISSION"
  | "OPENING_BALANCE"
  | "COMPANY_FUNDING"
  | "ADJUSTMENT"
  | "UNATTRIBUTED_CASH";

export type CompanyFundingClassifiedSource = {
  kind: CompanyFundingClassificationKind;
  amount_pence: number;
  label: string;
  source: string;
};

/** Sum classified canonical company-funding sources (excludes unattributed residue). */
export function computeClassifiedCompanyFundingSumPence(
  sources: ReadonlyArray<Pick<CompanyFundingClassifiedSource, "kind" | "amount_pence">>,
): number {
  let total = 0;
  for (const row of sources) {
    if (row.kind === "UNATTRIBUTED_CASH") continue;
    total += Math.max(0, Math.round(Number(row.amount_pence ?? 0)));
  }
  return total;
}

/**
 * Other company-owned cash = before_reserve − classified canonical sources.
 * Unexplained residue is never labelled commission.
 */
export function computeOtherCompanyOwnedCashPence(args: {
  company_available_before_operational_reserve_pence: number | null;
  classified_sources: ReadonlyArray<CompanyFundingClassifiedSource>;
}): number | null {
  const before = args.company_available_before_operational_reserve_pence;
  if (before == null) return null;
  const classified = computeClassifiedCompanyFundingSumPence(args.classified_sources);
  return Math.max(0, before - classified);
}

/** Audit rows for company-owned cash classification (display / audit tab only). */
export function buildCompanyFundingAuditRows(args: {
  company_available_before_operational_reserve_pence: number | null;
  onecab_net_commission_available_pence: number | null;
  opening_balance_pence?: number | null;
  company_funding_pence?: number | null;
  adjustments_pence?: number | null;
}): CompanyFundingClassifiedSource[] {
  const rows: CompanyFundingClassifiedSource[] = [];

  if (args.onecab_net_commission_available_pence != null) {
    rows.push({
      kind: "NET_COMMISSION",
      amount_pence: Math.max(0, Math.round(args.onecab_net_commission_available_pence)),
      label: "ONECAB Net Commission Available",
      source: PAYMENT_SESSIONS_NET_COMMISSION_SOURCE,
    });
  }
  if (args.opening_balance_pence != null && args.opening_balance_pence > 0) {
    rows.push({
      kind: "OPENING_BALANCE",
      amount_pence: Math.round(args.opening_balance_pence),
      label: "Opening balance",
      source: "Company funding ledger",
    });
  }
  if (args.company_funding_pence != null && args.company_funding_pence > 0) {
    rows.push({
      kind: "COMPANY_FUNDING",
      amount_pence: Math.round(args.company_funding_pence),
      label: "Company funding",
      source: "Company funding ledger",
    });
  }
  if (args.adjustments_pence != null && args.adjustments_pence !== 0) {
    rows.push({
      kind: "ADJUSTMENT",
      amount_pence: Math.round(args.adjustments_pence),
      label: "Adjustments",
      source: "Company funding ledger",
    });
  }

  const other = computeOtherCompanyOwnedCashPence({
    company_available_before_operational_reserve_pence:
      args.company_available_before_operational_reserve_pence,
    classified_sources: rows,
  });
  if (other != null && other > 0) {
    rows.push({
      kind: "UNATTRIBUTED_CASH",
      amount_pence: other,
      label: "Other company-owned cash",
      source: "Derived residue — not recognised as commission",
    });
  }
  return rows;
}

/** Protected driver liabilities = sum(max(0, live_driver_wallet_balance_pence)). */
export function sumProtectedDriverLiabilitiesPence(
  liveByDriver: ReadonlyArray<{ driver_id: string; live_pence: number }>,
): number {
  let total = 0;
  for (const row of liveByDriver) {
    total += Math.max(0, Math.round(Number(row.live_pence ?? 0)));
  }
  return total;
}

/** Reserved = sum(ACTIVE driver_payout_reservations.amount_pence) only. */
export function sumActiveReservedDriverPayoutsPence(
  reservations: ReadonlyArray<{
    driver_id: string;
    amount_pence: number;
    status: string;
  }>,
): number {
  let total = 0;
  for (const row of reservations) {
    if (String(row.status ?? "").toUpperCase() !== "ACTIVE") continue;
    total += Math.max(0, Math.round(Number(row.amount_pence ?? 0)));
  }
  return total;
}

export type CanonicalDriverPayoutExecutionRow = {
  driver_id: string;
  amount_pence: number;
  /** Revolut Business provider state (canonical complete = "completed"). */
  provider_state?: string | null;
  /** payout_items.status / execution_status when intent state absent. */
  item_status?: string | null;
  execution_status?: string | null;
  financially_applied?: boolean | null;
  completed_at?: string | null;
  provider_completed_at?: string | null;
  financially_applied_at?: string | null;
};

const NON_COMPLETED_PROVIDER = new Set([
  "created",
  "pending",
  "submitted",
  "processing",
  "failed",
  "declined",
  "cancelled",
  "canceled",
  "reverted",
  "unknown",
  "",
]);

/**
 * Count once when provider_state is completed (and financially applied when known),
 * or when item/execution status is COMPLETED. Exclude failed/reversed.
 */
export function isCanonicalCompletedDriverPayoutExecution(
  row: CanonicalDriverPayoutExecutionRow,
): boolean {
  const provider = String(row.provider_state ?? "").trim().toLowerCase();
  if (provider === "completed") {
    if (row.financially_applied === false) return false;
    return true;
  }
  if (provider && NON_COMPLETED_PROVIDER.has(provider)) return false;
  const item = String(row.item_status ?? "").trim().toLowerCase();
  const exec = String(row.execution_status ?? "").trim().toLowerCase();
  if (item === "completed" || item === "paid" || item === "succeeded") return true;
  if (exec === "completed" || exec === "paid" || exec === "succeeded") return true;
  return false;
}

function completionTimestampIso(row: CanonicalDriverPayoutExecutionRow): string | null {
  // Prefer financial-application / item completed_at so intent+item pairs share one clock.
  // Provider completed_at can differ by hours and must not create a second count.
  const raw = row.financially_applied_at
    ?? row.completed_at
    ?? row.provider_completed_at
    ?? null;
  if (!raw) return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * completed_this_month_pence — London calendar month of completion timestamps.
 * Counts each driver+amount once per month (intent + payout_item are the same execution).
 */
export function sumCompletedDriverPayoutsThisMonthPence(args: {
  executions: ReadonlyArray<CanonicalDriverPayoutExecutionRow>;
  month_start_iso: string;
  month_end_iso_exclusive?: string | null;
}): number {
  const start = String(args.month_start_iso);
  const end = args.month_end_iso_exclusive ? String(args.month_end_iso_exclusive) : null;
  const seen = new Set<string>();
  let total = 0;
  for (const row of args.executions) {
    if (!isCanonicalCompletedDriverPayoutExecution(row)) continue;
    const at = completionTimestampIso(row);
    if (!at || at < start) continue;
    if (end && at >= end) continue;
    const amt = Math.max(0, Math.round(Number(row.amount_pence ?? 0)));
    if (amt <= 0) continue;
    // One provider completion ≡ one intent + one item — dedupe by driver+amount in-month.
    const key = `${row.driver_id}|${amt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += amt;
  }
  return total;
}
