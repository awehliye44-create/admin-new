/** Offline test/audit-only helpers; not part of Edge uploads. */
import { PayableFareSnapshot } from "../../../functions/_shared/payableFareSnapshotSSOT.ts";


export function requiredAuthorisedTotalFromSnapshot(
  snapshot: PayableFareSnapshot,
): number {
  // Tips may be authorised with fare at completion; receivables included (composition-before-cover).
  return snapshot.total_payable_pence;
}

export * from "../../../functions/_shared/payableFareSnapshotSSOT.ts";
