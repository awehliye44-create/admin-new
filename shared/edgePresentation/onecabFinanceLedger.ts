/** Admin presentation-only helpers; not part of Edge uploads. */
// @ts-nocheck
/**
 * ONECAB finance ledger SSOT — shared calculations and capture/settlement helpers.
 * Financial Reconciliation consumes these formulas; ledger is source of truth.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import { tripBlocksDriverWalletLedgerPosting } from "../../supabase/functions/_shared/commissionWalletDeduction.ts";

import { FINANCIAL_MODEL_VIOLATION } from "../../supabase/functions/_shared/commissionWalletSSOT.ts";

import { readTripEarningNetLedgerState } from "../../supabase/functions/_shared/tripEarningNetLedgerReadback.ts";

import {
  PENDING_ENTITLEMENT_BALANCE_EXCLUDED_TYPES,
  releaseTripEarningPendingIfPresent,
} from "../../supabase/functions/_shared/tripEarningPendingSSOT.ts";
import { BALANCE_EXCLUDED_LEDGER_TYPES, LedgerRow, computeCashCommissionOutstanding, PayoutEligibilityInput, PayoutEligibility } from "../../supabase/functions/_shared/onecabFinanceLedger.ts";


/** Reporting-only types excluded from wallet balance (Phase 3A.4). COMMISSION_RECOVERED is included in wallet. */
export const REPORTING_ONLY_LEDGER_TYPES = new Set<string>(BALANCE_EXCLUDED_LEDGER_TYPES);


export function isCardCaptureFailed(args: {
  tripPaymentStatus?: string | null;
  paymentStatus?: string | null;
}): boolean {
  const pay = String(args.paymentStatus ?? "").toLowerCase();
  if (pay === "capture_failed") return true;
  return String(args.tripPaymentStatus ?? "").toLowerCase() === "capture_failed";
}


export function sumLedgerPositive(
  ledger: LedgerRow[],
  type: string,
): number {
  return ledger
    .filter((r) => r.type === type)
    .reduce((s, r) => s + Math.max(0, r.amount_pence ?? 0), 0);
}


export function computeOwedToOnecab(ledger: LedgerRow[]): number {
  return computeCashCommissionOutstanding(ledger);
}


export function derivePayoutEligibility(driver: PayoutEligibilityInput): PayoutEligibility {
  const providerConnected = Boolean(driver.provider_account_id)
    && (driver.onboarding_complete ?? false);
  const requirementsDue = driver.requirements_currently_due ?? [];
  const payoutEligible = providerConnected
    && (driver.payouts_enabled ?? false)
    && (driver.external_account_exists ?? true)
    && requirementsDue.length === 0;

  let settlementStatus: PayoutEligibility["settlement_status"] = "not_connected";
  if (providerConnected && payoutEligible) settlementStatus = "eligible";
  else if (providerConnected) settlementStatus = "needs_attention";

  return {
    provider_connected: providerConnected,
    payout_eligible: payoutEligible,
    settlement_status: settlementStatus,
  };
}

export * from "../../supabase/functions/_shared/onecabFinanceLedger.ts";
