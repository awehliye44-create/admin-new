/**
 * Early cash-out financial invariant (mirrors migration 20261216140000).
 *
 *   gross wallet consumption = net Revolut transfer + ONECAB cash-out fee
 *
 * The fee is ONECAB revenue (CASHOUT_FEE ledger row). It is never a driver
 * balance, pending payout, hold or entitlement.
 */

export const FAIL_SUBMITTED_EARLY_CASHOUT_RPC = "fail_submitted_early_cashout";

/** Must match the state list in public.fail_submitted_early_cashout. */
export const EARLY_CASHOUT_PROVIDER_TERMINAL_FAILURE_STATES = [
  "failed",
  "declined",
  "rejected",
  "reverted",
  "cancelled",
  "canceled",
  "revoked",
] as const;

export function isEarlyCashoutProviderTerminalFailure(state: string | null | undefined): boolean {
  const s = String(state ?? "").trim().toLowerCase();
  return (EARLY_CASHOUT_PROVIDER_TERMINAL_FAILURE_STATES as readonly string[]).includes(s);
}

export function earlyCashoutAmountsBalance(args: {
  gross_pence: number;
  net_pence: number;
  fee_pence: number;
}): boolean {
  const gross = Number(args.gross_pence);
  const net = Number(args.net_pence);
  const fee = Number(args.fee_pence);
  if (![gross, net, fee].every(Number.isInteger)) return false;
  return fee >= 0 && net > 0 && gross === net + fee;
}
