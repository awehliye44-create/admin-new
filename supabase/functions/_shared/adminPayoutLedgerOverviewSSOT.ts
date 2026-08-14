/**
 * Payout Ledger Overview builder — fast DWL rollup + payout_items + company balance SSOT.
 * Partial failure: driver widgets still return when company balance is unavailable.
 * Never waits forever on per-driver eligibility (timeout → PARTIAL, not blank page).
 */
// deno-lint-ignore no-explicit-any
type AnySupabase = any;

import type { AdminPayoutLedgerListResponse } from "../../../shared/adminPayoutLedgerSSOT.ts";
import {
  emptyPayoutLedgerOverviewDto,
  finalisePayoutLedgerOverviewStatus,
  PAYOUT_LEDGER_ERROR,
} from "../../../shared/payoutLedgerOverviewSSOT.ts";
import { fetchDriverPayoutEligibility } from "./fetchDriverPayoutEligibility.ts";
import { computeCashCommissionOutstanding, computeLedgerWalletBalancePence } from "./onecabFinanceLedger.ts";
import { loadPayoutControlCentreSettings } from "./payoutControlCentreSettingsSSOT.ts";
import { buildPayoutScheduleDto } from "./payoutScheduleSSOT.ts";
import { resolveLiveCompanyBalanceWithSlice10Gate } from "./companyBalanceResolveSSOT.ts";
import {
  buildCompanyFundingAuditRows,
  PAYMENT_SESSIONS_NET_COMMISSION_SOURCE,
} from "../../../shared/payoutLedgerCompanyFundingSSOT.ts";

export { resolveLiveCompanyBalanceSnapshot } from "./companyBalanceResolveSSOT.ts";

const PROCESSING = new Set(["processing", "in_progress", "submitted", "pending_provider"]);
const SCHEDULED = new Set(["pending", "scheduled", "queued", "on_hold", "ready"]);
const COMPLETED = new Set(["completed", "paid", "succeeded"]);
const FAILED = new Set(["failed", "error", "ledger_sync_failed", "failed_duplicate"]);

const DRIVER_SECTION_BUDGET_MS = 8_000;

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

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms) as unknown as number;
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/**
 * Fast driver wallet section:
 * 1) ledger live/debt from bulk DWL rows
 * 2) eligibility only for drivers with non-zero live or debt
 */
