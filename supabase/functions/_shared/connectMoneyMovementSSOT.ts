// @ts-nocheck
/**
 * Stripe Connect money movement visibility — mirrors Stripe Dashboard Connect account views.
 * Links live Connect balances/payouts to driver_wallet_ledger SSOT.
 */
import type Stripe from "https://esm.sh/stripe@14.21.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  computeCashCommissionOutstanding,
  computeLedgerWalletBalancePence,
  type LedgerRow,
} from "./onecabFinanceLedger.ts";
import {
  listInFlightConnectPayouts,
  readConnectPayoutSnapshot,
} from "./connectPayoutLockdown.ts";

export const MONEY_MOVEMENT_SSOT_VERSION = "connect_money_movement_ssot_v2";

export type MoneyMovementReconciliationStatus =
  | "pending_stripe_confirmation"
  | "matched"
  | "mismatch"
  | "refunded_reversed"
  | "paid_out";

export type StripeConnectPayoutRow = {
  connected_account_id: string;
  driver_id: string;
  driver_name: string;
  driver_code: string | null;
  stripe_live_balance_pence: number;
  future_payout_pence: number;
  in_transit_to_bank_pence: number;
  lifetime_volume_pence: number;
  payout_id: string;
  payout_amount_pence: number;
  payout_status: string;
  payout_initiated_at: string | null;
  estimated_arrival_at: string | null;
  external_bank_last4: string | null;
  payout_method: string;
  statement_descriptor: string | null;
  last_synced_at: string;
  expected_ledger_pence: number | null;
  actual_stripe_pence: number;
  difference_pence: number;
  reconciliation_status: MoneyMovementReconciliationStatus;
  ledger_entry_ids: string[];
  ledger_linked: boolean;
  duplicate_connect_account: boolean;
  duplicate_connect_group_key: string | null;
};

export type StripeConnectAccountSummaryRow = {
  connected_account_id: string;
  driver_id: string;
  driver_name: string;
  driver_code: string | null;
  stripe_live_balance_pence: number;
  future_payout_pence: number;
  in_transit_to_bank_pence: number;
  lifetime_volume_pence: number;
  last_synced_at: string;
  duplicate_connect_account: boolean;
  duplicate_connect_group_key: string | null;
  expected_wallet_balance_pence: number;
  actual_stripe_balance_pence: number;
  difference_pence: number;
  recovery_debt_pence: number;
  net_payable_after_recovery_pence: number;
  reconciliation_status: MoneyMovementReconciliationStatus;
  currency_code: string;
};

export type ConnectTransferRow = {
  transfer_id: string;
  connected_account_id: string;
  driver_id: string;
  driver_name: string;
  amount_pence: number;
  trip_id: string | null;
  created_at: string | null;
  reconciliation_status: MoneyMovementReconciliationStatus;
};

export type ConnectCollectedFeeRow = {
  connected_account_id: string;
  driver_id: string;
  driver_name: string;
  application_fee_id: string | null;
  charge_id: string | null;
  trip_id: string | null;
  amount_pence: number;
  created_at: string | null;
};

export type ConnectRecoveryDebtRow = {
  driver_id: string;
  driver_name: string;
  connected_account_id: string | null;
  recovery_debt_pence: number;
  ledger_types: string[];
  reduces_net_payable: boolean;
  note: string;
};

export type ConnectMoneyMovementMismatchRow = {
  kind: "payout" | "account_balance" | "duplicate_connect" | "trip_capture";
  driver_id: string | null;
  driver_name: string | null;
  connected_account_id: string | null;
  reference_id: string | null;
  expected_pence: number | null;
  actual_pence: number | null;
  difference_pence: number;
  status: MoneyMovementReconciliationStatus;
  message: string;
};

export type ConnectMoneyMovementBundle = {
  version: string;
  last_synced_at: string;
  connect_accounts: StripeConnectAccountSummaryRow[];
  payouts: StripeConnectPayoutRow[];
  transfers: ConnectTransferRow[];
  collected_fees: ConnectCollectedFeeRow[];
  recovery_debt: ConnectRecoveryDebtRow[];
  mismatches: ConnectMoneyMovementMismatchRow[];
  duplicate_connect_groups: Array<{
    group_key: string;
    driver_ids: string[];
    connected_account_ids: string[];
    driver_names: string[];
  }>;
};

const PAYOUT_LEDGER_TYPES = new Set([
  "PAYOUT",
  "WEEKLY_PAYOUT",
  "EARLY_CASHOUT",
  "MANUAL_PAYOUT",
]);

