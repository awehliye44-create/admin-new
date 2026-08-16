/**
 * Driver wallet summary — single source of truth for payout balances and today earnings.
 * Used by driver-wallet-summary edge function and client unit tests.
 */

import {
  EARLY_CASHOUT_SETTLEMENT_BLOCKED_MESSAGE,
  formatMinCashoutMessage,
  MIN_CASHOUT_AMOUNT_PENCE,
} from '../../../shared/earlyCashout.ts';
import {
  computeCashCommissionOutstanding,
  computeLedgerWalletBalancePence,
  computeOwedToOnecab,
  derivePayoutEligibility,
  isCardCaptureFailed,
  isCardPaymentCaptured,
  REPORTING_ONLY_LEDGER_TYPES,
  REVERSAL_LEDGER_TYPE,
  sumLedgerAbs,
} from './onecabFinanceLedger.ts';

export {
  computeCashCommissionOutstanding,
  computeLedgerWalletBalancePence,
  computeOwedToOnecab,
  derivePayoutEligibility,
  isCardCaptureFailed,
  isCardPaymentCaptured,
  REPORTING_ONLY_LEDGER_TYPES,
  REVERSAL_LEDGER_TYPE,
} from './onecabFinanceLedger.ts';

export const EARNING_LEDGER_TYPES = new Set([
  'TRIP_EARNING_NET',
  'CASH_TRIP_EARNING',
  'DRIVER_TIP_CREDIT',
]);

export const CARD_EARNING_LEDGER_TYPES = new Set([
  'TRIP_EARNING_NET',
  'DRIVER_TIP_CREDIT',
]);

export const CASH_DEBT_LEDGER_TYPES = new Set([
  'CASH_COMMISSION_DEBT',
]);

export const PAID_OUT_LEDGER_TYPES = new Set([
  'WEEKLY_PAYOUT',
  'EARLY_CASHOUT',
  'MANUAL_PAYOUT',
  'PAYOUT',
]);

export const ADJUSTMENT_LEDGER_TYPES = new Set([
  'ADJUSTMENT',
  'MANUAL_ADJUSTMENT',
  'REFUND_DEBIT',
]);

export const BONUS_LEDGER_TYPES = new Set(['BONUS']);

export const CAPTURED_PAYMENT_STATUSES = new Set(['captured', 'paid', 'succeeded']);

const ACTIVE_PAYOUT_BATCH_STATUSES = new Set(['pending', 'processing', 'ready', 'transfer_created']);

/** Sum net on payout_items in an active batch — never derived from wallet_balance. */
export function sumActivePayoutBatchPence(items: WalletPayoutItemRow[]): number {
  return items.reduce((sum, item) => {
    const st = String(item.status ?? '').toLowerCase();
    if (!ACTIVE_PAYOUT_BATCH_STATUSES.has(st)) return sum;
    const net = Math.max(0, Number(item.driver_amount_pence ?? item.amount_pence ?? 0));
    return sum + net;
  }, 0);
}

export type CashOutBlockedReason =
  | 'no_available_digital_balance'
  | 'below_min_cashout'
  | 'provider_not_connected'
  | 'payout_pending'
  | 'cashout_in_progress'
  | 'account_restricted'
  | 'compliance_hold'
  | 'payout_items_missing'
  | 'provider_settlement_pending'
  | 'early_cashout_disabled'
  | null;

export interface WalletInFlightCashout {
  id?: string;
  status: string;
  requested_cashout_pence: number;
  early_cashout_fee_pence?: number | null;
  driver_receives_pence?: number | null;
  provider_payout_id?: string | null;
  payout_method?: string | null;
}

export interface WalletLedgerEntry {
  type: string;
  amount_pence: number;
  created_at: string;
  related_trip_id: string | null;
}

export interface WalletTripRow {
  id: string;
  trip_code?: string | null;
  payment_method: string | null;
  payment_status: string | null;
}

export interface WalletPaymentRow {
  id?: string;
  trip_id: string;
  status: string | null;
  captured_amount_pence?: number | null;
}

export interface WalletPayoutItemRow {
  trip_id: string | null;
  payment_id?: string | null;
  status: string;
  amount_pence: number;
  driver_amount_pence: number | null;
  provider_transfer_id: string | null;
  /** Provider funds-available cutoff (unix seconds), when known. */
  available_on_epoch_seconds?: number | null;
  /** Provider balance transaction id (optional telemetry/diagnostic). */
  provider_balance_transaction_id?: string | null;
  /** Captured amount from payments table fallback. */
  captured_amount_pence?: number | null;
}

