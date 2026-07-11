/**
 * Build Driver Wallet widget summary for a selected period (backend SSOT).
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchDriverWalletPayoutSnapshot } from "./fetchDriverWalletPayoutSnapshot.ts";
import { buildDriverWalletSummaryResponse } from "./driverWalletPeriodWidgetsSSOT.ts";
import type Stripe from "https://esm.sh/stripe@14.21.0";

export async function fetchDriverWalletSummary(
  supabase: SupabaseClient,
  args: {
    driverId: string;
    periodKey: string;
    periodFrom: string;
    periodTo: string;
    serviceAreaId?: string | null;
    timezone?: string | null;
    stripe?: Stripe | null;
  },
) {
  const detail = await fetchDriverWalletPayoutSnapshot(supabase, {
    driverId: args.driverId,
    stripe: args.stripe ?? null,
  });

  const { data: ledger } = await supabase
    .from("driver_wallet_ledger")
    .select("type, amount_pence, related_trip_id, created_at")
    .eq("driver_id", args.driverId)
    .gte("created_at", args.periodFrom)
    .lte("created_at", args.periodTo);

  // Trip commission snapshots for trips completed in period (canonical gross commission).
  const { data: trips } = await supabase
    .from("trips")
    .select("id, completed_at, commission_pence")
    .eq("driver_id", args.driverId)
    .gte("completed_at", args.periodFrom)
    .lte("completed_at", args.periodTo);

  const pending = Number(detail.period_kpis?.pending_earnings_pence ?? 0);
  const outstanding = Number(
    detail.debt_recovery?.remaining_debt_pence
      ?? detail.recovery_debt_pence
      ?? detail.period_kpis?.outstanding_debt_pence
      ?? 0,
  );

  return buildDriverWalletSummaryResponse({
    periodKey: args.periodKey,
    periodFrom: args.periodFrom,
    periodTo: args.periodTo,
    timezone: args.timezone ?? "Europe/London",
    account: {
      live_balance_pence: Number(detail.wallet_balance_pence ?? 0),
      available_balance_pence: Number(detail.cashout_limit_pence ?? 0),
      pending_balance_pence: pending,
      outstanding_debt_pence: outstanding,
      annual_driver_earnings_pence: Number(detail.period_kpis?.year_earnings_pence ?? 0),
    },
    ledger: (ledger ?? []).map((r) => ({
      type: r.type as string | null,
      amount_pence: r.amount_pence as number | null,
      related_trip_id: r.related_trip_id as string | null,
      created_at: r.created_at as string | null,
    })),
    tripCommissionSnapshots: (trips ?? []).map((t) => ({
      trip_id: t.id as string,
      completed_at: t.completed_at as string | null,
      commission_pence: t.commission_pence == null ? null : Number(t.commission_pence),
    })),
  });
}