function sumLedgerWalletByDriver(
  rows: Array<{ driver_id: string; type: string; amount_pence: number }>,
): Map<string, number> {
  const byDriver = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const list = byDriver.get(row.driver_id) ?? [];
    list.push({ type: String(row.type), amount_pence: Number(row.amount_pence ?? 0) });
    byDriver.set(row.driver_id, list);
  }
  const wallets = new Map<string, number>();
  for (const [driverId, ledger] of byDriver) {
    wallets.set(driverId, computeLedgerWalletBalancePence(ledger));
  }
  return wallets;
}

function sumRecoveryDebtSsotByDriver(
  rows: Array<{ driver_id: string; type: string; amount_pence: number }>,
): Map<string, number> {
  const byDriver = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const list = byDriver.get(row.driver_id) ?? [];
    list.push({ type: String(row.type), amount_pence: Number(row.amount_pence ?? 0) });
    byDriver.set(row.driver_id, list);
  }
  const debt = new Map<string, number>();
  for (const [driverId, ledger] of byDriver) {
    debt.set(driverId, computeCashCommissionOutstanding(ledger));
  }
  return debt;
}

function driverDisplayName(row: {
  first_name?: string | null;
  last_name?: string | null;
  driver_code?: string | null;
  id: string;
}): string {
  const name = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
  return name || row.driver_code || row.id.slice(0, 8);
}

function normalizeGroupKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function payoutMethodLabel(payout: Stripe.Payout): string {
  if (payout.method === "instant") return "Instant";
  if (payout.type === "bank_account") return "Standard";
  return String(payout.method ?? payout.type ?? "standard");
}

export function connectBalanceMismatchMessage(
  onecabLiabilityPence: number,
  stripeAvailablePence: number,
): string {
  const diff = stripeAvailablePence - onecabLiabilityPence;
  if (diff > 100) {
    return "Stripe physical cash exceeds ONECAB liability (separate buckets — Connect may hold settled earnings not yet reflected on ledger).";
  }
  if (diff < -100) {
    return "ONECAB ledger liability exceeds Stripe Connect available (separate buckets — ledger may include entitlements not yet on Connect).";
  }
  return "ONECAB ledger liability and Stripe Connect available are aligned within tolerance.";
}

function classifyPayoutMatch(args: {
  payoutStatus: string;
  payoutAmountPence: number;
  ledgerSumPence: number;
  ledgerLinked: boolean;
}): MoneyMovementReconciliationStatus {
  const status = args.payoutStatus.toLowerCase();
  if (status === "failed" || status === "canceled") return "mismatch";
  if (status === "paid") {
    if (!args.ledgerLinked) return "paid_out";
    const diff = Math.abs(args.payoutAmountPence - args.ledgerSumPence);
    return diff <= 1 ? "matched" : "mismatch";
  }
  if (status === "pending" || status === "in_transit") {
    return args.ledgerLinked ? "matched" : "pending_stripe_confirmation";
  }
  return "pending_stripe_confirmation";
}

export function detectDuplicateConnectAccountGroups(
  drivers: Array<{
    id: string;
    first_name?: string | null;
    last_name?: string | null;
    driver_code?: string | null;
    stripe_account_id?: string | null;
    user_id?: string | null;
  }>,
): {
  duplicateByDriverId: Map<string, boolean>;
  duplicateGroupKeyByDriverId: Map<string, string>;
  groups: ConnectMoneyMovementBundle["duplicate_connect_groups"];
} {
  const byUser = new Map<string, typeof drivers>();
  const byName = new Map<string, typeof drivers>();

  for (const d of drivers) {
    if (d.user_id) {
      const list = byUser.get(d.user_id) ?? [];
      list.push(d);
      byUser.set(d.user_id, list);
    }
    const nameKey = normalizeGroupKey(driverDisplayName(d));
    if (nameKey) {
      const list = byName.get(nameKey) ?? [];
      list.push(d);
      byName.set(nameKey, list);
    }
  }

  const duplicateByDriverId = new Map<string, boolean>();
  const duplicateGroupKeyByDriverId = new Map<string, string>();
  const groups: ConnectMoneyMovementBundle["duplicate_connect_groups"] = [];

  const addGroup = (groupKey: string, members: typeof drivers) => {
    const acctIds = [...new Set(members.map((m) => m.stripe_account_id).filter(Boolean))] as string[];
    if (members.length <= 1 || acctIds.length <= 1) return;
    groups.push({
      group_key: groupKey,
      driver_ids: members.map((m) => m.id),
      connected_account_ids: acctIds,
      driver_names: members.map((m) => driverDisplayName(m)),
    });
    for (const m of members) {
      duplicateByDriverId.set(m.id, true);
      duplicateGroupKeyByDriverId.set(m.id, groupKey);
    }
  };

  for (const [userId, members] of byUser) {
    addGroup(`user:${userId}`, members);
  }
  for (const [nameKey, members] of byName) {
    addGroup(`name:${nameKey}`, members);
  }

  return { duplicateByDriverId, duplicateGroupKeyByDriverId, groups };
}