export interface WalletSummaryDriver {
  provider_account_id?: string | null;
  payouts_enabled?: boolean | null;
  charges_enabled?: boolean | null;
  onboarding_complete?: boolean | null;
  compliance_hold?: boolean | null;
  external_account_exists?: boolean | null;
  requirements_currently_due?: string[] | null;
}

export interface DriverWalletSummaryInput {
  driver: WalletSummaryDriver;
  ledgerEntries: WalletLedgerEntry[];
  trips: WalletTripRow[];
  payments: WalletPaymentRow[];
  payoutItems: WalletPayoutItemRow[];
  /** Europe/London calendar date YYYY-MM-DD for "today". */
  todayDateStr: string;
  /** Current unix seconds for available_on cutoff. Defaults to now. */
  nowUnixSeconds?: number;
  cashoutFeePence?: number;
  /** Pending/processing early cash-outs that reserve wallet balance. */
  inFlightCashouts?: WalletInFlightCashout[];
}

export interface DriverWalletSummaryResult {
  today_total_pence: number;
  today_card_pence: number;
  today_cash_pence: number;
  today_tips_pence: number;
  card_earnings_pence: number;
  available_payout_pence: number;
  pending_payout_pence: number;
  /** Gross balance reserved by pending/processing early cash-outs. */
  reserved_cashout_pence: number;
  /** Net amount driver receives from in-flight early cash-outs (after fee). */
  processing_cashout_pence: number;
  recovered_against_debt_pence: number;
  paid_out_pence: number;
  /** Most recent bank transfer / instant cash out (not cumulative). */
  last_paid_out_pence: number;
  /** Bonuses credited in the current calendar year (Europe/London). */
  bonuses_this_year_pence: number;
  /** Net adjustments in the current calendar year (Europe/London). */
  adjustments_this_year_pence: number;
  /** Settled funds eligible for instant cash-out (before in-flight reservation). */
  settled_eligible_driver_funds_pence: number;
  /** Gross in-flight early cash-out reservations. */
  in_flight_cashout_pence: number;
  /** Cash-out eligible now — never includes already-paid or in-flight funds. */
  available_now_pence: number;
  /** Scheduled for next weekly bank transfer. */
  next_weekly_payout_pence: number;
  /** Captured card earnings awaiting payment settlement. */
  pending_settlement_pence: number;
  /** Net adjustments (refunds, chargebacks, manual corrections). */
  adjustments_pence: number;
  /** Sum of cash trip fares collected this payout week (Mon–Sun, Europe/London). */
  weekly_cash_collected_pence: number;
  /** Unpaid cash-trip commission owed to ONECAB for the current period. */
  cash_commission_due_pence: number;
  /** Settled (captured) card driver earnings — excludes cash, tips, and uncaptured card. */
  settled_card_driver_earnings_pence: number;
  /** Settled (captured) card tips — excludes cash and uncaptured card. */
  settled_card_tips_pence: number;
  /** Positive wallet adjustments (refunds reversed, credits). */
  positive_adjustments_pence: number;
  /** Negative wallet adjustments (debits, chargebacks). */
  negative_adjustments_pence: number;
  /** Bonuses credited to the wallet. */
  bonuses_pence: number;
  /** Details-only: available + weekly + pending settlement. */
  total_unpaid_balance_pence: number;
  net_balance_pence: number;
  lifetime_earnings_pence: number;
  cash_out_available: boolean;
  cash_out_blocked_reason: CashOutBlockedReason;
  connected_account_status: 'connected' | 'pending' | 'not_started';
  next_available_on_iso: string | null;
  /** Internal audit trail for edge logs. */
  audit: {
    trips_included: string[];
    trips_excluded: Array<{ trip_id: string; reason: string }>;
    payout_items_included: string[];
    payout_items_missing_trip_ids: string[];
  };
}

export function londonDateKey(isoTimestamp: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoTimestamp));
}

/** Monday (YYYY-MM-DD) of the Europe/London calendar week containing `dateStr`. */
export function isInLondonCalendarYear(entryIsoTimestamp: string, todayDateStr: string): boolean {
  return londonDateKey(entryIsoTimestamp).slice(0, 4) === todayDateStr.slice(0, 4);
}

