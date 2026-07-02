import type Stripe from "https://esm.sh/stripe@14.21.0";
import {
  PAYOUT_EXECUTION_DISABLED_CODE,
  PAYOUT_EXECUTION_DISABLED_MESSAGE,
  stripeExecutionEnabled,
} from "./payoutExecutionGate.ts";

export const PAYOUT_RETRY_INSUFFICIENT_FUNDS_CODE = "PAYOUT_RETRY_INSUFFICIENT_STRIPE_BALANCE";
export const PAYOUT_RETRY_INSUFFICIENT_FUNDS_MESSAGE =
  "Cannot retry: Stripe provider balance is negative / insufficient funds.";
export const PAYOUT_RETRY_NO_CONNECT_CODE = "PAYOUT_RETRY_NO_CONNECT_ACCOUNT";
export const PAYOUT_RETRY_NO_CONNECT_MESSAGE =
  "Cannot retry: driver has no valid Stripe Connect account.";
export const PAYOUT_RETRY_ALREADY_PAID_CODE = "PAYOUT_RETRY_ALREADY_PAID";
export const PAYOUT_RETRY_ALREADY_PAID_MESSAGE =
  "Cannot retry: payout item already paid to bank.";
export const PAYOUT_RETRY_NO_LIABILITY_CODE = "PAYOUT_RETRY_NO_PAYABLE_LIABILITY";
export const PAYOUT_RETRY_NO_LIABILITY_MESSAGE =
  "Cannot retry: no valid payable liability for this payout item.";
export const PAYOUT_RETRY_LOCAL_ONLY_CODE = "PAYOUT_RETRY_LOCAL_ONLY_UNAPPROVED";
export const PAYOUT_RETRY_LOCAL_ONLY_MESSAGE =
  "Cannot retry: local-only failed item requires explicit approval before retry.";

export type RetryGuardResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function readPlatformAvailablePence(
  stripe: Stripe,
  currency: string,
): Promise<number> {
  const balance = await stripe.balance.retrieve();
  const ccy = currency.toLowerCase();
  const available = balance.available.find((b) => b.currency === ccy)?.amount ?? 0;
  return Number(available);
}

export function assertRetryStripeBalance(args: {
  requiredAmountPence: number;
  platformAvailablePence: number;
}): RetryGuardResult {
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

export async function assertPayoutRetryAllowed(args: {
  stripe: Stripe;
  currency: string;
  requiredAmountPence: number;
  payoutItem: {
    status: string;
    stripe_transfer_id?: string | null;
    stripe_payout_id?: string | null;
    driver_paid_out_pence?: number | null;
    net_driver_payout_pence?: number | null;
    amount_pence?: number | null;
  };
  driver: {
    stripe_account_id?: string | null;
    payouts_enabled?: boolean | null;
    charges_enabled?: boolean | null;
  } | null;
  walletOwedPence?: number;
  localOnlyApproved?: boolean;
}): Promise<RetryGuardResult> {
  if (!stripeExecutionEnabled()) {
    return {
      ok: false,
      code: PAYOUT_EXECUTION_DISABLED_CODE,
      message: PAYOUT_EXECUTION_DISABLED_MESSAGE,
    };
  }

  const connectId = args.driver?.stripe_account_id;
  if (!connectId) {
    return { ok: false, code: PAYOUT_RETRY_NO_CONNECT_CODE, message: PAYOUT_RETRY_NO_CONNECT_MESSAGE };
  }

  if (args.driver?.payouts_enabled === false) {
    return {
      ok: false,
      code: "PAYOUT_RETRY_PAYOUTS_DISABLED",
      message: "Cannot retry: Stripe Connect payouts_enabled is false for this account.",
    };
  }

  const st = String(args.payoutItem.status ?? "").toLowerCase();
  if (st === "completed" || args.payoutItem.stripe_payout_id) {
    return { ok: false, code: PAYOUT_RETRY_ALREADY_PAID_CODE, message: PAYOUT_RETRY_ALREADY_PAID_MESSAGE };
  }

  const net = Math.max(
    0,
    Number(args.payoutItem.net_driver_payout_pence ?? args.payoutItem.amount_pence ?? 0),
  );
  const paidOut = Number(args.payoutItem.driver_paid_out_pence ?? 0);
  if (paidOut >= net && net > 0) {
    return { ok: false, code: PAYOUT_RETRY_ALREADY_PAID_CODE, message: PAYOUT_RETRY_ALREADY_PAID_MESSAGE };
  }

  const walletOwed = Math.max(0, args.walletOwedPence ?? 0);
  if (walletOwed <= 0 && net > 0) {
    return { ok: false, code: PAYOUT_RETRY_NO_LIABILITY_CODE, message: PAYOUT_RETRY_NO_LIABILITY_MESSAGE };
  }

  const hasStripeEvidence = Boolean(args.payoutItem.stripe_transfer_id || args.payoutItem.stripe_payout_id);
  const isLocalOnly = !hasStripeEvidence && ["failed", "ledger_sync_failed"].includes(st);
  if (isLocalOnly && !args.localOnlyApproved) {
    return { ok: false, code: PAYOUT_RETRY_LOCAL_ONLY_CODE, message: PAYOUT_RETRY_LOCAL_ONLY_MESSAGE };
  }

  const platformAvailable = await readPlatformAvailablePence(args.stripe, args.currency);
  if (platformAvailable < 0) {
    return {
      ok: false,
      code: PAYOUT_RETRY_INSUFFICIENT_FUNDS_CODE,
      message: PAYOUT_RETRY_INSUFFICIENT_FUNDS_MESSAGE,
    };
  }

  return assertRetryStripeBalance({
    requiredAmountPence: args.requiredAmountPence,
    platformAvailablePence: Math.max(0, platformAvailable),
  });
}