async function sumLifetimeVolumePence(
  supabase: SupabaseClient,
  driverId: string,
): Promise<number> {
  const { data: trips } = await supabase
    .from("trips")
    .select("capture_amount_pence, payment_method, payment_status")
    .eq("driver_id", driverId)
    .in("payment_status", ["captured", "paid", "succeeded"]);

  return (trips ?? [])
    .filter((t) => String(t.payment_method ?? "").toLowerCase() !== "cash")
    .reduce((s, t) => s + Math.max(0, Number(t.capture_amount_pence ?? 0)), 0);
}

export async function fetchConnectMoneyMovementBundle(args: {
  supabase: SupabaseClient;
  stripe: Stripe;
  currency?: string;
  regionId?: string | null;
  serviceAreaId?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  driverId?: string | null;
  payoutLimitPerAccount?: number;
}): Promise<ConnectMoneyMovementBundle> {
  const syncedAt = new Date().toISOString();
  const currency = (args.currency ?? "gbp").toLowerCase();
  const payoutLimit = args.payoutLimitPerAccount ?? 25;

  let driverQuery = args.supabase
    .from("drivers")
    .select("id, driver_code, first_name, last_name, stripe_account_id, region_id, user_id, service_area_id")
    .not("stripe_account_id", "is", null);

  if (args.driverId) driverQuery = driverQuery.eq("id", args.driverId);
  if (args.regionId) driverQuery = driverQuery.eq("region_id", args.regionId);
  if (args.serviceAreaId) driverQuery = driverQuery.eq("service_area_id", args.serviceAreaId);

  const { data: drivers, error: driversError } = await driverQuery;
  if (driversError) throw driversError;

  const driverList = drivers ?? [];
  const driverIds = driverList.map((d) => d.id);

  const regionIds = [...new Set(
    driverList.map((d) => d.region_id).filter((id): id is string => Boolean(id)),
  )];
  const { data: driverRegions } = regionIds.length > 0
    ? await args.supabase.from("regions").select("id, currency_code").in("id", regionIds)
    : { data: [] as Array<{ id: string; currency_code: string }> };
  const regionCurrencyById = new Map(
    (driverRegions ?? []).map((r) => [r.id, String(r.currency_code).toUpperCase()]),
  );

  const { duplicateByDriverId, duplicateGroupKeyByDriverId, groups } =
    detectDuplicateConnectAccountGroups(driverList);

  const { data: ledgerRows } = driverIds.length > 0
    ? await args.supabase
      .from("driver_wallet_ledger")
      .select("id, driver_id, type, amount_pence, stripe_payout_id, stripe_transfer_id, related_trip_id, created_at")
      .in("driver_id", driverIds)
    : { data: [] as Array<Record<string, unknown>> };

  const ledgerByPayoutId = new Map<string, Array<{ id: string; amount_pence: number }>>();
  const walletByDriver = sumLedgerWalletByDriver(
    (ledgerRows ?? []).map((r) => ({
      driver_id: String(r.driver_id),
      type: String(r.type),
      amount_pence: Number(r.amount_pence ?? 0),
    })),
  );
  const recoveryByDriver = sumRecoveryDebtSsotByDriver(
    (ledgerRows ?? []).map((r) => ({
      driver_id: String(r.driver_id),
      type: String(r.type),
      amount_pence: Number(r.amount_pence ?? 0),
    })),
  );

  for (const row of ledgerRows ?? []) {
    if (row.stripe_payout_id) {
      const driverId = String(row.driver_id);
      const list = ledgerByPayoutId.get(row.stripe_payout_id) ?? [];
      list.push({ id: String(row.id), amount_pence: Number(row.amount_pence ?? 0) });
      ledgerByPayoutId.set(row.stripe_payout_id, list);
    }
  }

  const connect_accounts: StripeConnectAccountSummaryRow[] = [];
  const payouts: StripeConnectPayoutRow[] = [];
  const transfers: ConnectTransferRow[] = [];
  const collected_fees: ConnectCollectedFeeRow[] = [];
  const recovery_debt: ConnectRecoveryDebtRow[] = [];
  const mismatches: ConnectMoneyMovementMismatchRow[] = [];

  for (const group of groups) {
    mismatches.push({
      kind: "duplicate_connect",
      driver_id: group.driver_ids[0] ?? null,
      driver_name: group.driver_names.join(" / "),
      connected_account_id: group.connected_account_ids[0] ?? null,
      reference_id: group.group_key,
      expected_pence: 1,
      actual_pence: group.connected_account_ids.length,
      difference_pence: group.connected_account_ids.length - 1,
      status: "mismatch",
      message: `Duplicate Connect accounts for same driver/user: ${group.driver_names.join(", ")}`,
    });
  }

  for (const driver of driverList) {
    const acctId = String(driver.stripe_account_id);
    const name = driverDisplayName(driver);
    const snapshot = await readConnectPayoutSnapshot(args.stripe, acctId, currency);
    const inFlight = await listInFlightConnectPayouts(args.stripe, acctId);
    const inTransitPence = inFlight
      .filter((p) => p.status === "in_transit")
      .reduce((s, p) => s + p.amount_pence, 0);
    const lifetimeVolume = await sumLifetimeVolumePence(args.supabase, driver.id);
    const onecabLiabilityPence = walletByDriver.get(driver.id) ?? 0;
    const recoveryDebt = recoveryByDriver.get(driver.id) ?? 0;
    const actualBalance = snapshot.available_pence ?? 0;
    const balanceDiff = actualBalance - onecabLiabilityPence;

    const acctStatus: MoneyMovementReconciliationStatus =
      Math.abs(balanceDiff) <= 100 ? "matched" : "mismatch";

    const driverCurrency = driver.region_id
      ? (regionCurrencyById.get(driver.region_id) ?? currency.toUpperCase())
      : currency.toUpperCase();

    connect_accounts.push({
      connected_account_id: acctId,
      driver_id: driver.id,
      driver_name: name,
      driver_code: driver.driver_code ?? null,
      stripe_live_balance_pence: snapshot.available_pence,
      future_payout_pence: snapshot.pending_pence,
      in_transit_to_bank_pence: inTransitPence,
      lifetime_volume_pence: lifetimeVolume,
      last_synced_at: syncedAt,
      duplicate_connect_account: duplicateByDriverId.get(driver.id) ?? false,
      duplicate_connect_group_key: duplicateGroupKeyByDriverId.get(driver.id) ?? null,
      expected_wallet_balance_pence: onecabLiabilityPence,
      actual_stripe_balance_pence: actualBalance,
      difference_pence: balanceDiff,
      recovery_debt_pence: recoveryDebt,
      net_payable_after_recovery_pence: Math.max(0, onecabLiabilityPence),
      reconciliation_status: acctStatus,
      currency_code: driverCurrency,
    });

    if (recoveryDebt > 0) {
      recovery_debt.push({
        driver_id: driver.id,
        driver_name: name,
        connected_account_id: acctId,
        recovery_debt_pence: recoveryDebt,
        ledger_types: ["CASH_COMMISSION_DEBT", "DEBT_RECOVERY"],
        reduces_net_payable: false,
        note: "Cash commission owed to ONECAB (ledger SSOT). Shown separately — not subtracted from Stripe Connect comparison.",
      });
    }

    if (Math.abs(balanceDiff) > 100) {
      mismatches.push({
        kind: "account_balance",
        driver_id: driver.id,
        driver_name: name,
        connected_account_id: acctId,
        reference_id: acctId,
        expected_pence: onecabLiabilityPence,
        actual_pence: actualBalance,
        difference_pence: balanceDiff,
        status: "mismatch",
        message: connectBalanceMismatchMessage(onecabLiabilityPence, actualBalance),
      });
    }

    const payoutList = await args.stripe.payouts.list(
      { limit: payoutLimit },
      { stripeAccount: acctId },
    );

    for (const payout of payoutList.data) {
      const initiatedAt = payout.created
        ? new Date(payout.created * 1000).toISOString()
        : null;
      const arrivalAt = payout.arrival_date
        ? new Date(payout.arrival_date * 1000).toISOString()
        : null;

      if (args.periodFrom && initiatedAt && initiatedAt < args.periodFrom) continue;
      if (args.periodTo && initiatedAt && initiatedAt > args.periodTo) continue;

      const ledgerEntries = ledgerByPayoutId.get(payout.id) ?? [];
      const ledgerSum = ledgerEntries.reduce(
        (s, e) => s + Math.abs(e.amount_pence),
        0,
      );
      const ledgerLinked = ledgerEntries.length > 0;
      const status = classifyPayoutMatch({
        payoutStatus: payout.status,
        payoutAmountPence: payout.amount,
        ledgerSumPence: ledgerSum,
        ledgerLinked,
      });

      let bankLast4: string | null = null;
      if (typeof payout.destination === "object" && payout.destination && "last4" in payout.destination) {
        bankLast4 = String((payout.destination as { last4?: string }).last4 ?? "") || null;
      }

      payouts.push({
        connected_account_id: acctId,
        driver_id: driver.id,
        driver_name: name,
        driver_code: driver.driver_code ?? null,
        stripe_live_balance_pence: snapshot.available_pence,
        future_payout_pence: snapshot.pending_pence,
        in_transit_to_bank_pence: inTransitPence,
        lifetime_volume_pence: lifetimeVolume,
        payout_id: payout.id,
        payout_amount_pence: payout.amount,
        payout_status: payout.status,
        payout_initiated_at: initiatedAt,
        estimated_arrival_at: arrivalAt,
        external_bank_last4: bankLast4,
        payout_method: payoutMethodLabel(payout),
        statement_descriptor: payout.statement_descriptor ?? null,
        last_synced_at: syncedAt,
        expected_ledger_pence: ledgerLinked ? ledgerSum : null,
        actual_stripe_pence: payout.amount,
        difference_pence: ledgerLinked ? payout.amount - ledgerSum : payout.amount,
        reconciliation_status: status,
        ledger_entry_ids: ledgerEntries.map((e) => e.id),
        ledger_linked: ledgerLinked,
        duplicate_connect_account: duplicateByDriverId.get(driver.id) ?? false,
        duplicate_connect_group_key: duplicateGroupKeyByDriverId.get(driver.id) ?? null,
      });

      if (status === "mismatch" || (status === "paid_out" && !ledgerLinked)) {
        mismatches.push({
          kind: "payout",
          driver_id: driver.id,
          driver_name: name,
          connected_account_id: acctId,
          reference_id: payout.id,
          expected_pence: ledgerLinked ? ledgerSum : null,
          actual_pence: payout.amount,
          difference_pence: ledgerLinked ? payout.amount - ledgerSum : payout.amount,
          status,
          message: ledgerLinked
            ? "Stripe payout amount does not match driver wallet ledger debit."
            : "Stripe payout paid but no matching driver_wallet_ledger stripe_payout_id entry.",
        });
      }
    }

    const { data: transferItems } = await args.supabase
      .from("payout_items")
      .select("stripe_transfer_id, amount_pence, net_driver_payout_pence, trip_id, created_at")
      .eq("driver_id", driver.id)
      .not("stripe_transfer_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);

    for (const item of transferItems ?? []) {
      transfers.push({
        transfer_id: String(item.stripe_transfer_id),
        connected_account_id: acctId,
        driver_id: driver.id,
        driver_name: name,
        amount_pence: Number(item.net_driver_payout_pence ?? item.amount_pence ?? 0),
        trip_id: item.trip_id ?? null,
        created_at: item.created_at ?? null,
        reconciliation_status: "matched",
      });
    }

    const { data: feeTrips } = await args.supabase
      .from("trips")
      .select("id, stripe_application_fee_id, stripe_charge_id, commission_pence, completed_at")
      .eq("driver_id", driver.id)
      .not("stripe_application_fee_id", "is", null)
      .order("completed_at", { ascending: false })
      .limit(30);

    for (const trip of feeTrips ?? []) {
      collected_fees.push({
        connected_account_id: acctId,
        driver_id: driver.id,
        driver_name: name,
        application_fee_id: trip.stripe_application_fee_id ?? null,
        charge_id: trip.stripe_charge_id ?? null,
        trip_id: trip.id,
        amount_pence: Math.max(0, Number(trip.commission_pence ?? 0)),
        created_at: trip.completed_at ?? null,
      });
    }
  }

  payouts.sort((a, b) =>
    String(b.payout_initiated_at ?? "").localeCompare(String(a.payout_initiated_at ?? "")),
  );

  return {
    version: MONEY_MOVEMENT_SSOT_VERSION,
    last_synced_at: syncedAt,
    connect_accounts,
    payouts,
    transfers,
    collected_fees,
    recovery_debt,
    mismatches,
    duplicate_connect_groups: groups,
  };
}

export function sumRecoveryDebtPence(rows: ConnectRecoveryDebtRow[]): number {
  return rows.reduce((s, r) => s + Math.max(0, r.recovery_debt_pence), 0);
}

export function filterPayoutLedgerRows(rows: Array<{ type: string }>): boolean {
  return PAYOUT_LEDGER_TYPES.has(String(rows));
}