/** Latest completed payout debit from ledger (weekly or instant cash out). */
export function computeLastPaidOutPence(entries: WalletLedgerEntry[]): number {
  let latest: { at: string; amount: number } | null = null;
  for (const entry of entries) {
    if (!PAID_OUT_LEDGER_TYPES.has(entry.type)) continue;
    const amount = entry.amount_pence ?? 0;
    if (amount >= 0) continue;
    const absAmount = Math.abs(amount);
    if (!latest || entry.created_at > latest.at) {
      latest = { at: entry.created_at, amount: absAmount };
    }
  }
  return latest?.amount ?? 0;
}

export function mondayOfLondonWeek(dateStr: string): string {
  const day = new Date(`${dateStr}T12:00:00Z`);
  const dow = day.getUTCDay();
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  day.setUTCDate(day.getUTCDate() - mondayOffset);
  return day.toISOString().slice(0, 10);
}

export function isInCurrentLondonPayoutWeek(
  entryIsoTimestamp: string,
  todayDateStr: string,
): boolean {
  return mondayOfLondonWeek(londonDateKey(entryIsoTimestamp)) === mondayOfLondonWeek(todayDateStr);
}

export function deriveConnectedAccountStatus(
  driver: WalletSummaryDriver,
): 'connected' | 'pending' | 'not_started' {
  const eligibility = derivePayoutEligibility(driver);
  if (!eligibility.provider_connected) {
    return driver.provider_account_id ? 'pending' : 'not_started';
  }
  return 'connected';
}

function isCashTrip(trip: WalletTripRow | undefined): boolean {
  return (trip?.payment_method ?? '').toLowerCase() === 'cash';
}

function paymentCaptured(
  trip: WalletTripRow | undefined,
  paymentByTripId: Map<string, WalletPaymentRow>,
): boolean {
  if (!trip) return false;
  const payment = paymentByTripId.get(trip.id);
  if (isCardCaptureFailed({
    tripPaymentStatus: trip.payment_status,
    paymentStatus: payment?.status,
  })) {
    return false;
  }
  return isCardPaymentCaptured({
    tripPaymentStatus: trip.payment_status,
    paymentStatus: payment?.status,
  });
}

function digitalAmountForTrip(
  ledgerByTrip: Map<string, WalletLedgerEntry[]>,
  tripId: string,
): number {
  return settledTripEarningForTrip(ledgerByTrip, tripId)
    + settledTipsForTrip(ledgerByTrip, tripId);
}

function filterLedgerForWalletBalance(
  entries: WalletLedgerEntry[],
  tripById: Map<string, WalletTripRow>,
  paymentByTripId: Map<string, WalletPaymentRow>,
): WalletLedgerEntry[] {
  const phantomTripIds = new Set<string>();

  for (const [tripId, trip] of tripById) {
    if (isCashTrip(trip)) continue;
    const payment = paymentByTripId.get(tripId);
    if (!isCardCaptureFailed({
      tripPaymentStatus: trip.payment_status,
      paymentStatus: payment?.status,
    })) {
      continue;
    }
    const hasReversal = entries.some(
      (entry) => entry.related_trip_id === tripId && entry.type === REVERSAL_LEDGER_TYPE,
    );
    if (!hasReversal) phantomTripIds.add(tripId);
  }

  if (phantomTripIds.size === 0) return entries;

  return entries.filter((entry) => {
    if (!entry.related_trip_id || !phantomTripIds.has(entry.related_trip_id)) return true;
    return entry.type !== 'TRIP_EARNING_NET' && entry.type !== 'DRIVER_TIP_CREDIT';
  });
}

function settledTripEarningForTrip(
  ledgerByTrip: Map<string, WalletLedgerEntry[]>,
  tripId: string,
): number {
  const entries = ledgerByTrip.get(tripId) ?? [];
  let total = 0;
  for (const entry of entries) {
    if (entry.type === 'TRIP_EARNING_NET') {
      total += entry.amount_pence ?? 0;
    }
  }
  return Math.max(total, 0);
}

