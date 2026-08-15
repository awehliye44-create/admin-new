/**
 * Driver Wallet Ledger list/detail display balances.
 * Pending / Available come from eligibility SSOT — never live − reservation,
 * never period-KPI pending as the primary field, never a provider-API second wallet.
 */

export type DriverWalletSsotBalanceSource = {
  wallet_balance_pence?: number | null;
  available_for_payout_pence?: number | null;
  cashout_limit_pence?: number | null;
  pending_balance_pence?: number | null;
  withdrawal_in_progress_pence?: number | null;
  period_kpis?: { pending_earnings_pence?: number | null } | null;
};

export type DriverWalletSsotDisplayBalances = {
  livePence: number;
  availablePence: number;
  pendingPence: number;
  withdrawalInProgressPence: number;
};

function minor(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : null;
}

export function displayDriverWalletSsotBalances(
  row: DriverWalletSsotBalanceSource,
): DriverWalletSsotDisplayBalances {
  return {
    livePence: minor(row.wallet_balance_pence) ?? 0,
    availablePence:
      minor(row.available_for_payout_pence) ?? minor(row.cashout_limit_pence) ?? 0,
    pendingPence:
      minor(row.pending_balance_pence)
      ?? minor(row.period_kpis?.pending_earnings_pence)
      ?? 0,
    withdrawalInProgressPence: Math.max(0, minor(row.withdrawal_in_progress_pence) ?? 0),
  };
}

export type DriverWalletEligibilityOverlay = {
  driver_id: string;
  live_balance_pence?: number | null;
  available_balance_pence?: number | null;
  pending_balance_pence?: number | null;
  withdrawal_in_progress_pence?: number | null;
};

export function mergeDriverWalletEligibilityOverlay<T extends DriverWalletSsotBalanceSource & { driver_id: string }>(
  row: T,
  overlay: DriverWalletEligibilityOverlay | null | undefined,
): T {
  if (!overlay) return row;
  const available = minor(overlay.available_balance_pence);
  const pending = minor(overlay.pending_balance_pence);
  const withdrawal = minor(overlay.withdrawal_in_progress_pence);
  return {
    ...row,
    ...(available != null
      ? { available_for_payout_pence: available, cashout_limit_pence: available }
      : {}),
    ...(pending != null ? { pending_balance_pence: pending } : {}),
    ...(withdrawal != null ? { withdrawal_in_progress_pence: withdrawal } : {}),
    ...(minor(overlay.live_balance_pence) != null
      ? { wallet_balance_pence: minor(overlay.live_balance_pence) }
      : {}),
    period_kpis: row.period_kpis
      ? {
          ...row.period_kpis,
          ...(pending != null ? { pending_earnings_pence: pending } : {}),
        }
      : row.period_kpis,
  };
}
