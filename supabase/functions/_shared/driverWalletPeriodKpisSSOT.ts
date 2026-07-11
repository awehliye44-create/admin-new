/**
 * Driver wallet period KPIs — computed from ledger rows (backend SSOT only).
 * London calendar bounds; no client-side formulas.
 */
import {
  getLondonDayBounds,
  getLondonCalendarParts,
} from "./financeLondonDay.ts";

export type DriverWalletPeriodKpis = {
  today_earnings_pence: number;
  week_earnings_pence: number;
  last_week_earnings_pence: number;
  month_earnings_pence: number;
  last_month_earnings_pence: number;
  quarter_earnings_pence: number;
  year_earnings_pence: number;
  last_year_earnings_pence: number;
  lifetime_earnings_pence: number;
  pending_earnings_pence: number;
  total_bonuses_pence: number;
  total_adjustments_pence: number;
  outstanding_debt_pence: number;
  /** Absolute sum of platform commission ledger debits (driver money SSOT). */
  platform_commission_pence: number;
  /**
   * Provider processing fees are owned by Payment Sessions / FR.
   * Always null here — reference-only pointer for the wallet UI.
   */
  provider_fees_reference_pence: number | null;
  trips_paid_count: number;
  average_earnings_per_trip_pence: number | null;
  timezone: "Europe/London";
};

type LedgerAggRow = {
  type: string;
  amount_pence: number | null;
  created_at?: string | null;
  related_trip_id?: string | null;
};

const EARNING_TYPES = new Set([
  "TRIP_EARNING_NET",
  "TRIP_SETTLEMENT",
  "TRIP_CREDIT",
  "DRIVER_EARNING",
  "CASH_TRIP_EARNING",
]);

const BONUS_TYPES = new Set(["BONUS", "INCENTIVE", "PROMOTION"]);
const ADJUSTMENT_TYPES = new Set([
  "ADJUSTMENT",
  "MANUAL_CREDIT",
  "MANUAL_DEBIT",
  "CORRECTION",
  "ADMIN_CORRECTION",
]);
const COMMISSION_TYPES = new Set([
  "PLATFORM_COMMISSION",
  "COMPANY_COMMISSION",
  "CASH_COMMISSION_DEBT",
]);
const EXCLUDE_FROM_EARNINGS = new Set([
  "PLATFORM_COMMISSION",
  "COMPANY_COMMISSION",
  "WEEKLY_PAYOUT",
  "EARLY_CASHOUT",
  "MANUAL_PAYOUT",
  "PAYOUT",
  "PAYOUT_REVERSAL",
  "CASHOUT_FEE",
]);

function getLondonWeekStart(date: Date = new Date()): Date {
  const { start: todayStart } = getLondonDayBounds(date);
  const londonWeekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
  }).format(date);
  const dayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(londonWeekday);
  const offsetDays = dayIndex >= 0 ? dayIndex : 0;
  return new Date(todayStart.getTime() - offsetDays * 24 * 60 * 60 * 1000);
}

function getLondonMonthStart(date: Date = new Date()): Date {
  const { y, m } = getLondonCalendarParts(date);
  const probe = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
  const londonHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(probe),
  );
  const offsetMs = (londonHour - 12) * 60 * 60 * 1000;
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - offsetMs);
}

function getLondonYearStart(date: Date = new Date()): Date {
  const { y } = getLondonCalendarParts(date);
  const probe = new Date(Date.UTC(y, 0, 1, 12, 0, 0));
  const londonHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(probe),
  );
  const offsetMs = (londonHour - 12) * 60 * 60 * 1000;
  return new Date(Date.UTC(y, 0, 1, 0, 0, 0) - offsetMs);
}

function isEarningCredit(type: string, amount: number): boolean {
  if (EXCLUDE_FROM_EARNINGS.has(type)) return false;
  if (EARNING_TYPES.has(type)) return amount > 0;
  if (BONUS_TYPES.has(type)) return amount > 0;
  return false;
}