function settledTipsForTrip(
  ledgerByTrip: Map<string, WalletLedgerEntry[]>,
  tripId: string,
): number {
  const entries = ledgerByTrip.get(tripId) ?? [];
  let total = 0;
  for (const entry of entries) {
    if (entry.type === 'DRIVER_TIP_CREDIT') {
      total += entry.amount_pence ?? 0;
    }
  }
  return Math.max(total, 0);
}

export function computeDriverWalletSummary(
  input: DriverWalletSummaryInput,
): DriverWalletSummaryResult {
  const cashoutFeePence = input.cashoutFeePence ?? 50;
  // Kept in input for backwards compatibility with previous available_on-based logic.
  void input.nowUnixSeconds;
  const tripById = new Map(input.trips.map((t) => [t.id, t]));
  const paymentByTripId = new Map(input.payments.map((p) => [p.trip_id, p]));
  const payoutByTripId = new Map(
    input.payoutItems
      .filter((p) => p.trip_id)
      .map((p) => [p.trip_id as string, p]),
  );

  const ledgerByTrip = new Map<string, WalletLedgerEntry[]>();
  for (const entry of input.ledgerEntries) {
    if (!entry.related_trip_id) continue;
    const list = ledgerByTrip.get(entry.related_trip_id) ?? [];
    list.push(entry);
    ledgerByTrip.set(entry.related_trip_id, list);
  }

  let todayTotal = 0;
  let todayCard = 0;
  let todayCash = 0;
  let todayTips = 0;

  for (const entry of input.ledgerEntries) {
    if (!EARNING_LEDGER_TYPES.has(entry.type)) continue;
    if (londonDateKey(entry.created_at) !== input.todayDateStr) continue;

    const amount = entry.amount_pence ?? 0;
    todayTotal += amount;

    if (entry.type === 'TRIP_EARNING_NET') todayCard += amount;
    if (entry.type === 'CASH_TRIP_EARNING') todayCash += amount;
    if (entry.type === 'DRIVER_TIP_CREDIT') {
      todayTips += amount;
      todayCard += amount;
    }
  }

  const balanceAffectingLedger = filterLedgerForWalletBalance(
    input.ledgerEntries,
    tripById,
    paymentByTripId,
  );

  // Wallet balance must match driver_financial_summary.wallet_balance (full ledger SSOT).
  const netBalance = computeLedgerWalletBalancePence(input.ledgerEntries);

  let adjustmentsPence = 0;
  let positiveAdjustmentsPence = 0;
  let negativeAdjustmentsPence = 0;
  let bonusesPence = 0;
  let bonusesThisYearPence = 0;
  let adjustmentsThisYearPence = 0;
  let weeklyCashCollected = 0;
  // Digital-only — passenger cash collection metrics retired.
  for (const entry of balanceAffectingLedger) {
    if (REPORTING_ONLY_LEDGER_TYPES.has(entry.type)) continue;
    const amount = entry.amount_pence ?? 0;
    const inThisYear = isInLondonCalendarYear(entry.created_at, input.todayDateStr);
    if (ADJUSTMENT_LEDGER_TYPES.has(entry.type)) {
      adjustmentsPence += amount;
      if (inThisYear) adjustmentsThisYearPence += amount;
      if (amount > 0) {
        positiveAdjustmentsPence += amount;
      } else if (amount < 0) {
        negativeAdjustmentsPence += Math.abs(amount);
      }
    }
    if (BONUS_LEDGER_TYPES.has(entry.type)) {
      bonusesPence += amount;
      if (inThisYear) bonusesThisYearPence += amount;
    }
  }

  let capturedCardEarnings = 0;
  let cashCommissionDebtTotal = 0;
  let paidOut = 0;
  const tripsIncluded: string[] = [];
  const tripsExcluded: Array<{ trip_id: string; reason: string }> = [];
  const payoutItemsIncluded: string[] = [];
  const payoutItemsMissingTripIds: string[] = [];

  for (const entry of input.ledgerEntries) {
    const amount = entry.amount_pence ?? 0;
    if (CARD_EARNING_LEDGER_TYPES.has(entry.type) && amount > 0) {
      const trip = entry.related_trip_id ? tripById.get(entry.related_trip_id) : undefined;
      const payment = entry.related_trip_id ? paymentByTripId.get(entry.related_trip_id) : undefined;
      if (entry.related_trip_id && isCardCaptureFailed({
        tripPaymentStatus: trip?.payment_status,
        paymentStatus: payment?.status,
      })) {
        continue;
      }
      capturedCardEarnings += amount;
    }
    if (CASH_DEBT_LEDGER_TYPES.has(entry.type) && amount < 0) {
      cashCommissionDebtTotal += Math.abs(amount);
    }
    if (PAID_OUT_LEDGER_TYPES.has(entry.type) && amount < 0) {
      paidOut += Math.abs(amount);
    }
  }
  const lastPaidOut = computeLastPaidOutPence(input.ledgerEntries);

  const digitalTripIds = new Set<string>();
  for (const [tripId, entries] of ledgerByTrip) {
    const trip = tripById.get(tripId);
    if (isCashTrip(trip)) {
      tripsExcluded.push({ trip_id: tripId, reason: 'cash_not_digital_payout' });
      continue;
    }
    const payment = paymentByTripId.get(tripId);
    if (isCardCaptureFailed({
      tripPaymentStatus: trip?.payment_status,
      paymentStatus: payment?.status,
    })) {
      tripsExcluded.push({ trip_id: tripId, reason: 'capture_failed' });
      continue;
    }
    if (!entries.some((e) => e.type === 'TRIP_EARNING_NET' || e.type === 'DRIVER_TIP_CREDIT')) {
      continue;
    }
    digitalTripIds.add(tripId);
  }

  for (const tripId of digitalTripIds) {
    const trip = tripById.get(tripId);
    const payoutItem = payoutByTripId.get(tripId);
    const digitalAmount = digitalAmountForTrip(ledgerByTrip, tripId);
    if (digitalAmount <= 0) continue;

    const captured = paymentCaptured(trip, paymentByTripId);
    if (!captured) {
      tripsExcluded.push({ trip_id: tripId, reason: 'capture_not_completed' });
      continue;
    }

    if (!payoutItem) {
      payoutItemsMissingTripIds.push(tripId);
      tripsIncluded.push(tripId);
      continue;
    }

    payoutItemsIncluded.push(tripId);
    tripsIncluded.push(tripId);
  }

  let settledCardDriverEarnings = 0;
  let settledCardTips = 0;
  for (const tripId of digitalTripIds) {
    const trip = tripById.get(tripId);
    if (!paymentCaptured(trip, paymentByTripId)) continue;
    settledCardDriverEarnings += settledTripEarningForTrip(ledgerByTrip, tripId);
    settledCardTips += settledTipsForTrip(ledgerByTrip, tripId);
  }

  let pendingSettlement = 0;
  let pendingCardEarnings = 0;
  let pendingCardTips = 0;
  for (const excluded of tripsExcluded) {
    if (excluded.reason === 'capture_not_completed') {
      const tripNet = settledTripEarningForTrip(ledgerByTrip, excluded.trip_id);
      const tripTips = settledTipsForTrip(ledgerByTrip, excluded.trip_id);
      pendingSettlement += tripNet + tripTips;
      pendingCardEarnings += tripNet;
      pendingCardTips += tripTips;
    }
  }

  const cashCommissionDue = 0;
  const recoveredAgainstDebt = sumLedgerAbs(input.ledgerEntries, 'DEBT_RECOVERY');
  const nextWeeklyPayout = sumActivePayoutBatchPence(input.payoutItems);
  const availablePayout = 0;
  const grossAvailablePayout = 0;

  let reservedCashoutPence = 0;
  let processingCashoutPence = 0;
  for (const cashout of input.inFlightCashouts ?? []) {
    if (cashout.status === 'pending' || cashout.status === 'processing') {
      const requested = Math.max(0, cashout.requested_cashout_pence ?? 0);
      reservedCashoutPence += requested;
      if (typeof cashout.driver_receives_pence === 'number') {
        processingCashoutPence += Math.max(0, cashout.driver_receives_pence);
      } else if (typeof cashout.early_cashout_fee_pence === 'number') {
        processingCashoutPence += Math.max(requested - cashout.early_cashout_fee_pence, 0);
      } else {
        processingCashoutPence += Math.max(requested - cashoutFeePence, 0);
      }
    }
  }

  const settledEligibleDriverFunds = 0;
  const availableNow = 0;
  const pendingPayout = nextWeeklyPayout;
  const totalUnpaidBalance = netBalance;
  const lifetime = paidOut + netBalance + adjustmentsPence + weeklyCashCollected;

  const connectedStatus = deriveConnectedAccountStatus(input.driver);
  const payoutEligibility = derivePayoutEligibility(input.driver);
  let cashOutBlockedReason: CashOutBlockedReason = null;
  let cashOutAvailable = false;

  if (!payoutEligibility.provider_connected) {
    cashOutBlockedReason = 'provider_not_connected';
  } else if (!payoutEligibility.payout_eligible) {
    cashOutBlockedReason = 'account_restricted';
  } else if (input.driver.compliance_hold) {
    cashOutBlockedReason = 'compliance_hold';
  } else if (reservedCashoutPence > 0) {
    cashOutBlockedReason = 'cashout_in_progress';
  } else if (availablePayout <= 0) {
    cashOutBlockedReason = 'no_available_digital_balance';
  } else if (availablePayout < MIN_CASHOUT_AMOUNT_PENCE) {
    cashOutBlockedReason = 'below_min_cashout';
  } else {
    cashOutAvailable = true;
    cashOutBlockedReason = null;
  }

  return {
    today_total_pence: todayTotal,
    today_card_pence: todayCard,
    today_cash_pence: todayCash,
    today_tips_pence: todayTips,
    card_earnings_pence: capturedCardEarnings,
    available_payout_pence: availableNow,
    pending_payout_pence: nextWeeklyPayout,
    reserved_cashout_pence: reservedCashoutPence,
    processing_cashout_pence: processingCashoutPence,
    recovered_against_debt_pence: recoveredAgainstDebt,
    paid_out_pence: paidOut,
    last_paid_out_pence: lastPaidOut,
    bonuses_this_year_pence: bonusesThisYearPence,
    adjustments_this_year_pence: adjustmentsThisYearPence,
    settled_eligible_driver_funds_pence: settledEligibleDriverFunds,
    in_flight_cashout_pence: reservedCashoutPence,
    available_now_pence: availableNow,
    next_weekly_payout_pence: nextWeeklyPayout,
    pending_settlement_pence: pendingSettlement,
    adjustments_pence: adjustmentsPence,
    weekly_cash_collected_pence: weeklyCashCollected,
    cash_commission_due_pence: cashCommissionDue,
    settled_card_driver_earnings_pence: settledCardDriverEarnings,
    settled_card_tips_pence: settledCardTips,
    positive_adjustments_pence: positiveAdjustmentsPence,
    negative_adjustments_pence: negativeAdjustmentsPence,
    bonuses_pence: bonusesPence,
    total_unpaid_balance_pence: totalUnpaidBalance,
    net_balance_pence: netBalance,
    lifetime_earnings_pence: lifetime,
    cash_out_available: cashOutAvailable,
    cash_out_blocked_reason: cashOutBlockedReason,
    connected_account_status: connectedStatus,
    next_available_on_iso: null,
    audit: {
      trips_included: tripsIncluded,
      trips_excluded: tripsExcluded,
      payout_items_included: payoutItemsIncluded,
      payout_items_missing_trip_ids: payoutItemsMissingTripIds,
    },
  };
}

export function cashOutBlockedReasonMessage(
  reason: CashOutBlockedReason,
  currencySymbol = '£',
  cashoutFeePence = 50,
): string {
  switch (reason) {
    case 'below_min_cashout':
      return formatMinCashoutMessage(currencySymbol);
    case 'provider_settlement_pending':
      return EARLY_CASHOUT_SETTLEMENT_BLOCKED_MESSAGE;
    case 'no_available_digital_balance':
      return 'No card funds available to withdraw yet.';
    case 'provider_not_connected':
      return 'Add a payout account before withdrawing funds.';
    case 'payout_pending':
      return 'No funds available to withdraw yet — payment settlement in progress.';
    case 'cashout_in_progress':
      return 'Withdrawals are not available — a withdrawal is already processing.';
    case 'account_restricted':
      return 'Payout account needs attention';
    case 'compliance_hold':
      return 'Withdrawals are not available — compliance hold on account.';
    case 'payout_items_missing':
      return 'Withdrawals are not available — payout items missing for eligible card earnings.';
    case 'early_cashout_disabled':
      return 'Withdrawals are not available in your area yet. Your earnings will be paid on the normal payout schedule.';
    default:
      return '';
  }
}
