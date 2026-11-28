/** Offline test/audit-only helpers; not part of Edge uploads. */
import { upper, LEDGER_TYPE_TRIP_EARNING_NET, isInstantInHalfOpenRange } from "../../../functions/_shared/economicEarnedAtSSOT.ts";


export function sumAttributedTripEarningNetPence<
  T extends {
    type?: string | null;
    amount_pence?: number | null;
    economic_earned_at?: string | null;
  },
>(
  rows: T[],
  startIso: string,
  endIso: string,
): number {
  let sum = 0;
  for (const row of rows) {
    if (upper(row.type) !== LEDGER_TYPE_TRIP_EARNING_NET) continue;
    if (!isInstantInHalfOpenRange(row.economic_earned_at, startIso, endIso)) continue;
    const amount = Number(row.amount_pence ?? 0);
    if (!Number.isFinite(amount)) continue;
    sum += Math.round(amount);
  }
  return sum;
}

export * from "../../../functions/_shared/economicEarnedAtSSOT.ts";
