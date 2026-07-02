/**
 * Payout eligibility SSOT — pure calculations (no I/O).
 *
 * Separates:
 * - driver wallet unpaid (what ONECAB owes)
 * - stripe settled unpaid (what Stripe has made available)
 * - finance reconciled unpaid (FR gate — blocks when payout_blocked)
 *
 * eligible_payout = min(wallet_unpaid, stripe_settled_unpaid, finance_reconciled_unpaid)
 */

export const SETTLEMENT_STATUSES = ["pending", "settled", "failed"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const CARD_PAYMENT_METHODS = new Set(["card", "apple_pay", "google_pay"]);

export const CAPTURED_PAYMENT_STATUSES = new Set(["captured", "paid", "succeeded"]);

/** Ops-approved reason code for legacy payouts with no provable earning match. */
export const LEGACY_MANUAL_PAYOUT_NO_PROVABLE_MATCH = "LEGACY_MANUAL_PAYOUT_NO_PROVABLE_MATCH";

export type PayoutEligibilityAggregateInput = {
  walletUnpaidPence: number;
  stripeSettledUnpaidPence: number;
  payoutBlocked: boolean;
  inFlightPayoutPence?: number;
};

export type PayoutEligibilityAggregateResult = {
  eligible_payout_pence: number;
  awaiting_settlement_pence: number;
  finance_reconciled_unpaid_pence: number;
};

export type EarningSettlementInput = {
  amount_pence: number;
  payment_method?: string | null;
  settlement_status?: SettlementStatus | null;
  paid_in_batch_id?: string | null;
  allocated_to_payout?: boolean;
  allocated_amount_pence?: number;
  trip_completed?: boolean;
  payment_captured?: boolean;
};

export function remainingPayablePence(earning: EarningSettlementInput): number {
  const total = Math.max(0, earning.amount_pence ?? 0);
  const allocated = Math.max(0, earning.allocated_amount_pence ?? 0);
  if (earning.allocated_to_payout === true) return 0;
  return Math.max(0, total - allocated);
}

export function isCashPaymentMethod(method: string | null | undefined): boolean {
  return String(method ?? "").trim().toLowerCase() === "cash";
}

export function isCardPaymentMethod(method: string | null | undefined): boolean {
  return CARD_PAYMENT_METHODS.has(String(method ?? "").trim().toLowerCase());
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

/** Cash earnings never require Stripe settlement for payout eligibility. */
export function requiresStripeSettlement(paymentMethod: string | null | undefined): boolean {
  return isCardPaymentMethod(paymentMethod);
}

export function computeFinanceReconciledUnpaidPence(
  walletUnpaidPence: number,
  payoutBlocked: boolean,
): number {
  if (payoutBlocked) return 0;
  return Math.max(0, walletUnpaidPence);
}

export function computeAwaitingSettlementPence(
  walletUnpaidPence: number,
  stripeSettledUnpaidPence: number,
): number {
  return Math.max(0, walletUnpaidPence - stripeSettledUnpaidPence);
}

/**
 * Aggregate payout eligibility — used by settlement batch, FR edge, and driver UI.
 * Caps payout to the minimum of wallet, stripe-settled, and FR-reconciled unpaid.
 */
export function computePayoutEligibility(
  input: PayoutEligibilityAggregateInput,
): PayoutEligibilityAggregateResult {
  const walletUnpaidPence = Math.max(0, input.walletUnpaidPence);
  const stripeSettledUnpaidPence = Math.max(0, input.stripeSettledUnpaidPence);
  const financeReconciledUnpaidPence = computeFinanceReconciledUnpaidPence(
    walletUnpaidPence,
    input.payoutBlocked,
  );

  const awaitingSettlementPence = computeAwaitingSettlementPence(
    walletUnpaidPence,
    stripeSettledUnpaidPence,
  );

  const rawEligible = Math.min(
    walletUnpaidPence,
    stripeSettledUnpaidPence,
    financeReconciledUnpaidPence,
  );

  const inFlight = Math.max(0, input.inFlightPayoutPence ?? 0);
  const eligiblePayoutPence = Math.max(0, rawEligible - inFlight);

  return {
    eligible_payout_pence: eligiblePayoutPence,
    awaiting_settlement_pence: awaitingSettlementPence,
    finance_reconciled_unpaid_pence: financeReconciledUnpaidPence,
  };
}

/** P0: Payable only when not paid AND not fully allocated. */
export function isEarningPayableForPayout(earning: EarningSettlementInput): boolean {
  if (earning.paid_in_batch_id) return false;
  if (earning.allocated_to_payout === true) return false;
  return remainingPayablePence(earning) > 0;
}

/** Per-earning eligibility — card rows require settlement_status = settled. */
export function isEarningEligibleForPayout(
  earning: EarningSettlementInput,
): boolean {
  const amount = earning.amount_pence ?? 0;
  if (amount <= 0) return false;
  if (!isEarningPayableForPayout(earning)) return false;
  if (earning.trip_completed === false) return false;
  if (earning.payment_captured === false) return false;

  if (requiresStripeSettlement(earning.payment_method)) {
    return earning.settlement_status === "settled";
  }

  return true;
}

export function deriveIneligibleReason(earning: EarningSettlementInput): string | null {
  if ((earning.amount_pence ?? 0) <= 0) return "zero_or_negative_amount";
  if (earning.paid_in_batch_id) return "already_paid";
  if (earning.allocated_to_payout) return "already_allocated";
  if (earning.trip_completed === false) return "trip_not_completed";
  if (earning.payment_captured === false) return "payment_not_captured";
  if (
    requiresStripeSettlement(earning.payment_method)
    && earning.settlement_status !== "settled"
  ) {
    return earning.settlement_status === "failed"
      ? "stripe_settlement_failed"
      : "awaiting_stripe_settlement";
  }
  return null;
}

export function sumStripeSettledUnpaidPence(
  earnings: EarningSettlementInput[],
): number {
  return earnings.reduce((sum, row) => {
    if (!requiresStripeSettlement(row.payment_method)) return sum;
    if (!isEarningPayableForPayout(row)) return sum;
    if (row.settlement_status !== "settled") return sum;
    return sum + remainingPayablePence(row);
  }, 0);
}

export function sumEligibleEarningPence(earnings: EarningSettlementInput[]): number {
  return earnings.reduce((sum, row) => {
    if (!isEarningEligibleForPayout(row)) return sum;
    return sum + remainingPayablePence(row);
  }, 0);
}

/**
 * Eligible settled unpaid sum minus in-flight and manual-review holdbacks.
 * Does not apply wallet cap — use for diagnostics only.
 */
export function computeHoldbackAdjustedPayoutPence(
  earnings: EarningSettlementInput[],
  args?: {
    payoutBlocked?: boolean;
    inFlightPayoutPence?: number;
    manualReviewUnallocatedPence?: number;
  },
): number {
  if (args?.payoutBlocked) return 0;
  const raw = sumEligibleEarningPence(earnings);
  const inFlight = Math.max(0, args?.inFlightPayoutPence ?? 0);
  const manualReview = Math.max(0, args?.manualReviewUnallocatedPence ?? 0);
  return Math.max(0, raw - inFlight - manualReview);
}

/**
 * P1-4+ payout authorization amount from per-earning eligibility (not wallet alone).
 * Hard rule: when walletBalancePence is supplied, result never exceeds it.
 */
export function computePayoutAmountFromEligibleEarnings(
  earnings: EarningSettlementInput[],
  args?: {
    payoutBlocked?: boolean;
    inFlightPayoutPence?: number;
    manualReviewUnallocatedPence?: number;
    walletBalancePence?: number;
  },
): number {
  const afterHoldbacks = computeHoldbackAdjustedPayoutPence(earnings, args);
  const wallet = args?.walletBalancePence;
  if (wallet != null && Number.isFinite(wallet)) {
    return Math.min(afterHoldbacks, Math.max(0, wallet));
  }
  return afterHoldbacks;
}
