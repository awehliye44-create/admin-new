/**
 * Driver entitlement ledger family — payout eligibility reads this SSOT.
 * Entry types in DB are unchanged; eligibility expands to terminal compensation types.
 */
import {
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  evaluateLedgerEntryEligibility,
  type LedgerEligibilityEvidence,
  type PayoutClearingPolicy,
} from "./driverPayoutEligibilitySSOT.ts";
import { resolveTerminalFeeDriverTenPence } from "./frDriverExpectedEntitlementSSOT.ts";

/** Balance-affecting driver entitlement credits (wallet → payout pipeline). */
export const DRIVER_ENTITLEMENT_LEDGER_TYPES = new Set([
  "TRIP_EARNING_NET",
  "DRIVER_COMPENSATION_CREDIT",
  "DRIVER_TIP_CREDIT",
  "TIP_CREDIT",
]);

/** Terminal-only compensation types — never duplicate TRIP_EARNING_NET on same trip. */
export const TERMINAL_COMPENSATION_LEDGER_TYPES = new Set([
  "DRIVER_COMPENSATION_CREDIT",
]);

export const CHARGED_CANCELLATION_LEDGER_TYPE = "TRIP_EARNING_NET";

export function isDriverEntitlementLedgerType(type: string | null | undefined): boolean {
  return DRIVER_ENTITLEMENT_LEDGER_TYPES.has(String(type ?? "").toUpperCase());
}

/** Duplicate guard: terminal compensation cannot coexist with TRIP_EARNING_NET on same trip. */
export function hasConflictingEntitlementTypes(types: string[]): boolean {
  const normalized = types.map((t) => String(t).toUpperCase());
  const hasTen = normalized.includes("TRIP_EARNING_NET");
  const hasComp = normalized.some((t) => TERMINAL_COMPENSATION_LEDGER_TYPES.has(t));
  return hasTen && hasComp;
}

export function evaluateDriverEntitlementLedgerEligibility(
  entry: LedgerEligibilityEvidence,
  policy?: PayoutClearingPolicy,
): ReturnType<typeof evaluateLedgerEntryEligibility> {
  const type = String(entry.ledger_type ?? "").toUpperCase();
  if (!isDriverEntitlementLedgerType(type)) {
    return { status: "UNKNOWN_ELIGIBILITY_ERROR" as const, payable_pence: 0 };
  }
  return evaluateLedgerEntryEligibility(entry, policy);
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
