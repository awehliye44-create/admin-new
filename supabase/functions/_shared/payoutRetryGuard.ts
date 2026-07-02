import type Stripe from "https://esm.sh/stripe@14.21.0";

export const PAYOUT_RETRY_INSUFFICIENT_FUNDS_CODE = "PAYOUT_RETRY_INSUFFICIENT_STRIPE_BALANCE";

export const PAYOUT_RETRY_INSUFFICIENT_FUNDS_MESSAGE =
  "Cannot retry: Stripe provider balance is negative / insufficient funds.";

export async function readPlatformAvailablePence(
  stripe: Stripe,
  currency: string,
): Promise<number> {
  const balance = await stripe.balance.retrieve();
  const ccy = currency.toLowerCase();
  const available = balance.available.find((b) => b.currency === ccy)?.amount ?? 0;
  return Math.max(0, Number(available));
}

export function assertRetryStripeBalance(args: {
  requiredAmountPence: number;
  platformAvailablePence: number;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (args.requiredAmountPence <= 0) {
    return { ok: false, code: "PAYOUT_RETRY_ZERO_AMOUNT", message: "Payout amount must be positive" };
  }
  if (args.platformAvailablePence < args.requiredAmountPence) {
    return {
      ok: false,
      code: PAYOUT_RETRY_INSUFFICIENT_FUNDS_CODE,
      message: PAYOUT_RETRY_INSUFFICIENT_FUNDS_MESSAGE,
    };
  }
  return { ok: true };
}
