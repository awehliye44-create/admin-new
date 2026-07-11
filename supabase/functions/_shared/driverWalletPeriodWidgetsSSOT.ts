/**
 * Driver Wallet period widget summary SSOT — backend only.
 * Aggregates ledger (and trip commission snapshots) for a selected period.
 * Never derives live balance from trips or Payment Sessions.
 */

export type LedgerWidgetRow = {
  type?: string | null;
  amount_pence?: number | null;
  related_trip_id?: string | null;
  trip_id?: string | null;
  created_at?: string | null;
};

export type TripCommissionSnapshotRow = {
  trip_id?: string | null;
  completed_at?: string | null;
  /** Canonical gross ONECAB commission from trip settlement (pence). */
  commission_pence?: number | null;
};

export type DriverWalletSummaryPeriod = {
  key: string;
  from: string;
  to: string;
  timezone: string;
};

export type DriverWalletSummaryAccount = {
  live_balance_pence: number;
  available_balance_pence: number;
  pending_balance_pence: number;
  outstanding_debt_pence: number;
  /** Year-to-date trip net credits (London calendar year) — account-level, not period filter. */
  annual_driver_earnings_pence: number;
};

export type DriverWalletSummaryTotals = {
  driver_net_earnings_pence: number;
  trip_credit_pence: number;
  paid_trip_count: number;
  platform_commission_pence: number;
  bonus_pence: number;
  wallet_adjustment_pence: number;
  debt_recovered_pence: number;
  refund_chargeback_debit_pence: number;
  payout_debit_pence: number;
  net_wallet_movement_pence: number;
};

export type DriverWalletSummaryResponse = {
  period: DriverWalletSummaryPeriod;
  account: DriverWalletSummaryAccount;
  summary: DriverWalletSummaryTotals;
};

const TRIP_CREDIT_TYPES = new Set([
  "TRIP_EARNING_NET",
  "TRIP_CREDIT",
  "CASH_TRIP_EARNING",
  "DRIVER_EARNING",
  "TRIP_EARNING",
]);

const BONUS_TYPES = new Set(["BONUS", "PROMOTION", "INCENTIVE"]);

const ADJUSTMENT_TYPES = new Set([
  "ADJUSTMENT",
  "MANUAL_CREDIT",
  "MANUAL_DEBIT",
  "MANUAL_ADJUSTMENT",
  "CORRECTION",
  "ADMIN_CORRECTION",
]);

const DEBT_RECOVERY_TYPES = new Set(["DEBT_RECOVERY", "COMMISSION_RECOVERED"]);

const REFUND_TYPES = new Set(["REFUND_DEBIT", "CHARGEBACK_DEBIT", "REFUND"]);

const PAYOUT_TYPES = new Set([
  "WEEKLY_PAYOUT",
  "EARLY_CASHOUT",
  "MANUAL_PAYOUT",
  "PAYOUT",
  "PAYOUT_CREATED",
  "CASHOUT_FEE",
  "PAYOUT_FAILED_RETURN",
  "PAYOUT_REVERSAL",
]);

/** Reporting-only — excluded from Net Wallet Movement / live balance. */
const BALANCE_EXCLUDED_TYPES = new Set([
  "PLATFORM_COMMISSION",
  "PLATFORM_COMMISSION_GROSS",
  "PLATFORM_COMMISSION_NET",
  "COMPANY_COMMISSION",
  "PAYMENT_PROVIDER_FEE",
  "PAYMENT_PROVIDER_FEE_ADJUSTMENT",
  "COMMISSION_REVERSAL",
  "PROVIDER_FEE_REVERSAL",
]);

export function isLedgerRowInPeriod(
  createdAt: string | null | undefined,
  fromIso: string,
  toIso: string,
): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return t >= from && t <= to;
}

/**
 * Period summary from ledger + trip commission snapshots.
 * Platform commission prefers trips.commission_pence (settlement snapshot).
 */
