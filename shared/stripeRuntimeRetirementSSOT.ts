/**
 * Slice 8 — Stripe runtime retirement (labels / gates / remnants).
 * Pure helpers for payout provider resolution after Stripe is retired.
 */

export function resolveActivePayoutProviderFromServiceArea(area: {
  payment_provider?: string | null;
  driver_payout_gateway?: string | null;
  customer_payment_gateway?: string | null;
}): string | null {
  const payoutGw = String(area.driver_payout_gateway ?? "").trim().toLowerCase();
  if (payoutGw && payoutGw !== "stripe") return payoutGw;
  const payment = String(area.payment_provider ?? "").trim().toLowerCase();
  if (payment && payment !== "stripe") return payment;
  const customer = String(area.customer_payment_gateway ?? "").trim().toLowerCase();
  if (customer && customer !== "stripe") return customer;
  return null;
}

/** True when Monday settlement may create batches without Stripe execution flag. */
export function mondaySettlementAllowedWithoutStripeExecution(args: {
  payout_provider: string | null | undefined;
  stripe_execution_enabled?: boolean;
}): boolean {
  const p = String(args.payout_provider ?? "").trim().toLowerCase();
  if (p === "revolut" || p === "bank_transfer" || p === "manual" || p === "manual_bank") {
    return true;
  }
  return args.stripe_execution_enabled === true;
}

/** Revolut/manual destination readiness — Connect ID never required. */
export function isPayoutDestinationReady(args: {
  manual_provider_payout: boolean;
  payouts_enabled?: boolean | null;
  legacy_connect_account_id?: string | null;
}): boolean {
  if (args.manual_provider_payout) {
    return args.payouts_enabled !== false;
  }
  return Boolean(args.legacy_connect_account_id);
}
