/** Offline test/audit-only helpers; not part of Edge uploads. */
import {
  invokeAutomatedPayoutCompletion,
  invokeManualExternalPayoutCompletion,
} from "../../../functions/_shared/payoutCompletionRpcSSOT.ts";

import { redactCompletionEvidence } from "../../../functions/_shared/driverPayoutCompletionSSOT.ts";

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { PayoutLedgerType } from "../../../functions/_shared/payoutLedgerSync.ts";


export function ledgerTypeForBatchKind(kind: string): PayoutLedgerType {
  if (kind === "EARLY_CASHOUT") return "EARLY_CASHOUT";
  if (kind === "WEEKLY_MONDAY") return "WEEKLY_PAYOUT";
  if (kind === "MANUAL_ADMIN" || kind === "CONNECT_MANUAL") return "MANUAL_PAYOUT";
  return "PAYOUT";
}


export function payoutDescriptionForType(type: PayoutLedgerType): string {
  if (type === "WEEKLY_PAYOUT") return "Weekly payout to bank";
  if (type === "MANUAL_PAYOUT") return "Manual payout to bank";
  if (type === "EARLY_CASHOUT") return "Withdrawal";
  return "Payout to bank";
}

export * from "../../../functions/_shared/payoutLedgerSync.ts";
