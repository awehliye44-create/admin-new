/**
 * Protected driver liabilities loader — I/O for company balance / transfer gates.
 * Never mutates wallets, reservations, or provider payments.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  computeProtectedDriverLiabilitiesPence,
  type ProtectedDriverLiabilityBreakdown,
  type ProtectedDriverLiabilityDriverRow,
} from "../../../shared/protectedDriverLiabilitiesSSOT.ts";
import {
  isCanonicalCompletedDriverPayoutExecution,
  type CanonicalDriverPayoutExecutionRow,
} from "./payoutLedgerCompanyFundingSSOT.ts";
import { computeLedgerWalletBalancePence } from "./onecabFinanceLedger.ts";
import { loadDriverWalletEligibilityBalancesBatchRpc } from "./driverWalletEligibilityBalancesRpc.ts";
import {
  loadPlatformCollectedServiceAreaIds,
  resolvePlatformCollectedDriverIds,
} from "./platformCollectedDriverScope.ts";
import { TERMINAL_FEE_TRIP_STATUSES } from "./driverCreditMonitoringSSOT.ts";
import { resolveTerminalFeeDriverTenPence } from "./frDriverExpectedEntitlementSSOT.ts";

export type { ProtectedDriverLiabilityBreakdown };

const INFLIGHT_ITEM_STATUSES = new Set([
  "VALIDATED",
  "RESERVING",
  "RESERVED",
  "SUBMITTING",
  "SUBMITTED",
  "PROCESSING",
  "PENDING",
  "PENDING_PROVIDER",
  "IN_PROGRESS",
  "ON_HOLD",
  "READY",
  "QUEUED",
  "SCHEDULED",
]);

const UNRESOLVED_ITEM_STATUSES = new Set([
  "RESERVED",
  "ON_HOLD",
  "READY",
  "QUEUED",
  "SCHEDULED",
  "PENDING",
]);

const INFLIGHT_EXECUTION = new Set([
  "submitted",
  "processing",
  "pending_provider",
  "in_progress",
]);

async function resolveScopedDriverIds(
  supabase: SupabaseClient,
  args: {
    service_area_id?: string | null;
    allowed_service_area_ids?: readonly string[] | null;
    /** When true, ignore UI SA filter and load all PLATFORM_COLLECTED drivers. */
    global_company_funds?: boolean;
  },
): Promise<string[]> {
  if (args.service_area_id) {
    return resolvePlatformCollectedDriverIds(supabase, {
      service_area_id: args.service_area_id,
      allowed_service_area_ids: args.allowed_service_area_ids ?? [],
    });
  }

  let allowed = [...(args.allowed_service_area_ids ?? [])];
  if (args.global_company_funds || allowed.length === 0) {
    allowed = await loadPlatformCollectedServiceAreaIds(supabase);
  }
  if (allowed.length === 0) return [];

  return resolvePlatformCollectedDriverIds(supabase, {
    service_area_id: null,
    allowed_service_area_ids: allowed,
  });
}

function groupInflightByDriver(
  executions: ReadonlyArray<CanonicalDriverPayoutExecutionRow & { unresolved_only?: boolean }>,
): Map<string, { inflight: number; unresolved: number }> {
  const byDriver = new Map<string, { inflight: number; unresolved: number }>();
  for (const row of executions) {
    if (isCanonicalCompletedDriverPayoutExecution(row)) continue;
    const id = String(row.driver_id ?? "");
    if (!id) continue;
    const amt = Math.max(0, Math.round(Number(row.amount_pence ?? 0)));
    if (amt <= 0) continue;
    const bucket = byDriver.get(id) ?? { inflight: 0, unresolved: 0 };
    const itemSt = String(row.item_status ?? "").trim().toUpperCase();
    const execSt = String(row.execution_status ?? "").trim().toLowerCase();
    const providerSt = String(row.provider_state ?? "").trim().toLowerCase();
    const isSubmitted = INFLIGHT_EXECUTION.has(execSt)
      || providerSt === "submitted"
      || providerSt === "processing"
      || itemSt === "SUBMITTED"
      || itemSt === "PROCESSING";
    if (isSubmitted) {
      bucket.inflight += amt;
    } else if (UNRESOLVED_ITEM_STATUSES.has(itemSt)) {
      bucket.unresolved += amt;
    } else if (INFLIGHT_ITEM_STATUSES.has(itemSt)) {
      bucket.inflight += amt;
    }
    byDriver.set(id, bucket);
  }
  return byDriver;
}