export function buildDriverWalletPeriodSummary(args: {
  ledger: LedgerWidgetRow[];
  tripCommissionSnapshots?: TripCommissionSnapshotRow[];
  periodFrom: string;
  periodTo: string;
}): DriverWalletSummaryTotals {
  let tripCredits = 0;
  let bonuses = 0;
  let adjustments = 0;
  let debtRecovered = 0;
  let refundDebits = 0;
  let payoutDebits = 0;
  let netMovement = 0;
  const tripIds = new Set<string>();

  for (const row of args.ledger) {
    if (!isLedgerRowInPeriod(row.created_at, args.periodFrom, args.periodTo)) continue;
    const type = String(row.type ?? "").toUpperCase();
    const amount = Number(row.amount_pence ?? 0);
    if (!BALANCE_EXCLUDED_TYPES.has(type)) {
      netMovement += amount;
    }
    if (TRIP_CREDIT_TYPES.has(type) && amount > 0) {
      tripCredits += amount;
      const tripId = row.related_trip_id ?? row.trip_id;
      if (tripId) tripIds.add(String(tripId));
    }
    if (BONUS_TYPES.has(type) && amount > 0) bonuses += amount;
    if (ADJUSTMENT_TYPES.has(type)) adjustments += amount;
    if (DEBT_RECOVERY_TYPES.has(type)) debtRecovered += Math.abs(amount);
    if (REFUND_TYPES.has(type) && amount < 0) refundDebits += Math.abs(amount);
    if (PAYOUT_TYPES.has(type) && amount < 0) payoutDebits += Math.abs(amount);
  }

  // Canonical platform commission: trip settlement snapshot in period (not fare − net in UI).
  let platformCommission = 0;
  const snaps = args.tripCommissionSnapshots ?? [];
  if (snaps.length > 0) {
    for (const t of snaps) {
      if (!isLedgerRowInPeriod(t.completed_at, args.periodFrom, args.periodTo)) continue;
      platformCommission += Math.max(0, Math.round(Number(t.commission_pence ?? 0)));
    }
  } else {
    // Fallback: reporting PLATFORM_COMMISSION ledger abs (still backend-only).
    for (const row of args.ledger) {
      if (!isLedgerRowInPeriod(row.created_at, args.periodFrom, args.periodTo)) continue;
      const type = String(row.type ?? "").toUpperCase();
      if (
        type === "PLATFORM_COMMISSION"
        || type === "PLATFORM_COMMISSION_GROSS"
        || type === "COMPANY_COMMISSION"
        || type === "CASH_COMMISSION_DEBT"
      ) {
        platformCommission += Math.abs(Number(row.amount_pence ?? 0));
      }
    }
  }

  return {
    driver_net_earnings_pence: tripCredits,
    trip_credit_pence: tripCredits,
    paid_trip_count: tripIds.size,
    platform_commission_pence: platformCommission,
    bonus_pence: bonuses,
    wallet_adjustment_pence: adjustments,
    debt_recovered_pence: debtRecovered,
    refund_chargeback_debit_pence: refundDebits,
    payout_debit_pence: payoutDebits,
    net_wallet_movement_pence: netMovement,
  };
}

export function buildDriverWalletSummaryResponse(args: {
  periodKey: string;
  periodFrom: string;
  periodTo: string;
  timezone?: string;
  account: DriverWalletSummaryAccount;
  ledger: LedgerWidgetRow[];
  tripCommissionSnapshots?: TripCommissionSnapshotRow[];
}): DriverWalletSummaryResponse {
  return {
    period: {
      key: args.periodKey,
      from: args.periodFrom,
      to: args.periodTo,
      timezone: args.timezone ?? "Europe/London",
    },
    account: {
      live_balance_pence: Math.round(Number(args.account.live_balance_pence ?? 0)),
      available_balance_pence: Math.round(Number(args.account.available_balance_pence ?? 0)),
      pending_balance_pence: Math.max(0, Math.round(Number(args.account.pending_balance_pence ?? 0))),
      outstanding_debt_pence: Math.max(0, Math.round(Number(args.account.outstanding_debt_pence ?? 0))),
      annual_driver_earnings_pence: Math.max(
        0,
        Math.round(Number(args.account.annual_driver_earnings_pence ?? 0)),
      ),
    },
    summary: buildDriverWalletPeriodSummary({
      ledger: args.ledger,
      tripCommissionSnapshots: args.tripCommissionSnapshots,
      periodFrom: args.periodFrom,
      periodTo: args.periodTo,
    }),
  };
}
