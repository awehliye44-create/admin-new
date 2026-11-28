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

/** Duplicate guard: terminal compensation cannot coexist with TRIP_EARNING_NET on same trip. */
export function hasConflictingEntitlementTypes(types: string[]): boolean {
  const normalized = types.map((t) => String(t).toUpperCase());
  const hasTen = normalized.includes("TRIP_EARNING_NET");
  const hasComp = normalized.some((t) => TERMINAL_COMPENSATION_LEDGER_TYPES.has(t));
  return hasTen && hasComp;
}