async function loadInflightExecutions(
  supabase: SupabaseClient,
  driverIds: string[],
): Promise<CanonicalDriverPayoutExecutionRow[]> {
  if (driverIds.length === 0) return [];
  const executions: CanonicalDriverPayoutExecutionRow[] = [];

  const { data: items } = await supabase
    .from("payout_items")
    .select(
      "driver_id, amount_pence, net_driver_payout_pence, status, execution_status, provider_state, financially_applied, completed_at",
    )
    .in("driver_id", driverIds)
    .limit(5000);

  for (const row of items ?? []) {
    const st = String(row.status ?? "").trim().toUpperCase();
    if (st === "COMPLETED" || st === "FAILED" || st === "CANCELLED") continue;
    executions.push({
      driver_id: String(row.driver_id ?? ""),
      amount_pence: Number(row.net_driver_payout_pence ?? row.amount_pence ?? 0),
      item_status: row.status as string | null,
      execution_status: row.execution_status as string | null,
      provider_state: row.provider_state as string | null,
      financially_applied: row.financially_applied as boolean | null,
      completed_at: row.completed_at as string | null,
    });
  }

  try {
    const { data: intents } = await supabase
      .from("driver_payout_payment_intents")
      .select(
        "driver_id, amount_pence, provider_state, execution_status, financially_applied, financially_applied_at",
      )
      .in("driver_id", driverIds)
      .limit(5000);
    for (const row of intents ?? []) {
      const provider = String(row.provider_state ?? "").trim().toLowerCase();
      if (provider === "completed" || provider === "failed" || provider === "cancelled") continue;
      executions.push({
        driver_id: String(row.driver_id ?? ""),
        amount_pence: Number(row.amount_pence ?? 0),
        provider_state: row.provider_state as string | null,
        execution_status: row.execution_status as string | null,
        financially_applied: row.financially_applied as boolean | null,
        financially_applied_at: row.financially_applied_at as string | null,
      });
    }
  } catch {
    // intents table optional in older envs
  }

  return executions;
}

async function loadTerminalFeeOwedByDriver(
  supabase: SupabaseClient,
  driverIds: string[],
): Promise<Map<string, number>> {
  const owed = new Map<string, number>();
  if (driverIds.length === 0) return owed;

  const terminalStatuses = [...TERMINAL_FEE_TRIP_STATUSES];
  const { data: trips } = await supabase
    .from("trips")
    .select(
      "id, driver_id, status, driver_net_pence, financial_model, payment_session_id",
    )
    .in("driver_id", driverIds)
    .eq("financial_model", "PLATFORM_COLLECTED")
    .in("status", terminalStatuses)
    .limit(500);

  const tripIds = (trips ?? []).map((t) => String(t.id)).filter(Boolean);
  if (tripIds.length === 0) return owed;

  const { data: sessions } = await supabase
    .from("payment_sessions")
    .select(
      "trip_id, captured_amount_pence, provider_processing_fee_pence, fee_status, status",
    )
    .in("trip_id", tripIds);

  const sessionByTrip = new Map<string, Record<string, unknown>>();
  for (const s of sessions ?? []) {
    sessionByTrip.set(String(s.trip_id ?? ""), s as Record<string, unknown>);
  }

  const { data: ledgerRows } = await supabase
    .from("driver_wallet_ledger")
    .select("related_trip_id, amount_pence, type")
    .in("related_trip_id", tripIds)
    .eq("type", "TRIP_EARNING_NET");

  const creditedByTrip = new Map<string, number>();
  for (const row of ledgerRows ?? []) {
    const tid = String(row.related_trip_id ?? "");
    creditedByTrip.set(tid, Math.max(0, Number(row.amount_pence ?? 0)));
  }

  for (const trip of trips ?? []) {
    const driverId = String(trip.driver_id ?? "");
    const tripId = String(trip.id ?? "");
    if (!driverId || !tripId) continue;
    const session = sessionByTrip.get(tripId);
    const captured = Math.max(0, Number(session?.captured_amount_pence ?? 0));
    if (captured <= 0) continue;
    const feeConfirmed = String(session?.fee_status ?? "").toUpperCase() === "CONFIRMED"
      || (session?.provider_processing_fee_pence != null
        && Number(session.provider_processing_fee_pence) >= 0);
    if (!feeConfirmed) continue;
    const fee = Math.max(0, Number(session?.provider_processing_fee_pence ?? 0));
    const entitlement = resolveTerminalFeeDriverTenPence({
      captured_pence: captured,
      provider_fee_pence: fee,
      commission_pence: 0,
    });
    if (entitlement == null || entitlement <= 0) continue;
    const credited = creditedByTrip.get(tripId) ?? 0;
    const gap = Math.max(0, entitlement - credited);
    if (gap <= 0) continue;
    owed.set(driverId, (owed.get(driverId) ?? 0) + gap);
  }

  return owed;
}

async function loadEligibilityBatch(
  supabase: SupabaseClient,
  driverIds: string[],
): Promise<Map<string, { available: number; pending: number; live: number }>> {
  const rpcRows = await loadDriverWalletEligibilityBalancesBatchRpc(supabase, driverIds);
  const out = new Map<string, { available: number; pending: number; live: number }>();
  for (const driverId of driverIds) {
    const row = rpcRows.get(driverId);
    if (!row) continue;
    out.set(driverId, {
      available: row.available_balance_pence,
      pending: row.pending_balance_pence,
      live: row.live_balance_pence,
    });
  }
  return out;
}

