/**
 * ONECAB finance ledger SSOT — pure calculations (no I/O).
 */

export const CAPTURED_PAYMENT_STATUSES = new Set(["captured", "paid", "succeeded"]);

/** Ledger types excluded from wallet balance (informational / ONECAB-only — never driver money). */
export const BALANCE_EXCLUDED_LEDGER_TYPES = [
  "PLATFORM_COMMISSION",
  "PLATFORM_COMMISSION_GROSS",
  "PLATFORM_COMMISSION_NET",
  "COMPANY_COMMISSION",
  "COMMISSION_REVERSAL",
  "PAYMENT_PROVIDER_FEE",
  "PAYMENT_PROVIDER_FEE_ADJUSTMENT",
  "PROVIDER_FEE_REVERSAL",
  "CASH_TRIP_EARNING",
  "PAYOUT_RESERVATION_HOLD",
  "PAYOUT_RESERVATION_RELEASE",
] as const;

export const REPORTING_ONLY_LEDGER_TYPES = new Set<string>(BALANCE_EXCLUDED_LEDGER_TYPES);

export const REVERSAL_LEDGER_TYPE = "LEDGER_REVERSAL";

export const DEBT_RECOVERY_SOURCE = "CARD_EARNINGS_OFFSET";

export type LedgerRow = {
  type: string;
  amount_pence: number;
  related_trip_id?: string | null;
  created_at?: string;
};

export function isCashPaymentMethod(method: string | null | undefined): boolean {
  return String(method ?? "").trim().toLowerCase() === "cash";
}

export function isCardPaymentCaptured(args: {
  tripPaymentStatus?: string | null;
  paymentStatus?: string | null;
}): boolean {
  const pay = String(args.paymentStatus ?? "").toLowerCase();
  if (CAPTURED_PAYMENT_STATUSES.has(pay)) return true;
  const trip = String(args.tripPaymentStatus ?? "").toLowerCase();
  return CAPTURED_PAYMENT_STATUSES.has(trip);
}

export function isCardCaptureFailed(args: {
  tripPaymentStatus?: string | null;
  paymentStatus?: string | null;
}): boolean {
  const pay = String(args.paymentStatus ?? "").toLowerCase();
  if (pay === "capture_failed") return true;
  return String(args.tripPaymentStatus ?? "").toLowerCase() === "capture_failed";
}

export function sumLedgerAbs(ledger: LedgerRow[], type: string): number {
  return ledger
    .filter((r) => r.type === type)
    .reduce((s, r) => s + Math.abs(r.amount_pence ?? 0), 0);
}

export function sumLedgerPositive(ledger: LedgerRow[], type: string): number {
  return ledger
    .filter((r) => r.type === type)
    .reduce((s, r) => s + Math.max(0, r.amount_pence ?? 0), 0);
}

export function computeCashCommissionOutstanding(ledger: LedgerRow[]): number {
  const debt = sumLedgerAbs(ledger, "CASH_COMMISSION_DEBT");
  const recovered = sumLedgerAbs(ledger, "DEBT_RECOVERY");
  return Math.max(0, debt - recovered);
}

export function computeOwedToOnecab(ledger: LedgerRow[]): number {
  return computeCashCommissionOutstanding(ledger);
}

/** Single wallet balance from ledger — SSOT for cache, net_balance, and available_now. */
export function computeLedgerWalletBalancePence(ledger: LedgerRow[]): number {
  let total = 0;
  for (const entry of ledger) {
    if (REPORTING_ONLY_LEDGER_TYPES.has(entry.type)) continue;
    total += entry.amount_pence ?? 0;
  }
  return total;
}

export type DriverPayoutInputs = {
  ledger: LedgerRow[];
  settledCardDriverEarningsPence: number;
  settledCardTipsPence: number;
  pendingCardEarningsPence: number;
  pendingCardTipsPence: number;
  bonusesPence: number;
  positiveAdjustmentsPence: number;
  negativeAdjustmentsPence: number;
  paidOutPence: number;
};

export function computeAvailableNowPence(args: DriverPayoutInputs): number {
  return Math.max(0, computeLedgerWalletBalancePence(args.ledger));
}

export function computeNextWeeklyPayoutPence(args: DriverPayoutInputs): number {
  const outstanding = computeCashCommissionOutstanding(args.ledger);
  const pendingGross = args.pendingCardEarningsPence + args.pendingCardTipsPence;
  const outstandingNotCoveredBySettled = Math.max(
    0,
    outstanding
      - args.settledCardDriverEarningsPence
      - args.settledCardTipsPence
      - args.bonusesPence
      - args.positiveAdjustmentsPence,
  );
  return Math.max(0, pendingGross - outstandingNotCoveredBySettled);
}

export type PayoutEligibilityInput = {
  stripe_account_id?: string | null;
  payouts_enabled?: boolean | null;
  charges_enabled?: boolean | null;
  onboarding_complete?: boolean | null;
  external_account_exists?: boolean | null;
  requirements_currently_due?: string[] | null;
};

export type PayoutEligibility = {
  stripe_connected: boolean;
  payout_eligible: boolean;
  settlement_status: "eligible" | "needs_attention" | "not_connected";
};

export function derivePayoutEligibility(driver: PayoutEligibilityInput): PayoutEligibility {
  const stripeConnected = Boolean(driver.stripe_account_id)
    && (driver.onboarding_complete ?? false);
  const requirementsDue = driver.requirements_currently_due ?? [];
  const payoutEligible = stripeConnected
    && (driver.payouts_enabled ?? false)
    && (driver.external_account_exists ?? true)
    && requirementsDue.length === 0;

  let settlementStatus: PayoutEligibility["settlement_status"] = "not_connected";
  if (stripeConnected && payoutEligible) settlementStatus = "eligible";
  else if (stripeConnected) settlementStatus = "needs_attention";

  return {
    stripe_connected: stripeConnected,
    payout_eligible: payoutEligible,
    settlement_status: settlementStatus,
  };
}
