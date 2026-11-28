/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Payout Ledger handoff SSOT (pure).
 *
 * PL consumes DWL available_balance_pence and eligible ledger entry IDs only.
 * Never recalculates earnings; never allocates non-eligible wallet rows.
 */

import { assertAllocationEqualsAmount } from "../../../functions/_shared/payoutAllocationEligibilitySSOT.ts";


/** UI / API label — avoid provider-only "Connected Account" wording. */
export function payoutDestinationLabel(args: {
  provider?: string | null;
  connected_account_id?: string | null;
  manual_bank?: boolean;
}): string {
  const provider = String(args.provider ?? "").trim().toLowerCase();
  if (args.manual_bank || provider === "revolut") {
    return args.connected_account_id
      ? `Manual bank · ${String(args.connected_account_id).slice(0, 12)}`
      : "Manual bank";
  }
  if (args.connected_account_id) {
    return String(args.connected_account_id);
  }
  return "Not set";
}

export * from "../../../functions/_shared/payoutLedgerHandoffSSOT.ts";
