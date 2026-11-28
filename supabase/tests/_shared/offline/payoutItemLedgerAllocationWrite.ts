/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Persist and assert payout_item_ledger_allocations before bank transfer.
 * Amount comes from eligibility-proven DWL entries — never trip totals.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import { assertAllocationEqualsAmount } from "../../../functions/_shared/payoutAllocationEligibilitySSOT.ts";

import type { PlannedLedgerAllocation } from "../../../functions/_shared/payoutLedgerHandoffSSOT.ts";

export const PAYOUT_LINEAGE_MISMATCH = "PAYOUT_LINEAGE_MISMATCH" as const;

export * from "../../../functions/_shared/payoutItemLedgerAllocationWrite.ts";
