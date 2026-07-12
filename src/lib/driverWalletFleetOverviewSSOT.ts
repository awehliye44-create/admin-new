/**
 * Level 1 Driver Wallet Ledger fleet overview — roll up SSOT driver rows only.
 * Does not invent balances from trips or Payment Sessions.
 */

export type DriverWalletFleetOverviewInput = {
  wallet_balance_pence?: number | null;
  cashout_limit_pence?: number | null;
  /** Canonical eligibility pending (live − available) — preferred over period KPI. */
  pending_balance_pence?: number | null;
  wallet_status?: string | null;
  recovery_debt_pence?: number | null;
  debt_recovery?: {
    remaining_debt_pence?: number | null;
    outstanding_debt_pence?: number | null;
  } | null;
  period_kpis?: {
    pending_earnings_pence?: number | null;
    outstanding_debt_pence?: number | null;
  } | null;
};

export type DriverWalletFleetOverview = {
  total_drivers: number;
  total_live_balance_pence: number;
  total_available_balance_pence: number;
  total_pending_balance_pence: number;
  total_outstanding_debt_pence: number;
  wallets_active: number;
  wallets_on_hold: number;
  negative_wallets: number;
};

function outstandingDebtPence(row: DriverWalletFleetOverviewInput): number {
  return Math.max(
    0,
    Math.round(
      Number(
        row.debt_recovery?.remaining_debt_pence
          ?? row.debt_recovery?.outstanding_debt_pence
          ?? row.recovery_debt_pence
          ?? row.period_kpis?.outstanding_debt_pence
          ?? 0,
      ),
    ),
  );
}

function isOnHold(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return s === 'FROZEN' || s === 'RESTRICTED' || s === 'ON_HOLD' || s === 'HOLD';
}

/** Aggregate fleet overview cards from driver SSOT rows (backend or mirror). */
export function buildDriverWalletFleetOverview(
  rows: DriverWalletFleetOverviewInput[],
): DriverWalletFleetOverview {
  let live = 0;
  let available = 0;
  let pending = 0;
  let debt = 0;
  let active = 0;
  let onHold = 0;
  let negative = 0;

  for (const row of rows) {
    const balance = Math.round(Number(row.wallet_balance_pence ?? 0));
    live += balance;
    available += Math.round(Number(row.cashout_limit_pence ?? 0));
    pending += Math.max(
      0,
      Math.round(
        Number(
          row.pending_balance_pence
            ?? row.period_kpis?.pending_earnings_pence
            ?? 0,
        ),
      ),
    );
    debt += outstandingDebtPence(row);

    const status = String(row.wallet_status ?? '').toUpperCase();
    if (status === 'ACTIVE') active += 1;
    if (isOnHold(status)) onHold += 1;
    if (balance < 0) negative += 1;
  }

  return {
    total_drivers: rows.length,
    total_live_balance_pence: live,
    total_available_balance_pence: available,
    total_pending_balance_pence: pending,
    total_outstanding_debt_pence: debt,
    wallets_active: active,
    wallets_on_hold: onHold,
    negative_wallets: negative,
  };
}
