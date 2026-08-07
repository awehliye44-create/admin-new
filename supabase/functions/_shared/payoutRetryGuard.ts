/**
 * Payout retry guards — Revolut / ledger-only.
 * Stripe Connect money-movement retries are permanently retired.
 */

export const PAYOUT_RETRY_INSUFFICIENT_FUNDS_CODE = "PAYOUT_RETRY_INSUFFICIENT_PROVIDER_BALANCE";
export const PAYOUT_RETRY_INSUFFICIENT_FUNDS_MESSAGE =
  "Cannot retry: provider balance is negative / insufficient funds.";
export const PAYOUT_RETRY_NO_DESTINATION_CODE = "PAYOUT_RETRY_NO_PAYOUT_DESTINATION";
export const PAYOUT_RETRY_NO_DESTINATION_MESSAGE =
  "Cannot retry: driver has no active Revolut/business payout destination.";
export const PAYOUT_RETRY_ALREADY_PAID_CODE = "PAYOUT_RETRY_ALREADY_PAID";
export const PAYOUT_RETRY_ALREADY_PAID_MESSAGE =
  "Cannot retry: payout item already paid to bank.";
export const PAYOUT_RETRY_NO_LIABILITY_CODE = "PAYOUT_RETRY_NO_PAYABLE_LIABILITY";
export const PAYOUT_RETRY_NO_LIABILITY_MESSAGE =
  "Cannot retry: no valid payable liability for this payout item.";
export const PAYOUT_RETRY_LOCAL_ONLY_CODE = "PAYOUT_RETRY_LOCAL_ONLY_UNAPPROVED";
export const PAYOUT_RETRY_LOCAL_ONLY_MESSAGE =
  "Cannot retry: local-only failed item requires explicit approval before retry.";
/** @deprecated Stripe Connect retired — use PAYOUT_RETRY_NO_DESTINATION_CODE. */
export const PAYOUT_RETRY_NO_CONNECT_CODE = PAYOUT_RETRY_NO_DESTINATION_CODE;
/** @deprecated Stripe Connect retired — use PAYOUT_RETRY_NO_DESTINATION_MESSAGE. */
export const PAYOUT_RETRY_NO_CONNECT_MESSAGE = PAYOUT_RETRY_NO_DESTINATION_MESSAGE;

export type RetryGuardResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function assertRetryProviderBalance(args: {
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

/** @deprecated Alias — Stripe Balance API retired. */
export const assertRetryStripeBalance = assertRetryProviderBalance;

/**
 * Ledger/Revolut retry gate. Does not call Stripe.
 * Pass platformAvailablePence from Revolut Business balance (or omit to skip balance check).
 */
export function assertPayoutRetryAllowed(args: {
  currency: string;
  requiredAmountPence: number;
  platformAvailablePence?: number | null;
  payoutItem: {
    status: string;
    provider_payment_id?: string | null;
    provider_transfer_id?: string | null;
    provider_payout_id?: string | null;
    driver_paid_out_pence?: number | null;
    net_driver_payout_pence?: number | null;
    amount_pence?: number | null;
  };
  driver: {
    payout_destination_active?: boolean | null;
    provider_counterparty_id?: string | null;
    revolut_business_linked?: boolean | null;
    payouts_enabled?: boolean | null;
    /** @deprecated Ignored — Stripe Connect retired. */
    stripe_account_id?: string | null;
    charges_enabled?: boolean | null;
  } | null;
  walletOwedPence?: number;
  localOnlyApproved?: boolean;
}): RetryGuardResult {
  const destinationReady = Boolean(args.driver?.payout_destination_active)
    || Boolean(String(args.driver?.provider_counterparty_id ?? "").trim())
    || Boolean(args.driver?.revolut_business_linked);

  if (!destinationReady) {
    return {
      ok: false,
      code: PAYOUT_RETRY_NO_DESTINATION_CODE,
      message: PAYOUT_RETRY_NO_DESTINATION_MESSAGE,
    };
  }

  if (args.driver?.payouts_enabled === false) {
    return {
      ok: false,
      code: "PAYOUT_RETRY_PAYOUTS_DISABLED",
      message: "Cannot retry: payouts_enabled is false for this driver destination.",
    };
  }

  const st = String(args.payoutItem.status ?? "").toLowerCase();
  if (st === "completed" || args.payoutItem.provider_payout_id || args.payoutItem.provider_payment_id) {
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

  const hasProviderEvidence = Boolean(
    args.payoutItem.provider_payment_id
      || args.payoutItem.provider_transfer_id
      || args.payoutItem.provider_payout_id,
  );
  const isLocalOnly = !hasProviderEvidence && ["failed", "ledger_sync_failed"].includes(st);
  if (isLocalOnly && !args.localOnlyApproved) {
    return { ok: false, code: PAYOUT_RETRY_LOCAL_ONLY_CODE, message: PAYOUT_RETRY_LOCAL_ONLY_MESSAGE };
  }

  if (args.platformAvailablePence != null) {
    if (args.platformAvailablePence < 0) {
      return {
        ok: false,
        code: PAYOUT_RETRY_INSUFFICIENT_FUNDS_CODE,
        message: PAYOUT_RETRY_INSUFFICIENT_FUNDS_MESSAGE,
      };
    }
    return assertRetryProviderBalance({
      requiredAmountPence: args.requiredAmountPence,
      platformAvailablePence: Math.max(0, args.platformAvailablePence),
    });
  }

  return { ok: true };
}
