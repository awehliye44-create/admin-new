/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Manual provider payout SSOT — Revolut Business bank transfer confirmed by admin.
 * No Merchant/Business API payout retrieve on mark-paid; ledger debit only after reference.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";


/** Wallet-ledger eligibility for manual provider payouts (no provider Connect allocation). */
export function manualProviderEligiblePence(args: {
  walletUnpaidPence: number;
  inFlightPayoutPence?: number;
  payoutBlocked?: boolean;
}): number {
  if (args.payoutBlocked) return 0;
  const wallet = Math.max(0, args.walletUnpaidPence);
  const inFlight = Math.max(0, args.inFlightPayoutPence ?? 0);
  return Math.max(0, wallet - inFlight);
}

export * from "../../../functions/_shared/manualProviderPayoutSSOT.ts";
