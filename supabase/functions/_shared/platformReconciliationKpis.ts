import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type Stripe from "https://esm.sh/stripe@14.21.0";
import { fetchDriverWalletPayoutSnapshot } from "./fetchDriverWalletPayoutSnapshot.ts";
import { isLondonSameCalendarDay } from "./financeLondonDay.ts";

export type PlatformReconciliationKpis = {
  balanced_drivers: number;
  drivers_with_recovery: number;
  outstanding_liability_pence: number;
  outstanding_recovery_pence: number;
  failed_payouts_pence: number;
  stripe_only_records: number;
  ledger_only_records: number;
  todays_captures_pence: number;
  todays_card_trips: number;
  driver_count: number;
};

type AuditTripRow = {
  date: string | null;
  payment_method: string | null;
  captured_pence: number;
};

const KPI_DRIVER_PAGE = 50;
const KPI_MAX_DRIVERS = 200;

export function aggregatePlatformKpisFromDriverSnapshots(
  drivers: Array<{
    reconciliation_status: string;
    recovery_debt_pence: number;
    wallet_balance_pence: number;
    local_only_failed_payout_pence: number;
  }>,
  auditRows: AuditTripRow[],
): PlatformReconciliationKpis {
  let balancedDrivers = 0;
  let driversWithRecovery = 0;
  let outstandingLiability = 0;
  let outstandingRecovery = 0;
  let failedPayouts = 0;
  let stripeOnly = 0;
  let ledgerOnly = 0;

  for (const d of drivers) {
    const status = String(d.reconciliation_status ?? "").toUpperCase();
    if (status === "BALANCED") balancedDrivers += 1;
    if (status === "STRIPE_ONLY") stripeOnly += 1;
    if (status === "LOCAL_ONLY") ledgerOnly += 1;
    if ((d.recovery_debt_pence ?? 0) > 0) driversWithRecovery += 1;
    outstandingLiability += Math.max(0, d.wallet_balance_pence ?? 0);
    outstandingRecovery += Math.max(0, d.recovery_debt_pence ?? 0);
    failedPayouts += Math.max(0, d.local_only_failed_payout_pence ?? 0);
  }

  let todaysCaptures = 0;
  let todaysCardTrips = 0;
  for (const row of auditRows) {
    if (!isLondonSameCalendarDay(row.date)) continue;
    const method = String(row.payment_method ?? "").toLowerCase();
    todaysCardTrips += 1;
    todaysCaptures += Math.max(0, row.captured_pence ?? 0);
  }

  return {
    balanced_drivers: balancedDrivers,
    drivers_with_recovery: driversWithRecovery,
    outstanding_liability_pence: outstandingLiability,
    outstanding_recovery_pence: outstandingRecovery,
    failed_payouts_pence: failedPayouts,
    stripe_only_records: stripeOnly,
    ledger_only_records: ledgerOnly,
    todays_captures_pence: todaysCaptures,
    todays_card_trips: todaysCardTrips,
    driver_count: drivers.length,
  };
}

export async function fetchRegionPlatformKpis(
  supabase: SupabaseClient,
  args: {
    regionId: string | null;
    stripe: Stripe | null;
    todayAuditRows: AuditTripRow[];
  },
): Promise<PlatformReconciliationKpis> {
  let driversQuery = supabase
    .from("drivers")
    .select("id")
    .not("stripe_account_id", "is", null)
    .order("driver_code", { ascending: true })
    .limit(KPI_MAX_DRIVERS);

  if (args.regionId) driversQuery = driversQuery.eq("region_id", args.regionId);

  const { data: driverRows, error } = await driversQuery;
  if (error) throw error;

  const snapshots = [];
  for (const row of driverRows ?? []) {
    snapshots.push(await fetchDriverWalletPayoutSnapshot(supabase, {
      driverId: row.id as string,
      stripe: args.stripe,
    }));
  }

  return aggregatePlatformKpisFromDriverSnapshots(snapshots, args.todayAuditRows);
}
