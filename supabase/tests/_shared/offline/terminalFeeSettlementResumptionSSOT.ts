/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Phase 0e — resume terminal/no-show wallet settlement when provider fee becomes known.
 * Idempotent: reuses postTerminalEntitlementFromSettlement; never posts gross capture.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import {
  computeTerminalOutcomeEntitlement,
  loadTerminalCaptureEvidence,
  postTerminalEntitlementFromSettlement,
  stampTerminalOutcomeTripRow,
  TERMINAL_FEE_LEDGER_TYPE,
  type TerminalOutcomeKind,
} from "../../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";

import { tripBlocksDriverWalletLedgerPosting } from "../../../functions/_shared/commissionWalletDeduction.ts";

import { FINANCIAL_MODEL, resolveFinancialModelStamp } from "../../../functions/_shared/financialModelScopeSSOT.ts";

import { loadPaymentSession, markPaymentSessionProviderFee } from "../../../functions/_shared/paymentSessionSSOT.ts";

import { resolveTerminalEntitledDriverId, resolveTerminalOutcomeKind } from "../../../functions/_shared/terminalOutcomeKindSSOT.ts";

import { isUnifiedTerminalFeePolicyActive } from "../../../functions/_shared/terminalFeePolicySSOT.ts";
import { TerminalTripRow } from "../../../functions/_shared/terminalFeeSettlementResumptionSSOT.ts";


export function isTerminalFeeTrip(trip: TerminalTripRow): boolean {
  return resolveTerminalOutcomeKind(trip) != null;
}

export * from "../../../functions/_shared/terminalFeeSettlementResumptionSSOT.ts";
