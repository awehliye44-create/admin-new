/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Driver entitlement ledger family — payout eligibility reads this SSOT.
 * Entry types in DB are unchanged; eligibility expands to terminal compensation types.
 */
import {
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  evaluateLedgerEntryEligibility,
  type LedgerEligibilityEvidence,
  type PayoutClearingPolicy,
} from "../../../functions/_shared/driverPayoutEligibilitySSOT.ts";

import { resolveTerminalFeeDriverTenPence } from "../../../functions/_shared/frDriverExpectedEntitlementSSOT.ts";
import { DRIVER_ENTITLEMENT_LEDGER_TYPES } from "../../../functions/_shared/driverEntitlementLedgerSSOT.ts";


export function isDriverEntitlementLedgerType(type: string | null | undefined): boolean {
  return DRIVER_ENTITLEMENT_LEDGER_TYPES.has(String(type ?? "").toUpperCase());
}


export const TERMINAL_FEE_LIFECYCLE_PROOF = {
  captured_pence: 400,
  provider_fee_pence: 24,
  commission_pence: 0,
  entitlement_pence: 376,
  clearing_delay_hours: DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
} as const;


/** Wallet credit amount for terminal fee outcome (capture − provider fee when commission 0). */
export function terminalFeeWalletCreditPence(args: {
  captured_pence: number;
  provider_fee_pence: number;
  commission_pence?: number;
}): number {
  return resolveTerminalFeeDriverTenPence(args);
}

export * from "../../../functions/_shared/driverEntitlementLedgerSSOT.ts";
