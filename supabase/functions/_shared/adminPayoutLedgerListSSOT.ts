/**
 * Admin Payout Ledger list — reads payout_batches / payout_items / allocations.
 * No payout execution; action flags are conservative (retry/cancel require existing writers).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type {
  AdminPayoutLedgerBatchRow,
  AdminPayoutLedgerItemRow,
  AdminPayoutLedgerListRequest,
  AdminPayoutLedgerListResponse,
  AdminPayoutLedgerTab,
  CompanyOutgoingAuditRow,
  CompanyOutgoingBatchRow,
  CompanyOutgoingTransferRow,
} from "../../../shared/adminPayoutLedgerSSOT.ts";
import { buildPayoutLedgerOverview } from "./adminPayoutLedgerOverviewSSOT.ts";
import { resolveLiveCompanyBalanceWithSlice10Gate } from "./companyBalanceResolveSSOT.ts";
import { sumCompletedDriverPayoutsThisMonthPence } from "../../../shared/payoutLedgerCompanyFundingSSOT.ts";
import {
  COMPANY_TRANSFERS_EMPTY_COPY,
  aggregateDriverPayoutBatchStatus,
  resolveDriverPayoutItemDisplayPresentation,
} from "../../../shared/driverPayoutBatchDisplaySSOT.ts";
import { orchestratorBlockerLabel } from "../../../shared/weeklyPayoutOrchestratorSSOT.ts";
import { resolvePlatformCollectedDriverIds } from "./platformCollectedDriverScope.ts";

const PROCESSING = new Set(["processing", "in_progress", "submitted", "pending_provider"]);
const SCHEDULED = new Set(["pending", "scheduled", "queued", "on_hold"]);
const COMPLETED = new Set(["completed", "paid", "succeeded"]);
const FAILED = new Set(["failed", "error"]);
const RETURNED_CANCELLED = new Set(["returned", "cancelled", "canceled", "reversed"]);

/** Runtime flags for admin UI — booleans only, never secret values. */
function readPayoutExecutionFlags(): {
  live_payout_execution_enabled: boolean;
  live_company_transfer_execution_enabled: boolean;
} {
  const env = (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } }).Deno?.env;
  const live = (env?.get?.("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
  const company =
    (env?.get?.("LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
  return {
    live_payout_execution_enabled: live,
    live_company_transfer_execution_enabled: company,
  };
}

function emptySummary(): AdminPayoutLedgerListResponse["summary"] {
  return {
    total_items: 0,
    scheduled_count: 0,
    processing_count: 0,
    completed_count: 0,
    failed_count: 0,
    returned_cancelled_count: 0,
    pending_count: 0,
    scheduled_today_count: 0,
    paid_today_count: 0,
    paid_today_pence: null,
    total_paid_pence: null,
    total_failed_pence: null,
    total_paid_week_pence: null,
    total_paid_month_pence: null,
    total_paid_year_pence: null,
  };
}

function mapCompanyTransfer(row: Record<string, unknown>): CompanyOutgoingTransferRow {
  return {
    id: String(row.id),
    transfer_ref: String(row.transfer_ref ?? ""),
    created_at: String(row.created_at),
    recipient_name: String(row.recipient_name ?? ""),
    recipient_type: String(row.recipient_type ?? ""),
    category: String(row.category ?? ""),
    money_source: String(row.money_source ?? ""),
    source_account: (row.source_account as string | null) ?? null,
    destination_account: (row.destination_account as string | null) ?? null,
    amount_pence: Number(row.amount_pence ?? 0),
    currency: String(row.currency ?? "GBP"),
    purpose: String(row.purpose ?? ""),
    service_area_id: (row.service_area_id as string | null) ?? null,
    cost_centre: (row.cost_centre as string | null) ?? null,
    requested_by: (row.requested_by as string | null) ?? null,
    approved_by: (row.approved_by as string | null) ?? null,
    approval_count: Number(row.approval_count ?? 0),
    approvals_required: Number(row.approvals_required ?? 1),
    provider: (row.provider as string | null) ?? null,
    provider_reference: (row.provider_reference as string | null) ?? null,
    status: String(row.status ?? ""),
    execution_at: (row.execution_at as string | null) ?? null,
    failure_reason: (row.failure_reason as string | null) ?? null,
    provider_error: (row.provider_error as string | null) ?? null,
    retry_count: Number(row.retry_count ?? 0),
    last_attempt_at: (row.last_attempt_at as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    attachment_url: (row.attachment_url as string | null) ?? null,
    batch_id: (row.batch_id as string | null) ?? null,
    payment_reference: row.payment_reference == null ? null : String(row.payment_reference),
    statement_reference: row.statement_reference == null ? null : String(row.statement_reference),
    transfer_type: row.transfer_type == null ? null : String(row.transfer_type),
    metadata: (row.metadata && typeof row.metadata === "object")
      ? row.metadata as Record<string, unknown>
      : null,
    payee_id: row.payee_id == null ? null : String(row.payee_id),
    blocked_reason_codes: Array.isArray(row.blocked_reason_codes)
      ? row.blocked_reason_codes.map(String)
      : null,
    provider_state: row.provider_state == null ? null : String(row.provider_state),
    provider_transaction_id: row.provider_transaction_id == null
      ? null
      : String(row.provider_transaction_id),
  };
}

/** Protected driver liabilities = sum of positive live DWL balances (not provider cash). */
async function loadProtectedDriverLiabilityPence(
  supabase: SupabaseClient,
  service_area_id?: string | null,
  allowed_service_area_ids?: readonly string[] | null,
): Promise<{ amount_pence: number | null; error_code: string | null }> {
  try {
    let driverQuery = supabase
      .from("drivers")
      .select("id")
      .limit(500);
    if (service_area_id || (allowed_service_area_ids && allowed_service_area_ids.length >= 0)) {
      const ids = await resolvePlatformCollectedDriverIds(supabase, {
        service_area_id: service_area_id ?? null,
        allowed_service_area_ids: allowed_service_area_ids ?? [],
      });
      if (ids.length === 0) return { amount_pence: 0, error_code: null };
      driverQuery = driverQuery.in("id", ids);
    }
    const { data: drivers, error } = await driverQuery;
    if (error) {
      return { amount_pence: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
    }
    const driverIds = (drivers ?? []).map((d) => String(d.id)).filter(Boolean);
    if (driverIds.length === 0) return { amount_pence: 0, error_code: null };

    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from("driver_wallet_ledger")
      .select("driver_id, type, amount_pence")
      .in("driver_id", driverIds);
    if (ledgerErr) {
      return { amount_pence: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
    }

    const { computeLedgerWalletBalancePence } = await import("./onecabFinanceLedger.ts");
    const byDriver = new Map<string, Array<{ type?: string | null; amount_pence?: number | null }>>();
    for (const row of ledgerRows ?? []) {
      const id = String(row.driver_id ?? "");
      if (!id) continue;
      const list = byDriver.get(id) ?? [];
      list.push(row);
      byDriver.set(id, list);
    }
    let liveTotal = 0;
    for (const id of driverIds) {
      liveTotal += Math.max(0, computeLedgerWalletBalancePence(byDriver.get(id) ?? []));
    }
    return { amount_pence: liveTotal, error_code: null };
  } catch {
    return { amount_pence: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
  }
}

async function loadReservedDriverPayoutPence(
  supabase: SupabaseClient,
  service_area_id?: string | null,
  allowed_service_area_ids?: readonly string[] | null,
): Promise<{ amount_pence: number | null; error_code: string | null }> {
  try {
    // Slice 6 SSOT: ACTIVE rows on driver_payout_reservations (not payout_item status heuristics).
    let query = supabase
      .from("driver_payout_reservations")
      .select("driver_id, amount_pence")
      .eq("status", "ACTIVE");
    const { data: rows, error } = await query.limit(5000);
    if (error) {
      return { amount_pence: null, error_code: "RESERVED_DRIVER_PAYOUTS_QUERY_FAILED" };
    }
    let reservedRows = rows ?? [];
    if (service_area_id || (allowed_service_area_ids && allowed_service_area_ids.length >= 0)) {
      const allowed = new Set(await resolvePlatformCollectedDriverIds(supabase, {
        service_area_id: service_area_id ?? null,
        allowed_service_area_ids: allowed_service_area_ids ?? [],
      }));
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

/**
 * Canonical completed-this-month for company funding cards:
 * driver payout executions with provider_state=completed (financially applied)
 * plus COMPLETED payout_items — London calendar month. Never company transfers.
 */
async function loadCompletedDriverPayoutMonthPence(
  supabase: SupabaseClient,
  service_area_id?: string | null,
  allowed_service_area_ids?: readonly string[] | null,
): Promise<number> {
  const monthStart = londonMonthStartIso();
  const executions: Array<{
    driver_id: string;
    amount_pence: number;
    provider_state?: string | null;
    item_status?: string | null;
    execution_status?: string | null;
    financially_applied?: boolean | null;
    completed_at?: string | null;
    provider_completed_at?: string | null;
    financially_applied_at?: string | null;
  }> = [];

  try {
    const { data: intents } = await supabase
      .from("driver_payout_payment_intents")
      .select(
        "driver_id, amount_pence, provider_state, execution_status, financially_applied_at, provider_completed_at",
      )
      .eq("provider_state", "completed")
      .not("financially_applied_at", "is", null)
      .limit(2000);
    for (const row of intents ?? []) {
      executions.push({
        driver_id: String(row.driver_id ?? ""),
        amount_pence: Number(row.amount_pence ?? 0),
        provider_state: row.provider_state as string | null,
        execution_status: row.execution_status as string | null,
        financially_applied: true,
        financially_applied_at: row.financially_applied_at as string | null,
        provider_completed_at: row.provider_completed_at as string | null,
      });
    }
  } catch (err) {
    console.warn("[admin-payout-ledger] completed-month intents failed", err);
  }

  try {
    const { data: items } = await supabase
      .from("payout_items")
      .select("driver_id, amount_pence, net_driver_payout_pence, status, execution_status, completed_at")
      .in("status", ["COMPLETED", "completed", "paid", "succeeded"])
      .limit(2000);
    for (const row of items ?? []) {
      executions.push({
        driver_id: String(row.driver_id ?? ""),
        amount_pence: Number(row.net_driver_payout_pence ?? row.amount_pence ?? 0),
        item_status: row.status as string | null,
        execution_status: row.execution_status as string | null,
        completed_at: row.completed_at as string | null,
      });
    }
  } catch (err) {
    console.warn("[admin-payout-ledger] completed-month items failed", err);
  }

  let scoped = executions;
  if (service_area_id || (allowed_service_area_ids && allowed_service_area_ids.length >= 0)) {
    const allowed = new Set(await resolvePlatformCollectedDriverIds(supabase, {
      service_area_id: service_area_id ?? null,
      allowed_service_area_ids: allowed_service_area_ids ?? [],
    }));
    scoped = executions.filter((e) => allowed.has(e.driver_id));
  }

  return sumCompletedDriverPayoutsThisMonthPence({
    executions: scoped,
    month_start_iso: monthStart,
  });
}

function londonDayStartIso(ref = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(ref);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const londonHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(probe),
  );
  const offsetMs = (londonHour - 12) * 60 * 60 * 1000;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs).toISOString();
}

function londonWeekStartIso(ref = new Date()): string {
  const today = new Date(londonDayStartIso(ref));
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(ref);
  const dayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
  return new Date(today.getTime() - (dayIndex >= 0 ? dayIndex : 0) * 86400000).toISOString();
}

function londonMonthStartIso(ref = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(ref);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const probe = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
  const londonHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(probe),
  );
  const offsetMs = (londonHour - 12) * 60 * 60 * 1000;
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - offsetMs).toISOString();
}

function londonYearStartIso(ref = new Date()): string {
  const y = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric" }).format(ref),
  );
  const probe = new Date(Date.UTC(y, 0, 1, 12, 0, 0));
  const londonHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(probe),
  );
  const offsetMs = (londonHour - 12) * 60 * 60 * 1000;
  return new Date(Date.UTC(y, 0, 1, 0, 0, 0) - offsetMs).toISOString();
}

function normaliseStatus(raw: string | null | undefined): string {
  return String(raw ?? "UNKNOWN").toUpperCase();
}

function mapDriverBatchRow(
  b: Record<string, unknown>,
  itemStatuses?: Array<{ status?: string | null; execution_status?: string | null }>,
): AdminPayoutLedgerBatchRow {
  const stored = normaliseStatus(b.status as string | null);
  const agg = itemStatuses && itemStatuses.length > 0
    ? aggregateDriverPayoutBatchStatus(itemStatuses, stored)
    : null;
  const status = agg?.status ?? stored;
  const successful = agg?.successful_payouts
    ?? (b.successful_payouts == null ? null : Number(b.successful_payouts));
  const blockerCode = (b.blocker_code as string | null)
    ?? (b.failure_code as string | null)
    ?? null;
  const blockedLabel = status === "BLOCKED_EXECUTION_DISABLED" || status === "BLOCKED"
    ? orchestratorBlockerLabel(blockerCode ?? "LIVE_PAYOUT_ROLLOUT_DISABLED")
    : null;
  return {
    id: String(b.id),
    created_at: String(b.created_at),
    run_date: String(b.run_date),
    kind: String(b.kind ?? ""),
    status,
    status_label: agg?.status_label ?? blockedLabel ?? status,
    schedule_occurrence_key: (b.schedule_occurrence_key as string | null) ?? null,
    schedule_id: (b.schedule_id as string | null) ?? null,
    scheduled_local_at: (b.scheduled_local_at as string | null) ?? null,
    scheduled_utc_at: b.scheduled_utc_at == null ? null : String(b.scheduled_utc_at),
    timezone: (b.timezone as string | null) ?? null,
    currency: (b.currency as string | null) ?? null,
    eligible_driver_count: b.eligible_driver_count == null
      ? (b.total_drivers == null ? null : Number(b.total_drivers))
      : Number(b.eligible_driver_count),
    paid_claim: status === "BLOCKED_EXECUTION_DISABLED" || status === "PARTIALLY_COMPLETED"
      || status === "BLOCKED"
      ? false
      : Boolean(successful && successful > 0 && status === "COMPLETED"),
    total_drivers: b.total_drivers == null ? null : Number(b.total_drivers),
    total_amount_pence: b.total_amount_pence == null ? null : Number(b.total_amount_pence),
    successful_payouts: successful,
    failed_payouts: b.failed_payouts == null ? null : Number(b.failed_payouts),
    completed_at: (b.completed_at as string | null) ?? null,
    failure_reason: (b.failure_reason as string | null) ?? null,
    blocker_code: blockerCode,
    failure_code: (b.failure_code as string | null) ?? null,
  };
}

async function loadBatchItemStatuses(
  supabase: SupabaseClient,
  batchIds: string[],
): Promise<Map<string, Array<{ status?: string | null; execution_status?: string | null }>>> {
  const map = new Map<string, Array<{ status?: string | null; execution_status?: string | null }>>();
  if (batchIds.length === 0) return map;
  const { data, error } = await supabase
    .from("payout_items")
    .select("batch_id, status, execution_status")
    .in("batch_id", batchIds)
    .limit(5000);
  if (error) {
    console.warn("[admin-payout-ledger] batch item status enrich failed", error.message);
    return map;
  }
  for (const row of data ?? []) {
    const id = String(row.batch_id ?? "");
    if (!id) continue;
    const list = map.get(id) ?? [];
    list.push({
      status: row.status as string | null,
      execution_status: row.execution_status as string | null,
    });
    map.set(id, list);
  }
  return map;
}

const DRIVER_BATCH_SELECT =
  "id, created_at, run_date, kind, status, total_drivers, total_amount_pence, successful_payouts, failed_payouts, completed_at, failure_reason, failure_code, blocker_code, schedule_occurrence_key, schedule_id, scheduled_local_at, scheduled_utc_at, timezone, currency, eligible_driver_count";

function itemMatchesTab(status: string, tab: AdminPayoutLedgerTab): boolean {
  const s = status.toLowerCase();
  if (tab === "overview" || tab === "history" || tab === "batches" || tab === "settings") return true;
  if (tab === "scheduled") return SCHEDULED.has(s) || s === "on_hold";
  if (tab === "processing") return PROCESSING.has(s);
  if (tab === "completed") return COMPLETED.has(s);
  if (tab === "failed") return FAILED.has(s);
  if (tab === "returned_cancelled") return RETURNED_CANCELLED.has(s);
  return true;
}

function actionPolicyForStatus(status: string): AdminPayoutLedgerItemRow["action_policy"] {
  const s = status.toLowerCase();
  return {
    can_open_wallet: true,
    can_view_allocations: true,
    can_open_reconciliation: true,
    can_retry: FAILED.has(s),
    can_cancel: SCHEDULED.has(s) || s === "on_hold",
    can_inspect_provider: true,
  };
}

async function listCompanyTransfers(
  supabase: SupabaseClient,
  request: AdminPayoutLedgerListRequest,
  failedOnly: boolean,
): Promise<AdminPayoutLedgerListResponse> {
  const limit = Math.min(200, Math.max(1, request.limit ?? 100));
  let query = supabase
    .from("company_outgoing_transfers")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (failedOnly) query = query.eq("status", "FAILED");
  if (request.status) query = query.eq("status", request.status);
  if (request.service_area_id) {
    query = query.eq("service_area_id", request.service_area_id);
  } else if (request.allowed_service_area_ids && request.allowed_service_area_ids.length > 0) {
    query = query.in("service_area_id", request.allowed_service_area_ids);
  } else if (request.allowed_service_area_ids && request.allowed_service_area_ids.length === 0) {
    query = query.eq("service_area_id", "00000000-0000-0000-0000-000000000000");
  }
  if (request.batch_id) query = query.eq("batch_id", request.batch_id);

  const { data, error: transfersError } = await query;
  if (transfersError) {
    console.warn("[admin-payout-ledger] company_list failed", transfersError.message);
  }
  const transfers = transfersError
    ? []
    : (data ?? []).map((row) => mapCompanyTransfer(row as Record<string, unknown>));
  const monthStart = londonMonthStartIso();
  let awaiting_approval_count = 0;
  let approved_payables_pending_pence = 0;
  let processing_pence = 0;
  let completed_company_transfers_month_pence = 0;
  let failed_count = 0;
  for (const t of transfers) {
    const st = String(t.status ?? "").toUpperCase();
    const amt = Math.max(0, Number(t.amount_pence ?? 0));
    if (st === "AWAITING_APPROVAL") {
      awaiting_approval_count += 1;
      approved_payables_pending_pence += amt;
    } else if (st === "APPROVED") {
      approved_payables_pending_pence += amt;
    } else if (st === "PROCESSING" || st === "SCHEDULED") {
      processing_pence += amt;
    } else if (st === "PAID" || st === "COMPLETED") {
      const at = String(t.execution_at ?? t.created_at ?? "");
      if (at >= monthStart) completed_company_transfers_month_pence += amt;
    } else if (st === "FAILED") {
      failed_count += 1;
    }
  }

  // Load independent sections — provider failure must not wipe liabilities / payables / reserves.
  const [liability, reserved, completed_driver_payouts_month_pence] =
    await Promise.all([
      loadProtectedDriverLiabilityPence(
        supabase,
        request.service_area_id ?? null,
        request.allowed_service_area_ids ?? null,
      ),
      loadReservedDriverPayoutPence(
        supabase,
        request.service_area_id ?? null,
        request.allowed_service_area_ids ?? null,
      ),
      loadCompletedDriverPayoutMonthPence(
        supabase,
        request.service_area_id ?? null,
        request.allowed_service_area_ids ?? null,
      ),
    ]);

  let companyBalance;
  try {
    companyBalance = await resolveLiveCompanyBalanceWithSlice10Gate({
      supabase,
      service_area_id: request.service_area_id ?? null,
      currency: "GBP",
      approved_payables_pending_pence,
      driver_liability_pence: liability.amount_pence,
      driver_payout_reserved_pence: reserved.amount_pence,
      customer_refund_reserved_pence: null,
    });
  } catch (err) {
    console.warn("[admin-payout-ledger] company balance resolve failed", err);
    const { resolveCompanyBalanceSnapshot, COMPANY_BALANCE_ERROR } = await import(
      "../../../shared/companyBalanceSSOT.ts"
    );
    companyBalance = resolveCompanyBalanceSnapshot({
      currency: "GBP",
      service_area_id: request.service_area_id ?? null,
      approved_payables_pending_pence,
      driver_liability_pence: liability.amount_pence,
      driver_payout_reserved_pence: reserved.amount_pence,
      operational_reserve_pence: null,
      classified_company_cash_pence: null,
      status_code: COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE,
    });
  }

  // Patch independent section failures without inventing £0.
  if (companyBalance.sections) {
    const sections = { ...companyBalance.sections };
    let wipeAvailable = false;
    if (liability.error_code) {
      sections.driver_liabilities = {
        status: "ERROR",
        amount_pence: null,
        currency: "GBP",
        reason_code: liability.error_code,
      };
      wipeAvailable = true;
      companyBalance = { ...companyBalance, driver_liability_pence: null, sections };
    }
    if (reserved.error_code) {
      sections.reserved_driver_payouts = {
        status: "ERROR",
        amount_pence: null,
        currency: "GBP",
        reason_code: reserved.error_code,
      };
      wipeAvailable = true;
      companyBalance = {
        ...companyBalance,
        driver_payout_reserved_pence: null,
        sections,
      };
    }
    if (companyBalance.operational_reserve_pence == null) {
      const reserveCode = companyBalance.sections?.operational_reserve?.reason_code
        ?? "OPERATIONAL_RESERVE_NOT_CONFIGURED";
      sections.operational_reserve = {
        status: reserveCode === "OPERATIONAL_RESERVE_QUERY_FAILED"
            || reserveCode === "OPERATIONAL_RESERVE_INVALID"
          ? "ERROR"
          : "NOT_CONFIGURED",
        amount_pence: null,
        currency: "GBP",
        reason_code: reserveCode,
      };
      // Fail-closed: missing reserve must not claim residual cash is company-owned.
      sections.company_transfer_available = {
        status: "UNAVAILABLE",
        amount_pence: null,
        currency: "GBP",
        reason_code: reserveCode,
      };
      wipeAvailable = true;
      companyBalance = {
        ...companyBalance,
        operational_reserve_pence: null,
        company_available_for_transfer_pence: null,
        final_company_available_pence: null,
        sections,
      };
    }
    if (wipeAvailable) {
      sections.company_transfer_available = {
        status: "UNAVAILABLE",
        amount_pence: null,
        currency: "GBP",
        reason_code: liability.error_code
          ?? reserved.error_code
          ?? sections.operational_reserve.reason_code
          ?? "PROTECTED_INPUTS_UNKNOWN",
      };
      companyBalance = {
        ...companyBalance,
        company_available_for_transfer_pence: null,
        final_company_available_pence: null,
        sections,
      };
    }
  }

  const company_transfer_kpis = {
    awaiting_approval_count,
    approved_payables_pending_pence,
    processing_pence,
    completed_month_pence: completed_driver_payouts_month_pence,
    completed_driver_payouts_month_pence,
    completed_company_transfers_month_pence,
    failed_count,
  };

  let driverFailed: AdminPayoutLedgerItemRow[] = [];
  if (failedOnly) {
    try {
      const failedList = await listAdminPayoutLedger(supabase, {
        ...request,
        mode: "list",
        tab: "failed",
        limit,
      });
      driverFailed = failedList.items ?? [];
    } catch (err) {
      console.warn("[admin-payout-ledger] failed driver payouts section", err);
    }
  }

  const sections = companyBalance.sections ?? {
    provider_balance: {
      status: "UNAVAILABLE" as const,
      amount_pence: null,
      currency: "GBP",
      reason_code: companyBalance.unavailable_reason,
    },
    driver_liabilities: {
      status: liability.amount_pence == null ? "ERROR" as const : "AVAILABLE" as const,
      amount_pence: liability.amount_pence,
      currency: "GBP",
      reason_code: liability.error_code,
    },
    reserved_driver_payouts: {
      status: reserved.amount_pence == null ? "ERROR" as const : "AVAILABLE" as const,
      amount_pence: reserved.amount_pence,
      currency: "GBP",
      reason_code: reserved.error_code,
    },
    approved_company_payables: {
      status: "AVAILABLE" as const,
      amount_pence: approved_payables_pending_pence,
      currency: "GBP",
      reason_code: null,
    },
    operational_reserve: {
      status: "NOT_CONFIGURED" as const,
      amount_pence: null,
      currency: "GBP",
      reason_code: "OPERATIONAL_RESERVE_NOT_CONFIGURED",
    },
    company_transfer_available: {
      status: "UNAVAILABLE" as const,
      amount_pence: null,
      currency: "GBP",
      reason_code: companyBalance.unavailable_reason,
    },
  };

  return {
    success: true,
    ok: companyBalance.status === "LIVE",
    page_status: companyBalance.status === "UNAVAILABLE" || transfersError
      ? "PARTIAL"
      : "LIVE",
    tab: failedOnly ? "failed_transfers" : "company_transfers",
    items: driverFailed,
    batches: [],
    company_transfers: transfers,
    company_balance: companyBalance,
    company_transfer_kpis,
    company_transfers_empty_copy: COMPANY_TRANSFERS_EMPTY_COPY,
    company_transfers_read_only: false,
    company_transfers_money_read_only: true,
    ...readPayoutExecutionFlags(),
    error_code: companyBalance.unavailable_reason,
    // Root-level section statuses (Slice E) — independent of nested snapshot.
    sections,
    provider_balance: sections.provider_balance,
    driver_liabilities: sections.driver_liabilities,
    reserved_driver_payouts: sections.reserved_driver_payouts,
    approved_company_payables: sections.approved_company_payables,
    operational_reserve: sections.operational_reserve,
    company_transfer_available: sections.company_transfer_available,
    error: transfersError?.message,
    summary: {
      ...emptySummary(),
      total_items: transfers.length + driverFailed.length,
      failed_count: transfers.filter((t) => t.status === "FAILED").length + driverFailed.length,
      pending_count: transfers.filter((t) => t.status === "AWAITING_APPROVAL").length,
      processing_count: transfers.filter((t) => t.status === "PROCESSING").length,
    },
  };
}

async function listCompanyBatches(
  supabase: SupabaseClient,
  request: AdminPayoutLedgerListRequest,
): Promise<AdminPayoutLedgerListResponse> {
  const limit = Math.min(200, Math.max(1, request.limit ?? 100));
  const companyBatches: CompanyOutgoingBatchRow[] = [];
  const driverBatches: AdminPayoutLedgerBatchRow[] = [];

  const { data: cBatches, error: cErr } = await supabase
    .from("company_outgoing_batches")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!cErr) {
    for (const b of cBatches ?? []) {
      companyBatches.push({
        id: String(b.id),
        batch_ref: String(b.batch_ref ?? ""),
        created_at: String(b.created_at),
        batch_type: String(b.batch_type ?? "COMPANY"),
        provider: (b.provider as string | null) ?? null,
        status: String(b.status ?? ""),
        transfer_count: Number(b.transfer_count ?? 0),
        success_count: Number(b.success_count ?? 0),
        failed_count: Number(b.failed_count ?? 0),
        started_at: (b.started_at as string | null) ?? null,
        completed_at: (b.completed_at as string | null) ?? null,
        duration_ms: b.duration_ms == null ? null : Number(b.duration_ms),
      });
    }
  } else {
    console.warn("[admin-payout-ledger] company batches read failed", cErr.message);
  }

  const { data: dBatches } = await supabase
    .from("payout_batches")
    .select(DRIVER_BATCH_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);
  const batchIds = (dBatches ?? []).map((b) => String(b.id)).filter(Boolean);
  const itemStatusByBatch = await loadBatchItemStatuses(supabase, batchIds);
  for (const b of dBatches ?? []) {
    driverBatches.push(
      mapDriverBatchRow(
        b as Record<string, unknown>,
        itemStatusByBatch.get(String(b.id)),
      ),
    );
  }

  // Item-level details for Batch History (driver payouts only — never company transfers).
  const driverItems: AdminPayoutLedgerItemRow[] = [];
  if (batchIds.length > 0) {
    try {
      const detail = await listAdminPayoutLedger(supabase, {
        mode: "list",
        tab: "history",
        limit: Math.min(200, limit * 10),
      });
      for (const item of detail.items ?? []) {
        if (item.batch_id && batchIds.includes(item.batch_id)) {
          driverItems.push(item);
        }
      }
    } catch (err) {
      console.warn("[admin-payout-ledger] batch history items failed", err);
    }
  }

  return {
    success: true,
    page_status: cErr ? "PARTIAL" : "LIVE",
    tab: "batch_history",
    items: driverItems,
    batches: driverBatches,
    company_batches: companyBatches,
    summary: {
      ...emptySummary(),
      total_items: driverBatches.length + companyBatches.length,
      completed_count: driverItems.filter((i) =>
        String(i.display_status ?? i.status).toUpperCase() === "COMPLETED"
      ).length,
    },
    error: cErr?.message,
  };
}

async function listCompanyAudit(
  supabase: SupabaseClient,
  request: AdminPayoutLedgerListRequest,
): Promise<AdminPayoutLedgerListResponse> {
  const limit = Math.min(200, Math.max(1, request.limit ?? 100));
  const { data, error } = await supabase
    .from("company_outgoing_transfer_audit")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows: CompanyOutgoingAuditRow[] = error
    ? []
    : (data ?? []).map((row) => ({
      id: String(row.id),
      created_at: String(row.created_at),
      transfer_id: String(row.transfer_id),
      actor_id: row.actor_id == null ? null : String(row.actor_id),
      event_type: String(row.event_type ?? ""),
      old_status: (row.old_status as string | null) ?? null,
      new_status: (row.new_status as string | null) ?? null,
      provider: (row.provider as string | null) ?? null,
      provider_reference: (row.provider_reference as string | null) ?? null,
      amount_pence: row.amount_pence == null ? null : Number(row.amount_pence),
      currency: (row.currency as string | null) ?? null,
      reason: (row.reason as string | null) ?? null,
      attachment_url: (row.attachment_url as string | null) ?? null,
    }));

  // Driver payout audit (separate from company transfers — never merged into company_transfers).
  let audit_rows: AdminPayoutLedgerListResponse["audit_rows"] = [];
  try {
    const { data: payoutAudit } = await supabase
      .from("payout_audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    audit_rows = (payoutAudit ?? []).map((row) => ({
      id: String(row.id),
      created_at: String(row.created_at),
      driver_id: row.driver_id == null ? null : String(row.driver_id),
      payout_type: (row.payout_type as string | null) ?? null,
      event_type: String(row.event_type ?? ""),
      requested_amount_pence: row.requested_amount_pence == null
        ? null
        : Number(row.requested_amount_pence),
      provider_error_code: (row.provider_error_code as string | null) ?? null,
      provider_error_message: (row.provider_error_message as string | null) ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    }));
  } catch (err) {
    console.warn("[admin-payout-ledger] payout_audit_log read failed", err);
  }

  // Also surface completed driver payout items in audit history for Slice 8 visibility.
  let driverItems: AdminPayoutLedgerItemRow[] = [];
  try {
    const detail = await listAdminPayoutLedger(supabase, {
      mode: "list",
      tab: "history",
      service_area_id: request.service_area_id,
      limit,
    });
    driverItems = (detail.items ?? []).filter((i) => {
      const d = String(i.display_status ?? i.status).toUpperCase();
      return d === "COMPLETED" || d === "NOT_SUBMITTED" || d === "RESERVED" || d === "SUBMITTED";
    });
  } catch (err) {
    console.warn("[admin-payout-ledger] audit driver items failed", err);
  }

  let company_funding_audit: AdminPayoutLedgerListResponse["company_funding_audit"] = [];
  try {
    const overviewBundle = await buildPayoutLedgerOverview(supabase, {
      service_area_id: request.service_area_id ?? null,
      allowed_service_area_ids: request.allowed_service_area_ids ?? null,
      limit: 1,
    });
    company_funding_audit = overviewBundle.overview_summary?.company_funding_audit ?? [];
  } catch (err) {
    console.warn("[admin-payout-ledger] company funding audit failed", err);
  }

  return {
    success: true,
    page_status: error ? "PARTIAL" : "LIVE",
    tab: "audit_history",
    items: driverItems,
    batches: [],
    company_audit_rows: rows,
    company_funding_audit,
    audit_rows,
    summary: {
      ...emptySummary(),
      total_items: rows.length + (audit_rows?.length ?? 0) + driverItems.length,
    },
    error: error?.message,
  };
}

export async function listAdminPayoutLedger(
  supabase: SupabaseClient,
  request: AdminPayoutLedgerListRequest = {},
): Promise<AdminPayoutLedgerListResponse> {
  const tab: AdminPayoutLedgerTab = request.tab ?? "overview";
  const limit = Math.min(200, Math.max(1, request.limit ?? 100));
  const mode = request.mode ?? "list";

  if (mode === "ledger_overview") {
    return buildPayoutLedgerOverview(supabase, {
      service_area_id: request.service_area_id ?? null,
      allowed_service_area_ids: request.allowed_service_area_ids ?? null,
      limit: request.limit,
    });
  }
  if (mode === "company_list" || mode === "company_failed") {
    return listCompanyTransfers(supabase, request, mode === "company_failed");
  }
  if (mode === "company_batches") {
    return listCompanyBatches(supabase, request);
  }
  if (mode === "company_audit") {
    return listCompanyAudit(supabase, request);
  }

  let itemsQuery = supabase
    .from("payout_items")
    .select(
      "id, created_at, driver_id, batch_id, amount_pence, status, execution_status, payout_type, provider_payout_id, provider_transfer_id, provider_reference, provider_status, failure_reason, error_message, ledger_entry_id, completed_at, failed_at, updated_at, gross_amount_pence, net_driver_payout_pence, onecab_fee_pence, provider_fee_pence, trip_id",
    )
    .order("created_at", { ascending: false })
    .limit(limit * 2);

  if (request.driver_id) itemsQuery = itemsQuery.eq("driver_id", request.driver_id);
  if (request.batch_id) itemsQuery = itemsQuery.eq("batch_id", request.batch_id);
  if (request.status) itemsQuery = itemsQuery.eq("status", request.status);
  if (request.date_from) itemsQuery = itemsQuery.gte("created_at", request.date_from);
  if (request.date_to) itemsQuery = itemsQuery.lte("created_at", request.date_to);

  const { data: rawItems, error: itemsError } = await itemsQuery;
  if (itemsError) {
    console.warn("[admin-payout-ledger] payout_items read failed", itemsError.message);
    return {
      success: true,
      page_status: "PARTIAL",
      tab,
      items: [],
      batches: [],
      error_code: "PAYOUT_ITEMS_READ_FAILED",
      error: itemsError.message,
      summary: emptySummary(),
    };
  }

  const driverIds = [...new Set((rawItems ?? []).map((i) => i.driver_id).filter(Boolean))] as string[];
  const driverNameById = new Map<string, string>();
  const driverServiceAreaById = new Map<string, string | null>();
  const driverMetaById = new Map<string, {
    connected_account_id: string | null;
    verification_status: string | null;
  }>();
  const bankLast4ByDriver = new Map<string, string | null>();
  if (driverIds.length > 0) {
    const [{ data: drivers }, { data: destinations }] = await Promise.all([
      supabase
        .from("drivers")
        .select("id, first_name, last_name, service_area_id, payouts_enabled, charges_enabled, onboarding_complete")
        .in("id", driverIds),
      supabase
        .from("driver_payout_destinations")
        .select("driver_id, provider, status, provider_counterparty_id, provider_recipient_account_id, updated_at")
        .in("driver_id", driverIds)
        .order("updated_at", { ascending: false })
        .limit(200),
    ]);
    const destinationByDriver = new Map<string, {
      provider: string | null;
      status: string | null;
      counterparty_id: string | null;
    }>();
    for (const dest of destinations ?? []) {
      const did = String(dest.driver_id ?? "");
      if (!did || destinationByDriver.has(did)) continue;
      destinationByDriver.set(did, {
        provider: dest.provider == null ? null : String(dest.provider),
        status: dest.status == null ? null : String(dest.status),
        counterparty_id: dest.provider_counterparty_id == null
          ? null
          : String(dest.provider_counterparty_id),
      });
    }
    for (const d of drivers ?? []) {
      const name = [d.first_name, d.last_name].filter(Boolean).join(" ").trim() || null;
      if (name) driverNameById.set(String(d.id), name);
      driverServiceAreaById.set(String(d.id), (d.service_area_id as string | null) ?? null);
      const dest = destinationByDriver.get(String(d.id));
      const destStatus = String(dest?.status ?? "").toLowerCase();
      const hasDest = Boolean(dest?.counterparty_id);
      let verificationStatus: string | null = null;
      if (!hasDest) verificationStatus = "not_connected";
      else if (destStatus === "verified" || destStatus === "active" || destStatus === "ready") {
        verificationStatus = "verified";
      } else if (d.onboarding_complete || d.charges_enabled || d.payouts_enabled) {
        verificationStatus = "restricted";
      } else {
        verificationStatus = "pending";
      }
      driverMetaById.set(String(d.id), {
        connected_account_id: dest?.counterparty_id ?? null,
        verification_status: verificationStatus,
      });
      bankLast4ByDriver.set(String(d.id), null);
    }
  }

  const serviceAreaIds = [
    ...new Set([...driverServiceAreaById.values()].filter(Boolean)),
  ] as string[];
  const serviceAreaNameById = new Map<string, string>();
  if (serviceAreaIds.length > 0) {
    const { data: areas } = await supabase
      .from("service_areas")
      .select("id, name")
      .in("id", serviceAreaIds);
    for (const a of areas ?? []) {
      if (a.name) serviceAreaNameById.set(String(a.id), String(a.name));
    }
  }

  const itemIds = (rawItems ?? []).map((i) => String(i.id));
  const allocationCountByItem = new Map<string, number>();
  if (itemIds.length > 0) {
    const { data: allocs } = await supabase
      .from("payout_item_ledger_allocations")
      .select("payout_item_id")
      .in("payout_item_id", itemIds);
    for (const a of allocs ?? []) {
      const id = String(a.payout_item_id ?? "");
      if (!id) continue;
      allocationCountByItem.set(id, (allocationCountByItem.get(id) ?? 0) + 1);
    }
  }

  const reservationByItem = new Map<string, {
    status: string;
    release_reason: string | null;
    debit_ledger_entry_id: string | null;
  }>();
  if (itemIds.length > 0) {
    const { data: resRows } = await supabase
      .from("driver_payout_reservations")
      .select("payout_item_id, status, release_reason, debit_ledger_entry_id")
      .in("payout_item_id", itemIds);
    for (const r of resRows ?? []) {
      const id = String(r.payout_item_id ?? "");
      if (!id || reservationByItem.has(id)) continue;
      reservationByItem.set(id, {
        status: String(r.status ?? ""),
        release_reason: r.release_reason == null ? null : String(r.release_reason),
        debit_ledger_entry_id: r.debit_ledger_entry_id == null
          ? null
          : String(r.debit_ledger_entry_id),
      });
    }
  }

  const platformDriverIds = (request.service_area_id || request.allowed_service_area_ids)
    ? await resolvePlatformCollectedDriverIds(supabase, {
      service_area_id: request.service_area_id ?? null,
      allowed_service_area_ids: request.allowed_service_area_ids ?? [],
    })
    : null;
  const platformDriverSet = platformDriverIds ? new Set(platformDriverIds) : null;

  const items: AdminPayoutLedgerItemRow[] = [];
  for (const raw of rawItems ?? []) {
    const status = normaliseStatus(raw.status as string | null);
    if (!itemMatchesTab(String(raw.status ?? ""), tab)) continue;
    if (request.payout_type) {
      const type = String(raw.payout_type ?? "");
      if (type.toLowerCase() !== request.payout_type.toLowerCase()) continue;
    }
    if (platformDriverSet && !platformDriverSet.has(String(raw.driver_id))) continue;
    else if (request.service_area_id) {
      const sa = driverServiceAreaById.get(String(raw.driver_id)) ?? null;
      if (sa !== request.service_area_id) continue;
    }

    const amount = raw.amount_pence == null
      ? (raw.gross_amount_pence == null ? null : Number(raw.gross_amount_pence))
      : Number(raw.amount_pence);
    const fees = raw.onecab_fee_pence != null || raw.provider_fee_pence != null
      ? Number(raw.onecab_fee_pence ?? 0) + Number(raw.provider_fee_pence ?? 0)
      : null;
    const net = raw.net_driver_payout_pence == null ? amount : Number(raw.net_driver_payout_pence);
    const statusLower = String(raw.status ?? "").toLowerCase();
    const processingStartedAt = PROCESSING.has(statusLower)
      ? (raw.updated_at as string | null) ?? (raw.created_at as string | null)
      : COMPLETED.has(statusLower) || FAILED.has(statusLower)
      ? (raw.updated_at as string | null)
      : null;
    const serviceAreaId = driverServiceAreaById.get(String(raw.driver_id)) ?? null;
    const meta = driverMetaById.get(String(raw.driver_id));
    const reservation = reservationByItem.get(String(raw.id)) ?? null;
    const reservationStatus = reservation?.status ?? null;
    const releaseReason = reservation?.release_reason ?? null;
    const walletLedgerEntryId = (raw.ledger_entry_id as string | null) ?? null;
    const failureReason = (raw.failure_reason as string | null)
      ?? (raw.error_message as string | null)
      ?? null;
    const presentation = resolveDriverPayoutItemDisplayPresentation({
      status: raw.status as string | null,
      execution_status: raw.execution_status as string | null,
      completed_at: raw.completed_at as string | null,
      paid_at: raw.completed_at as string | null,
      reservation_status: reservationStatus,
      wallet_ledger_entry_id: walletLedgerEntryId,
      debit_ledger_entry_id: reservation?.debit_ledger_entry_id ?? null,
      release_reason: releaseReason,
      failure_reason: failureReason ?? releaseReason,
    });

    items.push({
      id: String(raw.id),
      created_at: String(raw.created_at),
      driver_id: String(raw.driver_id),
      driver_name: driverNameById.get(String(raw.driver_id)) ?? null,
      service_area_id: serviceAreaId,
      service_area_name: serviceAreaId ? (serviceAreaNameById.get(serviceAreaId) ?? null) : null,
      payout_type: (raw.payout_type as string | null) ?? null,
      batch_id: (raw.batch_id as string | null) ?? null,
      gross_wallet_debit_pence: amount,
      fees_pence: fees,
      net_bank_transfer_pence: net,
      currency: "GBP",
      provider: "revolut_or_manual",
      provider_payout_id: (raw.provider_payout_id as string | null)
        ?? (raw.provider_transfer_id as string | null)
        ?? (raw.provider_reference as string | null)
        ?? null,
      bank_reference: (raw.provider_reference as string | null) ?? null,
      verification_status: meta?.verification_status ?? null,
      bank_account_last4: bankLast4ByDriver.get(String(raw.driver_id)) ?? null,
      connected_account_id: meta?.connected_account_id ?? null,
      status,
      display_status: presentation.display_status,
      display_status_label: presentation.display_status_label,
      display_supporting_text: presentation.supporting_text,
      display_reason_label: presentation.reason_label,
      included_in_live_wallet: presentation.included_in_live_wallet,
      execution_status: (raw.execution_status as string | null) ?? null,
      reservation_status: reservationStatus,
      release_reason: releaseReason,
      processing_started_at: processingStartedAt,
      paid_at: (raw.completed_at as string | null) ?? null,
      failure_reason: failureReason,
      wallet_ledger_entry_id: walletLedgerEntryId,
      allocation_count: allocationCountByItem.get(String(raw.id)) ?? 0,
      action_policy: actionPolicyForStatus(String(raw.status ?? "")),
    });
  }

  const { data: rawBatches, error: batchesError } = await supabase
    .from("payout_batches")
    .select(DRIVER_BATCH_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (batchesError) {
    console.warn("[admin-payout-ledger] payout_batches read failed", batchesError.message);
  }

  const listBatchIds = (rawBatches ?? []).map((b) => String(b.id)).filter(Boolean);
  const listItemStatuses = await loadBatchItemStatuses(supabase, listBatchIds);
  const batches: AdminPayoutLedgerBatchRow[] = (rawBatches ?? []).map((b) =>
    mapDriverBatchRow(
      b as Record<string, unknown>,
      listItemStatuses.get(String(b.id)),
    )
  );

  const sliced = items.slice(0, limit);

  // Calendar KPIs from a wider window (not the page slice).
  let kpiQuery = supabase
    .from("payout_items")
    .select("id, driver_id, status, amount_pence, net_driver_payout_pence, created_at, completed_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (request.driver_id) kpiQuery = kpiQuery.eq("driver_id", request.driver_id);
  if (request.batch_id) kpiQuery = kpiQuery.eq("batch_id", request.batch_id);
  const { data: kpiRaw } = await kpiQuery;

  let kpiDriverSa = driverServiceAreaById;
  if (request.service_area_id && (kpiRaw?.length ?? 0) > 0) {
    const missing = [...new Set((kpiRaw ?? []).map((i) => String(i.driver_id)).filter((id) => !kpiDriverSa.has(id)))];
    if (missing.length > 0) {
      const { data: moreDrivers } = await supabase
        .from("drivers")
        .select("id, service_area_id")
        .in("id", missing);
      kpiDriverSa = new Map(kpiDriverSa);
      for (const d of moreDrivers ?? []) {
        kpiDriverSa.set(String(d.id), (d.service_area_id as string | null) ?? null);
      }
    }
  }

  const kpiRows = (kpiRaw ?? []).filter((r) => {
    if (platformDriverSet) return platformDriverSet.has(String(r.driver_id));
    if (!request.service_area_id) return true;
    return (kpiDriverSa.get(String(r.driver_id)) ?? null) === request.service_area_id;
  });

  const todayStart = londonDayStartIso();
  const weekStart = londonWeekStartIso();
  const monthStart = londonMonthStartIso();
  const yearStart = londonYearStartIso();

  const amountOf = (r: { amount_pence?: number | null; net_driver_payout_pence?: number | null }) =>
    Number(r.net_driver_payout_pence ?? r.amount_pence ?? 0);

  let scheduledCount = 0;
  let processingCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let returnedCount = 0;
  let scheduledToday = 0;
  let paidToday = 0;
  let paidTodayPence = 0;
  let paidWeek = 0;
  let paidMonth = 0;
  let paidYear = 0;
  let totalPaid = 0;
  let totalFailed = 0;

  for (const r of kpiRows) {
    const st = String(r.status ?? "").toLowerCase();
    const created = String(r.created_at ?? "");
    const paidAt = String(r.completed_at ?? r.created_at ?? "");
    const amt = amountOf(r);
    if (SCHEDULED.has(st)) {
      scheduledCount += 1;
      if (created >= todayStart) scheduledToday += 1;
    }
    if (PROCESSING.has(st)) processingCount += 1;
    if (COMPLETED.has(st)) {
      completedCount += 1;
      totalPaid += amt;
      if (paidAt >= todayStart) {
        paidToday += 1;
        paidTodayPence += amt;
      }
      if (paidAt >= weekStart) paidWeek += amt;
      if (paidAt >= monthStart) paidMonth += amt;
      if (paidAt >= yearStart) paidYear += amt;
    }
    if (FAILED.has(st)) {
      failedCount += 1;
      totalFailed += amt;
    }
    if (RETURNED_CANCELLED.has(st)) returnedCount += 1;
  }

  return {
    success: true,
    page_status: "LIVE",
    tab,
    items: sliced,
    batches: tab === "batches" || tab === "overview" || tab === "history" ? batches : [],
    ...readPayoutExecutionFlags(),
    summary: {
      total_items: kpiRows.length,
      scheduled_count: scheduledCount,
      processing_count: processingCount,
      completed_count: completedCount,
      failed_count: failedCount,
      returned_cancelled_count: returnedCount,
      pending_count: scheduledCount,
      scheduled_today_count: scheduledToday,
      paid_today_count: paidToday,
      paid_today_pence: paidToday > 0 ? paidTodayPence : null,
      total_paid_pence: completedCount > 0 ? totalPaid : null,
      total_failed_pence: failedCount > 0 ? totalFailed : null,
      total_paid_week_pence: paidWeek > 0 ? paidWeek : null,
      total_paid_month_pence: paidMonth > 0 ? paidMonth : null,
      total_paid_year_pence: paidYear > 0 ? paidYear : null,
    },
  };
}
