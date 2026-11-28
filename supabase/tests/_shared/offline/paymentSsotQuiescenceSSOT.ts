/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Mixed-version / rollback quiescence for Payment SSOT (#92B).
 *
 * Stage D strict enforcement must not activate while incompatible (pre-fence)
 * workers remain the only capture path — operational gate.
 * Edge rollback to 871c73ac must wait until no provider POSTs are inflight.
 * Never drop payment_financial_operations / snapshots / events in production.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { InflightFinancialOpSummary, decideEdgeRollbackSafety } from "../../../functions/_shared/paymentSsotQuiescenceSSOT.ts";


/**
 * Stage D may enable only when operators confirm all Edge workers are fence-aware
 * AND no inflight posts remain (rolling deploy complete).
 */
export function decideStageDEnablement(args: {
  allWorkersFenceAware: boolean;
  inflight: InflightFinancialOpSummary;
}): { ok: true } | { ok: false; reason: string } {
  if (!args.allWorkersFenceAware) {
    return {
      ok: false,
      reason: "incompatible_workers_still_active; keep stage<=C until 100% fence-aware Edge",
    };
  }
  const quiet = decideEdgeRollbackSafety(args.inflight);
  if (!quiet.ok) return quiet;
  return { ok: true };
}

export * from "../../../functions/_shared/paymentSsotQuiescenceSSOT.ts";
