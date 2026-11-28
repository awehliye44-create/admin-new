/** Offline test/audit-only helpers; not part of Edge uploads. */
import { WEEKLY_PAYOUT_BATCH_KINDS } from "../../../functions/_shared/payoutReconcileKindsSSOT.ts";


export function isWeeklyPayoutBatchKind(kind: string | null | undefined): boolean {
  return (WEEKLY_PAYOUT_BATCH_KINDS as readonly string[]).includes(String(kind ?? ""));
}

export * from "../../../functions/_shared/payoutReconcileKindsSSOT.ts";
