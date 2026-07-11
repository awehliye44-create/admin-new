/**
 * Driver Wallet Ledger — debt recovery summary from ledger types only.
 * Does not invent debt from trips or payment sessions.
 */

export type DriverWalletDebtRecoveryKpis = {
  /** Lifetime debt created (CASH_COMMISSION_DEBT), or recovered+remaining when open. */
  outstanding_debt_pence: number;
  recovered_amount_pence: number;
  /** Current open debt from ledger SSOT. */
  remaining_debt_pence: number;
  recovery_percent: number | null;
};

const DEBT_CREATED_TYPES = new Set(["CASH_COMMISSION_DEBT"]);
const DEBT_RECOVERED_TYPES = new Set(["DEBT_RECOVERY", "COMMISSION_RECOVERED"]);

export function buildDriverWalletDebtRecoveryKpis(
  ledger: Array<{ type?: string | null; amount_pence?: number | null }>,
  remainingDebtPence: number,
): DriverWalletDebtRecoveryKpis {
  let recovered = 0;
  let created = 0;
  for (const row of ledger) {
    const type = String(row.type ?? "").toUpperCase();
    const amount = Number(row.amount_pence ?? 0);
    if (DEBT_CREATED_TYPES.has(type)) created += Math.abs(amount);
    if (DEBT_RECOVERED_TYPES.has(type)) recovered += Math.abs(amount);
  }

  const remaining = Math.max(0, Number(remainingDebtPence ?? 0));
  // Outstanding = total obligation base: prefer lifetime created; fall back to recovered+remaining.
  const outstanding = created > 0 ? created : recovered + remaining;
  const recoveryPercent = outstanding > 0
    ? Math.round((recovered / outstanding) * 1000) / 10
    : null;

  return {
    outstanding_debt_pence: outstanding,
    recovered_amount_pence: recovered,
    remaining_debt_pence: remaining,
    recovery_percent: recoveryPercent,
  };
}