async function loadDriverOverviewSection(
  supabase: AnySupabase,
  args: { service_area_id: string | null },
): Promise<{
  driver_wallet_total_pence: number;
  driver_available_pence: number;
  driver_pending_pence: number;
  driver_debt_pence: number;
  eligible_driver_count: number;
  held_driver_count: number;
  next_driver_batch_amount_pence: number;
  next_driver_batch_count: number;
}> {
  let driverQuery = supabase
    .from("drivers")
    .select("id, payouts_enabled")
    .order("created_at", { ascending: false })
    .limit(500);
  if (args.service_area_id) {
    const { data: links } = await supabase
      .from("driver_service_areas")
      .select("driver_id")
      .eq("service_area_id", args.service_area_id);
    const ids = [...new Set((links ?? []).map((r: { driver_id: string }) => String(r.driver_id)).filter(Boolean))];
    if (ids.length === 0) {
      return {
        driver_wallet_total_pence: 0,
        driver_available_pence: 0,
        driver_pending_pence: 0,
        driver_debt_pence: 0,
        eligible_driver_count: 0,
        held_driver_count: 0,
        next_driver_batch_amount_pence: 0,
        next_driver_batch_count: 0,
      };
    }
    driverQuery = driverQuery.in("id", ids);
  }

  const { data: drivers, error } = await driverQuery;
  if (error) throw error;
  const driverIds = (drivers ?? []).map((d: { id: string }) => String(d.id)).filter(Boolean);
  if (driverIds.length === 0) {
    return {
      driver_wallet_total_pence: 0,
      driver_available_pence: 0,
      driver_pending_pence: 0,
      driver_debt_pence: 0,
      eligible_driver_count: 0,
      held_driver_count: 0,
      next_driver_batch_amount_pence: 0,
      next_driver_batch_count: 0,
    };
  }

  const { data: ledgerRows } = await supabase
    .from("driver_wallet_ledger")
    .select("driver_id, type, amount_pence")
    .in("driver_id", driverIds);

  const byDriver = new Map<string, Array<{ type?: string | null; amount_pence?: number | null }>>();
  for (const row of ledgerRows ?? []) {
    const id = String(row.driver_id ?? "");
    if (!id) continue;
    const list = byDriver.get(id) ?? [];
    list.push(row);
    byDriver.set(id, list);
  }

  const candidates: string[] = [];
  let liveTotal = 0;
  let debtTotal = 0;
  for (const d of drivers ?? []) {
    const id = String(d.id);
    const rows = byDriver.get(id) ?? [];
    const live = computeLedgerWalletBalancePence(rows);
    const debt = computeCashCommissionOutstanding(rows);
    liveTotal += Math.max(0, live);
    debtTotal += Math.max(0, debt);
    if (live !== 0 || debt > 0) candidates.push(id);
  }

  let available = 0;
  let pending = 0;
  let eligible = 0;
  let held = 0;
  let nextBatch = 0;
  let nextDrivers = 0;

  // Eligibility only for non-zero wallets (typically a handful).
  for (const driverId of candidates.slice(0, 40)) {
    try {
      const elig = await fetchDriverPayoutEligibility(supabase, { driver_id: driverId });
      const avail = Math.max(0, elig.available_balance_pence);
      const pend = Math.max(0, elig.pending_balance_pence);
      const live = Math.round(elig.live_balance_pence);
      available += avail;
      pending += pend;
      const paused = (drivers ?? []).find((d: { id: string }) => String(d.id) === driverId)?.payouts_enabled === false;
      if (avail > 0 && !paused) {
        eligible += 1;
        nextBatch += avail;
        nextDrivers += 1;
      } else if (live > 0 && avail <= 0) {
        held += 1;
      }
    } catch (err) {
      console.warn("[admin-payout-ledger] overview eligibility failed", {
        driver_id: driverId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    driver_wallet_total_pence: liveTotal,
    driver_available_pence: available,
    driver_pending_pence: pending,
    driver_debt_pence: debtTotal,
    eligible_driver_count: eligible,
    held_driver_count: held,
    next_driver_batch_amount_pence: nextBatch,
    next_driver_batch_count: nextDrivers,
  };
}

/** Same SSOT as Driver Payouts tab / fleet.total_reserved_pence: ACTIVE reservations only. */
async function loadActiveReservedDriverPayoutPence(
  supabase: AnySupabase,
  service_area_id: string | null,
): Promise<number> {
  let query = supabase
    .from("driver_payout_reservations")
    .select("driver_id, amount_pence")
    .eq("status", "ACTIVE")
    .limit(5000);
  const { data: rows, error } = await query;
  if (error) throw error;
  let reservedRows = rows ?? [];
  if (service_area_id && reservedRows.length > 0) {
    const ids = [...new Set(reservedRows.map((r: { driver_id: string }) => String(r.driver_id)).filter(Boolean))];
    const { data: links } = await supabase
      .from("driver_service_areas")
      .select("driver_id")
      .eq("service_area_id", service_area_id)
      .in("driver_id", ids);
    const allowed = new Set((links ?? []).map((r: { driver_id: string }) => String(r.driver_id)));
    reservedRows = reservedRows.filter((r: { driver_id: string }) => allowed.has(String(r.driver_id)));
  }
  let reserved = 0;
  for (const r of reservedRows) {
    reserved += Math.max(0, Number(r.amount_pence ?? 0));
  }
  return reserved;
}

async function loadPayoutItemSection(supabase: AnySupabase, service_area_id: string | null): Promise<{
  payout_scheduled_pence: number;
  payout_processing_pence: number;
  payout_paid_today_pence: number;
  payout_paid_week_pence: number;
  payout_paid_month_pence: number;
  payout_failed_count: number;
  processing_count: number;
}> {
  // payout_items has no paid_at column — selecting it fails the whole query (POST–Slice-8 SSOT bug).
  const { data: items, error: itemsErr } = await supabase
    .from("payout_items")
    .select("status, amount_pence, net_driver_payout_pence, completed_at, created_at, updated_at, driver_id, execution_status")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (itemsErr) throw itemsErr;

  let rows = items ?? [];
  if (service_area_id && rows.length > 0) {
    const ids = [...new Set(rows.map((r) => String(r.driver_id)).filter(Boolean))];
    const { data: drivers } = await supabase.from("drivers").select("id, service_area_id").in("id", ids);
    const sa = new Map((drivers ?? []).map((d: { id: string; service_area_id: string | null }) => [String(d.id), d.service_area_id ?? null]));
    rows = rows.filter((r) => (sa.get(String(r.driver_id)) ?? null) === service_area_id);
  }

  const dayStart = londonDayStartIso();
  const weekStart = londonWeekStartIso();
  const monthStart = londonMonthStartIso();
  let scheduled = 0;
  let processing = 0;
  let paidToday = 0;
  let paidWeek = 0;
  let paidMonth = 0;
  let failed = 0;
  let processingCount = 0;

  for (const row of rows) {
    const st = String(row.status ?? "").toLowerCase();
    const amt = Math.max(0, Number(row.net_driver_payout_pence ?? row.amount_pence ?? 0));
    if (SCHEDULED.has(st)) scheduled += amt;
    else if (PROCESSING.has(st)) {
      processing += amt;
      processingCount += 1;
    } else if (COMPLETED.has(st) || String(row.execution_status ?? "").toLowerCase() === "completed") {
      const paidAt = String(row.completed_at ?? row.updated_at ?? row.created_at ?? "");
      if (paidAt >= dayStart) paidToday += amt;
      if (paidAt >= weekStart) paidWeek += amt;
      if (paidAt >= monthStart) paidMonth += amt;
    } else if (FAILED.has(st)) failed += 1;
  }

  return {
    payout_scheduled_pence: scheduled,
    payout_processing_pence: processing,
    payout_paid_today_pence: paidToday,
    payout_paid_week_pence: paidWeek,
    payout_paid_month_pence: paidMonth,
    payout_failed_count: failed,
    processing_count: processingCount,
  };
}

export async function buildPayoutLedgerOverview(
  supabase: AnySupabase,
  args?: {
    service_area_id?: string | null;
    limit?: number;
    currency?: string | null;
  },
): Promise<AdminPayoutLedgerListResponse> {
  void args?.limit;
  const service_area_id = args?.service_area_id ?? null;
  const currency = String(args?.currency ?? "GBP").toUpperCase();
  let dto = emptyPayoutLedgerOverviewDto({
    service_area_id,
    currency,
    status: "LIVE",
    unavailable_reason: null,
  });
  dto.unavailable_reason = null;
  dto.section_errors = [];
  dto.evidence_status = "LIVE";

  // --- Driver wallet (fast path + hard budget — never blank the page) ---
  try {
    const driverSection = await withTimeout(
      loadDriverOverviewSection(supabase, { service_area_id }),
      DRIVER_SECTION_BUDGET_MS,
      "DRIVER_OVERVIEW",
    );
    dto.driver_wallet_total_pence = driverSection.driver_wallet_total_pence;
    dto.driver_available_pence = driverSection.driver_available_pence;
    dto.driver_debt_pence = driverSection.driver_debt_pence;
    dto.eligible_driver_count = driverSection.eligible_driver_count;
    dto.held_driver_count = driverSection.held_driver_count;
    dto.next_driver_batch_amount_pence = driverSection.next_driver_batch_amount_pence;
    dto.next_driver_batch_count = driverSection.next_driver_batch_count;

    // Split pending: reserved (ACTIVE) vs other holds — never double-count.
    let reserved = 0;
    try {
      reserved = await loadActiveReservedDriverPayoutPence(supabase, service_area_id);
      dto.driver_reserved_pence = reserved;
    } catch (resErr) {
      console.warn("[admin-payout-ledger] reserved overview failed", resErr);
      dto.driver_reserved_pence = null;
      dto.section_errors.push("RESERVED_DRIVER_PAYOUTS_QUERY_FAILED");
    }
    const combinedPending = Math.max(0, driverSection.driver_pending_pence);
    if (dto.driver_reserved_pence != null) {
      dto.driver_pending_pence = Math.max(0, combinedPending - reserved);
    } else {
      dto.driver_pending_pence = combinedPending;
    }
  } catch (err) {
    console.warn("[admin-payout-ledger] driver overview failed", err);
    dto.section_errors.push(PAYOUT_LEDGER_ERROR.DRIVER_WALLET_SOURCE_UNAVAILABLE);
  }

  try {
    const payoutSection = await loadPayoutItemSection(supabase, service_area_id);
    dto.payout_scheduled_pence = payoutSection.payout_scheduled_pence;
    dto.payout_processing_pence = payoutSection.payout_processing_pence;
    dto.payout_paid_today_pence = payoutSection.payout_paid_today_pence;
    dto.payout_paid_week_pence = payoutSection.payout_paid_week_pence;
    dto.payout_paid_month_pence = payoutSection.payout_paid_month_pence;
    dto.payout_failed_count = payoutSection.payout_failed_count;
  } catch (err) {
    console.warn("[admin-payout-ledger] payout items overview failed", err);
    dto.section_errors.push("PAYOUT_ITEMS_READ_FAILED");
  }

  let schedule = buildPayoutScheduleDto({
    service_area_id,
    currencyCode: currency,
  });
  try {
    const settings = await loadPayoutControlCentreSettings(supabase);
    let saTimezone: string | null = null;
    if (service_area_id) {
      const { data: sa } = await supabase
        .from("service_areas")
        .select("timezone, currency_code")
        .eq("id", service_area_id)
        .maybeSingle();
      saTimezone = (sa?.timezone as string | null) ?? null;
    }
    schedule = buildPayoutScheduleDto({
      service_area_id,
      serviceAreaTimezone: saTimezone,
      currencyCode: currency,
      automatic_payouts_enabled: settings.payouts_enabled,
      frequency: settings.payout_frequency,
      weekly_day: settings.weekly_payout_day,
      local_processing_time: settings.payout_processing_time,
    });
  } catch (err) {
    console.warn("[admin-payout-ledger] schedule SSOT failed", err);
  }
  dto.next_scheduled_weekly_driver_payout_at = schedule.next_run_at_utc;

  // --- Company transfers aggregates (not company cash balance) ---
  let companyAwaiting = 0;
  let companyPayablesPending = 0;
  let companyProcessing = 0;
  let companyPaidToday = 0;
  let companyFailed = 0;
  const todayStart = londonDayStartIso();
  try {
    let companyQuery = supabase
      .from("company_outgoing_transfers")
      .select("status, amount_pence, execution_at, updated_at, created_at, service_area_id")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (service_area_id) companyQuery = companyQuery.eq("service_area_id", service_area_id);
    const { data: companyRows, error: companyErr } = await companyQuery;
    if (companyErr) {
      console.warn("[admin-payout-ledger] company transfers overview failed", companyErr.message);
      dto.section_errors.push("COMPANY_TRANSFERS_READ_FAILED");
    } else {
      for (const row of companyRows ?? []) {
        const st = String(row.status ?? "").toUpperCase();
        const amt = Math.max(0, Number(row.amount_pence ?? 0));
        if (st === "AWAITING_APPROVAL") {
          companyAwaiting += 1;
          companyPayablesPending += amt;
        } else if (st === "APPROVED") {
          companyPayablesPending += amt;
        } else if (st === "PROCESSING" || st === "SCHEDULED") {
          companyProcessing += amt;
        } else if (st === "PAID" || st === "COMPLETED") {
          const paidAt = String(row.execution_at ?? row.updated_at ?? row.created_at ?? "");
          if (paidAt >= todayStart) companyPaidToday += amt;
        } else if (st === "FAILED") {
          companyFailed += 1;
        }
      }
      dto.company_payables_pending_pence = companyPayablesPending;
      dto.company_transfers_processing_pence = companyProcessing;
      dto.company_transfers_paid_today_pence = companyPaidToday;
      dto.company_transfers_failed_count = companyFailed;
      dto.company_awaiting_approval_count = companyAwaiting;
    }
  } catch (err) {
    console.warn("[admin-payout-ledger] company transfers overview failed", err);
    dto.section_errors.push("COMPANY_TRANSFERS_READ_FAILED");
  }

  // Slice 10: ACTIVE reserve + classified PS net commission (fail-closed; never invent £0).
  const companyBalance = await resolveLiveCompanyBalanceWithSlice10Gate({
    supabase,
    service_area_id,
    currency,
    approved_payables_pending_pence: dto.company_payables_pending_pence,
    driver_liability_pence: dto.driver_wallet_total_pence,
    driver_payout_reserved_pence: dto.driver_reserved_pence,
    customer_refund_reserved_pence: null,
  });
  dto.company_balance = companyBalance;
  dto.company_balance_pence = companyBalance.company_ledger_balance_pence;
  dto.company_available_for_transfer_pence = companyBalance.company_available_for_transfer_pence;

  const netCommissionPence = companyBalance.classified_company_cash_pence ?? null;
  dto.sources = {
    ...dto.sources,
    payment_sessions_net_commission: PAYMENT_SESSIONS_NET_COMMISSION_SOURCE,
  };
  if (netCommissionPence == null) {
    dto.section_errors.push("PAYMENT_SESSIONS_NET_COMMISSION_UNAVAILABLE");
  }

  const classifiedRows = buildCompanyFundingAuditRows({
    company_available_before_operational_reserve_pence:
      companyBalance.company_available_before_operational_reserve_pence,
    onecab_net_commission_available_pence: netCommissionPence,
  });
  dto.onecab_net_commission_available_pence = netCommissionPence;
  dto.other_company_owned_cash_pence = classifiedRows.find((r) => r.kind === "UNATTRIBUTED_CASH")
    ?.amount_pence ?? null;
  dto.company_funding_audit = classifiedRows;

  if (companyBalance.status === "UNAVAILABLE") {
    dto.section_errors.push(
      companyBalance.unavailable_reason ?? PAYOUT_LEDGER_ERROR.COMPANY_BALANCE_SOURCE_UNAVAILABLE,
    );
  }

  dto = finalisePayoutLedgerOverviewStatus(dto);

  const legacy = {
    driver_payouts_pending_pence: dto.driver_pending_pence ?? 0,
    driver_payouts_scheduled_pence: dto.payout_scheduled_pence ?? 0,
    driver_payouts_completed_today_pence: dto.payout_paid_today_pence ?? 0,
    company_transfers_pending_pence: dto.company_payables_pending_pence ?? 0,
    company_transfers_completed_today_pence: dto.company_transfers_paid_today_pence ?? 0,
    failed_transfers_count: (dto.payout_failed_count ?? 0) + (dto.company_transfers_failed_count ?? 0),
    awaiting_approval_count: dto.company_awaiting_approval_count ?? 0,
    next_scheduled_weekly_driver_payout_at: dto.next_scheduled_weekly_driver_payout_at,
  };

  return {
    success: true,
    page_status: dto.status === "LIVE" ? "LIVE" : dto.status === "PARTIAL" ? "PARTIAL" : "DEGRADED",
    tab: "overview",
    items: [],
    batches: [],
    overview_summary: {
      ...legacy,
      ...dto,
      schedule_label: schedule.schedule_label,
      next_run_at_local: schedule.next_run_at_local,
      payout_schedule: schedule,
    } as AdminPayoutLedgerListResponse["overview_summary"],
    company_balance: companyBalance,
    payout_schedule: schedule,
    error_code: dto.unavailable_reason,
    summary: {
      ...emptySummary(),
      processing_count: (dto.payout_processing_pence ?? 0) > 0 ? 1 : 0,
      failed_count: (dto.payout_failed_count ?? 0) + (dto.company_transfers_failed_count ?? 0),
      pending_count: dto.company_awaiting_approval_count ?? 0,
      paid_today_pence: dto.payout_paid_today_pence,
      total_paid_pence: dto.payout_paid_today_pence,
      total_paid_week_pence: dto.payout_paid_week_pence,
      total_paid_month_pence: dto.payout_paid_month_pence,
      total_available_pence: dto.driver_available_pence ?? undefined,
      next_batch_amount_pence: dto.next_driver_batch_amount_pence ?? undefined,
      next_batch_driver_count: dto.next_driver_batch_count ?? undefined,
    },
  };
}

export { londonDayStartIso, londonWeekStartIso, londonMonthStartIso };