export function buildDriverWalletPeriodKpis(
  ledger: LedgerAggRow[],
  args?: {
    recoveryDebtPence?: number;
    pendingEarningsPence?: number;
    now?: Date;
  },
): DriverWalletPeriodKpis {
  const now = args?.now ?? new Date();
  const { start: todayStart } = getLondonDayBounds(now);
  const weekStart = getLondonWeekStart(now);
  const lastWeekEnd = new Date(weekStart.getTime() - 1);
  const lastWeekStart = getLondonWeekStart(lastWeekEnd);
  const monthStart = getLondonMonthStart(now);
  const lastMonthEnd = new Date(monthStart.getTime() - 1);
  const lastMonthStart = getLondonMonthStart(lastMonthEnd);
  const yearStart = getLondonYearStart(now);
  const lastYearEnd = new Date(yearStart.getTime() - 1);
  const lastYearStart = getLondonYearStart(lastYearEnd);
  // London calendar quarter start (Jan/Apr/Jul/Oct).
  const { y, m } = getLondonCalendarParts(now);
  const quarterMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const quarterProbe = new Date(Date.UTC(y, quarterMonth - 1, 1, 12, 0, 0));
  const quarterLondonHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(quarterProbe),
  );
  const quarterStart = new Date(Date.UTC(y, quarterMonth - 1, 1, 0, 0, 0) - (quarterLondonHour - 12) * 60 * 60 * 1000);

  let today = 0;
  let week = 0;
  let lastWeek = 0;
  let month = 0;
  let lastMonth = 0;
  let quarter = 0;
  let year = 0;
  let lastYear = 0;
  let lifetime = 0;
  let bonuses = 0;
  let adjustments = 0;
  let platformCommission = 0;
  const tripIds = new Set<string>();

  for (const row of ledger) {
    const amount = Number(row.amount_pence ?? 0);
    const type = String(row.type ?? "").toUpperCase();
    const created = row.created_at ? new Date(row.created_at).getTime() : NaN;

    if (BONUS_TYPES.has(type) && amount > 0) bonuses += amount;
    if (ADJUSTMENT_TYPES.has(type)) adjustments += amount;
    if (COMMISSION_TYPES.has(type)) platformCommission += Math.abs(amount);

    if (isEarningCredit(type, amount)) {
      lifetime += amount;
      if (row.related_trip_id) tripIds.add(String(row.related_trip_id));
      if (!Number.isNaN(created)) {
        if (created >= todayStart.getTime()) today += amount;
        if (created >= weekStart.getTime()) week += amount;
        if (created >= lastWeekStart.getTime() && created <= lastWeekEnd.getTime()) lastWeek += amount;
        if (created >= monthStart.getTime()) month += amount;
        if (created >= lastMonthStart.getTime() && created <= lastMonthEnd.getTime()) lastMonth += amount;
        if (created >= quarterStart.getTime()) quarter += amount;
        if (created >= yearStart.getTime()) year += amount;
        if (created >= lastYearStart.getTime() && created <= lastYearEnd.getTime()) lastYear += amount;
      }
    }
  }

  const tripsPaid = tripIds.size;
  return {
    today_earnings_pence: today,
    week_earnings_pence: week,
    last_week_earnings_pence: lastWeek,
    month_earnings_pence: month,
    last_month_earnings_pence: lastMonth,
    quarter_earnings_pence: quarter,
    year_earnings_pence: year,
    last_year_earnings_pence: lastYear,
    lifetime_earnings_pence: lifetime,
    pending_earnings_pence: Math.max(0, Number(args?.pendingEarningsPence ?? 0)),
    total_bonuses_pence: bonuses,
    total_adjustments_pence: adjustments,
    outstanding_debt_pence: Math.max(0, Number(args?.recoveryDebtPence ?? 0)),
    platform_commission_pence: platformCommission,
    provider_fees_reference_pence: null,
    trips_paid_count: tripsPaid,
    average_earnings_per_trip_pence: tripsPaid > 0 ? Math.round(lifetime / tripsPaid) : null,
    timezone: "Europe/London",
  };
}