export async function loadProtectedDriverLiabilitiesPence(
  supabase: SupabaseClient,
  args: {
    service_area_id?: string | null;
    allowed_service_area_ids?: readonly string[] | null;
    global_company_funds?: boolean;
  },
): Promise<{
  amount_pence: number | null;
  breakdown: ProtectedDriverLiabilityBreakdown | null;
  error_code: string | null;
}> {
  try {
    const driverIds = await resolveScopedDriverIds(supabase, args);
    if (driverIds.length === 0) {
      return {
        amount_pence: 0,
        breakdown: computeProtectedDriverLiabilitiesPence([]),
        error_code: null,
      };
    }

    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from("driver_wallet_ledger")
      .select("driver_id, type, amount_pence")
      .in("driver_id", driverIds);
    if (ledgerErr) {
      return { amount_pence: null, breakdown: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
    }

    const byDriverLedger = new Map<string, Array<{ type?: string | null; amount_pence?: number | null }>>();
    for (const row of ledgerRows ?? []) {
      const id = String(row.driver_id ?? "");
      if (!id) continue;
      const list = byDriverLedger.get(id) ?? [];
      list.push(row);
      byDriverLedger.set(id, list);
    }

    const liveByDriver = new Map<string, number>();
    for (const id of driverIds) {
      liveByDriver.set(
        id,
        Math.max(0, computeLedgerWalletBalancePence(byDriverLedger.get(id) ?? [])),
      );
    }

    const { data: reservationRows, error: resErr } = await supabase
      .from("driver_payout_reservations")
      .select("driver_id, amount_pence, status")
      .eq("status", "ACTIVE")
      .in("driver_id", driverIds)
      .limit(5000);
    if (resErr) {
      return { amount_pence: null, breakdown: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
    }

    const reservedByDriver = new Map<string, number>();
    for (const row of reservationRows ?? []) {
      const id = String(row.driver_id ?? "");
      reservedByDriver.set(
        id,
        (reservedByDriver.get(id) ?? 0) + Math.max(0, Number(row.amount_pence ?? 0)),
      );
    }

    const [eligibilityByDriver, inflightExecutions, terminalOwedByDriver] = await Promise.all([
      loadEligibilityBatch(supabase, driverIds),
      loadInflightExecutions(supabase, driverIds),
      loadTerminalFeeOwedByDriver(supabase, driverIds),
    ]);

    const inflightByDriver = groupInflightByDriver(inflightExecutions);

    const rows: ProtectedDriverLiabilityDriverRow[] = driverIds.map((driverId) => {
      const elig = eligibilityByDriver.get(driverId);
      const inflight = inflightByDriver.get(driverId);
      return {
        driver_id: driverId,
        live_wallet_pence: liveByDriver.get(driverId) ?? 0,
        available_pence: elig?.available ?? 0,
        pending_clearing_pence: elig?.pending ?? 0,
        active_reserved_pence: reservedByDriver.get(driverId) ?? 0,
        inflight_provider_transfer_pence: inflight?.inflight ?? 0,
        terminal_fee_owed_pence: terminalOwedByDriver.get(driverId) ?? 0,
        unresolved_protected_obligation_pence: inflight?.unresolved ?? 0,
      };
    });

    const breakdown = computeProtectedDriverLiabilitiesPence(rows);
    return { amount_pence: breakdown.total_pence, breakdown, error_code: null };
  } catch {
    return { amount_pence: null, breakdown: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
  }
}

/** @deprecated Prefer loadProtectedDriverLiabilitiesPence */
export async function loadProtectedDriverLiabilityPence(
  supabase: SupabaseClient,
  service_area_id?: string | null,
  allowed_service_area_ids?: readonly string[] | null,
): Promise<{ amount_pence: number | null; error_code: string | null }> {
  const result = await loadProtectedDriverLiabilitiesPence(supabase, {
    service_area_id,
    allowed_service_area_ids,
  });
  return { amount_pence: result.amount_pence, error_code: result.error_code };
}

export async function loadReservedDriverPayoutPence(
  supabase: SupabaseClient,
  service_area_id?: string | null,
): Promise<{ amount_pence: number | null; error_code: string | null }> {
  try {
    const { data: rows, error } = await supabase
      .from("driver_payout_reservations")
      .select("driver_id, amount_pence")
      .eq("status", "ACTIVE")
      .limit(5000);
    if (error) {
      return { amount_pence: null, error_code: "RESERVED_DRIVER_PAYOUTS_QUERY_FAILED" };
    }
    let reservedRows = rows ?? [];
    if (service_area_id && reservedRows.length > 0) {
      const ids = [...new Set(reservedRows.map((r) => String(r.driver_id)).filter(Boolean))];
      const { data: links } = await supabase
        .from("driver_service_areas")
        .select("driver_id")
        .eq("service_area_id", service_area_id)
        .in("driver_id", ids);
      const allowed = new Set((links ?? []).map((r) => String(r.driver_id)));
      reservedRows = reservedRows.filter((r) => allowed.has(String(r.driver_id)));
    }
    let reserved = 0;
    for (const r of reservedRows) {
      reserved += Math.max(0, Number(r.amount_pence ?? 0));
    }
    return { amount_pence: reserved, error_code: null };
  } catch {
    return { amount_pence: null, error_code: "RESERVED_DRIVER_PAYOUTS_QUERY_FAILED" };
  }
}
