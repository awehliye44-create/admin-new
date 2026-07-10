/**
 * Driver wallet running balance SSOT — pure attach of balance-after from chronological ledger.
 * Callers must pass the driver's full (or prefix) ledger series ordered by created_at ASC.
 * Never invent balances from a filtered subset.
 */

export type LedgerAmountRow = {
  id: string;
  created_at: string;
  amount_pence: number;
};

export type LedgerAmountRowWithBalance<T extends LedgerAmountRow> = T & {
  running_balance_pence: number;
};

/** Attach running balance after each row. Input must be chronological ascending. */
export function attachDriverWalletRunningBalances<T extends LedgerAmountRow>(
  chronologicalAscending: T[],
  openingBalancePence = 0,
): Array<LedgerAmountRowWithBalance<T>> {
  let running = Math.round(openingBalancePence);
  return chronologicalAscending.map((row) => {
    running += Math.round(Number(row.amount_pence ?? 0));
    return { ...row, running_balance_pence: running };
  });
}

/**
 * Given newest-first rows (typical API order), compute balances using full ascending series
 * then restore newest-first order for display.
 */
export function attachRunningBalancesNewestFirst<T extends LedgerAmountRow>(
  newestFirst: T[],
  openingBalancePence = 0,
): Array<LedgerAmountRowWithBalance<T>> {
  const ascending = [...newestFirst].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const withBalances = attachDriverWalletRunningBalances(ascending, openingBalancePence);
  const byId = new Map(withBalances.map((r) => [r.id, r.running_balance_pence]));
  return newestFirst.map((row) => ({
    ...row,
    running_balance_pence: byId.get(row.id) ?? openingBalancePence,
  }));
}
