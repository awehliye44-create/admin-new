/**
 * Canonical driver wallet pending/available/live — DB RPC SSOT.
 * Use this for company-funds protected liabilities (not fetchDriverPayoutEligibility TS reimplementation).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type DriverWalletEligibilityBalancesRow = {
  live_balance_pence: number;
  available_balance_pence: number;
  pending_balance_pence: number;
  withdrawal_in_progress_pence: number;
  outstanding_debt_pence: number;
  eligible_earnings_pence: number;
};

function parseRpcRow(row: Record<string, unknown> | null | undefined): DriverWalletEligibilityBalancesRow {
  return {
    live_balance_pence: Math.round(Number(row?.live_balance_pence ?? 0)),
    available_balance_pence: Math.max(0, Math.round(Number(row?.available_balance_pence ?? 0))),
    pending_balance_pence: Math.max(0, Math.round(Number(row?.pending_balance_pence ?? 0))),
    withdrawal_in_progress_pence: Math.max(0, Math.round(Number(row?.withdrawal_in_progress_pence ?? 0))),
    outstanding_debt_pence: Math.max(0, Math.round(Number(row?.outstanding_debt_pence ?? 0))),
    eligible_earnings_pence: Math.max(0, Math.round(Number(row?.eligible_earnings_pence ?? 0))),
  };
}

export async function fetchDriverWalletEligibilityBalancesRpc(
  supabase: SupabaseClient,
  driver_id: string,
): Promise<DriverWalletEligibilityBalancesRow> {
  const { data, error } = await supabase.rpc("driver_wallet_eligibility_balances", {
    p_driver_id: driver_id,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return parseRpcRow(row as Record<string, unknown> | null | undefined);
}

export async function loadDriverWalletEligibilityBalancesBatchRpc(
  supabase: SupabaseClient,
  driverIds: readonly string[],
): Promise<Map<string, DriverWalletEligibilityBalancesRow>> {
  const out = new Map<string, DriverWalletEligibilityBalancesRow>();
  const batchSize = 8;
  for (let i = 0; i < driverIds.length; i += batchSize) {
    const batch = driverIds.slice(i, i + batchSize);
    await Promise.all(batch.map(async (driverId) => {
      try {
        out.set(driverId, await fetchDriverWalletEligibilityBalancesRpc(supabase, driverId));
      } catch {
        // omit — caller fail-closed when totals incomplete if needed
      }
    }));
  }
  return out;
}
