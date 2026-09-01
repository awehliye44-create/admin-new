/**
 * Level 1 Driver Wallet Ledger fleet overview — active balances only.
 * Excludes lifetime credited / completed payout totals from active rollups.
 */

export type DriverWalletFleetOverviewInput = {
  available_for_payout_pence?: number | null;
  cashout_limit_pence?: number | null;
  pending_balance_pence?: number | null;
  wallet_status?: string | null;
  withdrawal_in_progress_pence?: number | null;
  included_in_payout_batch_amount_pence?: number | null;
  failed_payout_stuck_processing_pence?: number | null;
  period_kpis?: {
    pending_earnings_pence?: number | null;
  } | null;
};

export type DriverWalletFleetOverview = {
  total_drivers: number;
  total_pending_balance_pence: number;
  total_available_balance_pence: number;
  total_reserved_pence: number;
  total_processing_exception_pence: number;
  wallets_active: number;
  wallets_on_hold: number;
};

function isOnHold(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return s === 'FROZEN' || s === 'RESTRICTED' || s === 'ON_HOLD' || s === 'HOLD';
}

function reservedPence(row: DriverWalletFleetOverviewInput): number {
  return Math.max(
    0,
    Math.round(
      Number(
        row.withdrawal_in_progress_pence
          ?? row.included_in_payout_batch_amount_pence
          ?? 0,
      ),
    ),
  );
}

/** Aggregate active fleet overview cards from driver SSOT rows (backend or mirror). */
export function buildDriverWalletFleetOverview(
  rows: DriverWalletFleetOverviewInput[],
): DriverWalletFleetOverview {
  let pending = 0;
  let available = 0;
  let reserved = 0;
  let processingException = 0;
  let active = 0;
  let onHold = 0;

  for (const row of rows) {
    available += Math.round(
      Number(row.available_for_payout_pence ?? row.cashout_limit_pence ?? 0),
    );
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
    reserved += reservedPence(row);
    processingException += Math.max(
      0,
      Math.round(Number(row.failed_payout_stuck_processing_pence ?? 0)),
    );

    const status = String(row.wallet_status ?? '').toUpperCase();
    if (status === 'ACTIVE') active += 1;
    if (isOnHold(status)) onHold += 1;
  }

  return {
    total_drivers: rows.length,
    total_pending_balance_pence: pending,
    total_available_balance_pence: available,
    total_reserved_pence: reserved,
    total_processing_exception_pence: processingException,
    wallets_active: active,
    wallets_on_hold: onHold,
  };
}
