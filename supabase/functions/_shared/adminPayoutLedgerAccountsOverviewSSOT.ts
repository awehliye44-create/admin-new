/**
 * Payout Ledger accounts overview.
 * Available / Pending / Reserved / Live come from the reservation formula
 * (SQL driver_wallet_eligibility_balances) — the same source the Driver Wallet
 * Ledger overlays. TS eligibility only explains entries and hold reasons.
 * Never recalculates earnings / debt / available independently in the UI.
 */
// deno-lint-ignore no-explicit-any
type AnySupabase = any;

import type {
  AdminPayoutLedgerFleetSummary,
  AdminPayoutLedgerListResponse,
  DriverPayoutAccountRow,
} from "./adminPayoutLedgerSSOT.ts";
import { fetchDriverPayoutEligibilityContext } from "./fetchDriverPayoutEligibility.ts";
import { fetchDriverWalletEligibilityBalancesRpc } from "./driverWalletEligibilityBalancesRpc.ts";
import {
  londonPaidPeriodStarts,
  loadUnrecordedCashoutFeePenceByDriver,
  payoutAccountNotScheduledNote,
  resolvePayoutAccountComposition,
} from "./payoutAccountCompositionSSOT.ts";
import { shouldBlockZeroValuePayoutBatch } from "./driverPayoutEligibilitySSOT.ts";
import { loadPayoutControlCentreSettings } from "./payoutControlCentreSettingsSSOT.ts";
import { buildPayoutScheduleDto } from "./payoutScheduleSSOT.ts";
import { resolvePlatformCollectedDriverIds } from "./platformCollectedDriverScope.ts";

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
    total_available_pence: 0,
    next_batch_amount_pence: 0,
    next_batch_driver_count: 0,
  };
}

function emptyFleet(): AdminPayoutLedgerFleetSummary {
  return {
    total_live_wallet_pence: 0,
    total_available_pence: 0,
    total_reserved_pence: 0,
    total_pending_pence: 0,
    total_outstanding_debt_pence: 0,
    total_scheduled_pence: 0,
    total_processing_pence: 0,
    paid_today_pence: 0,
    paid_week_pence: 0,
    paid_month_pence: 0,
    paid_year_pence: 0,
    failed_count: 0,
    paused_accounts: 0,
    unverified_accounts: 0,
    next_batch_amount_pence: 0,
    next_batch_driver_count: 0,
    eligible_driver_count: 0,
    held_driver_count: 0,
    scheduled_payouts_count: 0,
    processing_payouts_count: 0,
    completed_payouts_count: 0,
    zero_batch_guard: "NO_ELIGIBLE_PAYOUTS",
  };
}

async function loadPayoutItemStatusTotals(
  supabase: AnySupabase,
  platformDriverIds: readonly string[],
): Promise<{
  scheduled_pence: number;
  processing_pence: number;
  paid_today_pence: number;
  paid_week_pence: number;
  paid_month_pence: number;
  paid_year_pence: number;
  failed_count: number;
  scheduled_count: number;
  processing_count: number;
  completed_count: number;
}> {
  const empty = {
    scheduled_pence: 0,
    processing_pence: 0,
    paid_today_pence: 0,
    paid_week_pence: 0,
    paid_month_pence: 0,
    paid_year_pence: 0,
    failed_count: 0,
    scheduled_count: 0,
    processing_count: 0,
    completed_count: 0,
  };
  // PLATFORM Payout Ledger only — never sum CW-driver payout_items into fleet KPIs.
  if (platformDriverIds.length === 0) return empty;

  // No paid_at column on payout_items — must use completed_at.
  const { data: items } = await supabase
    .from("payout_items")
    .select("status, net_driver_payout_pence, amount_pence, created_at, updated_at, completed_at, execution_status, driver_id")
    .in("driver_id", [...platformDriverIds])
    .limit(2000);

  const SCHEDULED = new Set(["pending", "scheduled", "queued", "on_hold", "ready"]);
  const PROCESSING = new Set(["processing", "in_progress", "submitted", "pending_provider"]);
  const COMPLETED = new Set(["completed", "paid", "succeeded"]);
  const FAILED = new Set(["failed", "error", "ledger_sync_failed", "failed_duplicate"]);

  const {
    day: dayStart,
    week: weekStart,
    month: monthStart,
    year: yearStart,
  } = londonPaidPeriodStarts(new Date());

  let scheduled_pence = 0;
  let processing_pence = 0;
  let paid_today_pence = 0;
  let paid_week_pence = 0;
  let paid_month_pence = 0;
  let paid_year_pence = 0;
  let failed_count = 0;
  let scheduled_count = 0;
  let processing_count = 0;
  let completed_count = 0;

  for (const row of items ?? []) {
    const st = String(row.status ?? "").toLowerCase();
    const amt = Math.max(0, Number(row.net_driver_payout_pence ?? row.amount_pence ?? 0));
    if (SCHEDULED.has(st)) {
      scheduled_pence += amt;
      scheduled_count += 1;
    } else if (PROCESSING.has(st)) {
      processing_pence += amt;
      processing_count += 1;
    } else if (COMPLETED.has(st) || String(row.execution_status ?? "").toLowerCase() === "completed") {
      completed_count += 1;
      const paidAt = new Date(String(row.completed_at ?? row.updated_at ?? row.created_at ?? 0));
      if (!Number.isNaN(paidAt.getTime())) {
        if (paidAt >= dayStart) paid_today_pence += amt;
        if (paidAt >= weekStart) paid_week_pence += amt;
        if (paidAt >= monthStart) paid_month_pence += amt;
        if (paidAt >= yearStart) paid_year_pence += amt;
      }
    } else if (FAILED.has(st)) {
      failed_count += 1;
    }
  }

  return {
    scheduled_pence,
    processing_pence,
    paid_today_pence,
    paid_week_pence,
    paid_month_pence,
    paid_year_pence,
    failed_count,
    scheduled_count,
    processing_count,
    completed_count,
  };
}

export async function buildPayoutLedgerAccountsOverview(
  supabase: AnySupabase,
  args?: {
    service_area_id?: string | null;
    allowed_service_area_ids?: readonly string[] | null;
    limit?: number;
  },
): Promise<AdminPayoutLedgerListResponse> {
  const platformDriverIds = await resolvePlatformCollectedDriverIds(supabase, {
    service_area_id: args?.service_area_id ?? null,
    allowed_service_area_ids: args?.allowed_service_area_ids ?? [],
  });
  if (platformDriverIds.length === 0) {
    return {
      success: true,
      page_status: "LIVE",
      tab: "overview",
      items: [],
      batches: [],
      accounts: [],
      fleet_summary: emptyFleet(),
      summary: emptySummary(),
    };
  }

  let driverQuery = supabase
    .from("drivers")
    .select("id, first_name, last_name, driver_code, payouts_enabled, payout_operational_paused, driver_status, deleted_at, category_id, driver_categories(name)")
    .eq("approval_status", "approved")
    .in("id", platformDriverIds)
    .limit(Math.min(200, Math.max(1, args?.limit ?? 100)));

  const [{ data: drivers, error }, itemTotals] = await Promise.all([
    driverQuery,
    loadPayoutItemStatusTotals(supabase, platformDriverIds),
  ]);
  if (error) {
    console.error("[admin-payout-ledger] drivers query failed", error);
    throw error;
  }

  let schedule = buildPayoutScheduleDto({
    service_area_id: args?.service_area_id ?? null,
    currencyCode: "GBP",
  });
  try {
    const settings = await loadPayoutControlCentreSettings(supabase);
    let saTimezone: string | null = null;
    let currencyCode: string | null = "GBP";
    if (args?.service_area_id) {
      const { data: sa } = await supabase
        .from("service_areas")
        .select("timezone, currency_code")
        .eq("id", args.service_area_id)
        .maybeSingle();
      saTimezone = (sa?.timezone as string | null) ?? null;
      currencyCode = (sa?.currency_code as string | null) ?? "GBP";
    }
    schedule = buildPayoutScheduleDto({
      service_area_id: args?.service_area_id ?? null,
      serviceAreaTimezone: saTimezone,
      currencyCode,
      automatic_payouts_enabled: settings.payouts_enabled,
      frequency: settings.payout_frequency,
      weekly_day: settings.weekly_payout_day,
      local_processing_time: settings.payout_processing_time,
    });
  } catch (err) {
    console.warn("[admin-payout-ledger] schedule SSOT load failed", err);
  }

  const driverIds = (drivers ?? []).map((d: { id: string }) => String(d.id)).filter(Boolean);
  const serviceAreaByDriver = new Map<string, {
    service_area_id: string | null;
    service_area: string | null;
    provider: string | null;
  }>();
  const lastPayoutByDriver = new Map<string, { at: string | null; amount_pence: number | null }>();

  // Soft-fail enrichment queries — never blank the whole PL page.
  let saLinks: Array<Record<string, unknown>> = [];
  let paidItems: Array<Record<string, unknown>> = [];
  if (driverIds.length > 0) {
    const [saRes, paidRes] = await Promise.all([
      supabase
        .from("driver_service_areas")
        .select("driver_id, service_area_id, service_areas(id, name, driver_payout_gateway, payment_provider)")
        .in("driver_id", driverIds),
      supabase
        .from("payout_items")
        .select("driver_id, completed_at, updated_at, net_driver_payout_pence, amount_pence, status")
        .in("driver_id", driverIds)
        .in("status", ["completed", "COMPLETED", "paid", "succeeded"])
        .order("completed_at", { ascending: false })
        .limit(500),
    ]);
    if (saRes.error) {
      console.warn("[admin-payout-ledger] service area enrich failed", saRes.error.message);
    } else {
      saLinks = (saRes.data ?? []) as Array<Record<string, unknown>>;
    }
    if (paidRes.error) {
      console.warn("[admin-payout-ledger] last payout enrich failed", paidRes.error.message);
    } else {
      paidItems = (paidRes.data ?? []) as Array<Record<string, unknown>>;
    }
  }

  for (const link of saLinks) {
      const driverId = String(link.driver_id ?? "");
      if (!driverId || serviceAreaByDriver.has(driverId)) continue;
      const sa = link.service_areas as {
        id?: string;
        name?: string;
        driver_payout_gateway?: string | null;
        payment_provider?: string | null;
      } | null;
      serviceAreaByDriver.set(driverId, {
        service_area_id: (link.service_area_id as string | null) ?? sa?.id ?? null,
        service_area: sa?.name ?? null,
        provider: (() => {
          const payoutGw = String(sa?.driver_payout_gateway ?? "").trim().toLowerCase();
          if (payoutGw === "revolut" || payoutGw === "bank" || payoutGw === "uk_bank" || payoutGw === "manual_bank") {
            return payoutGw;
          }
          const pay = String(sa?.payment_provider ?? "").trim().toLowerCase();
          if (pay === "revolut" || pay === "bank" || pay === "uk_bank" || pay === "manual_bank") {
            return pay;
          }
          return "revolut";
        })(),
      });
  }

  for (const item of paidItems) {
      const driverId = String(item.driver_id ?? "");
      if (!driverId || lastPayoutByDriver.has(driverId)) continue;
      lastPayoutByDriver.set(driverId, {
        at: (item.completed_at as string | null) ?? (item.updated_at as string | null) ?? null,
        amount_pence: Math.max(0, Number(item.net_driver_payout_pence ?? item.amount_pence ?? 0)),
      });
  }

  const allDriverIds = (drivers ?? []).map((d: { id: string }) => String(d.id)).filter(Boolean);
  const adminCreditLedgerIds = new Set<string>();
  let unrecordedFeeByDriver = new Map<string, number>();
  if (allDriverIds.length > 0) {
    const [adminCreditRes, feeMap] = await Promise.all([
      supabase
        .from("driver_wallet_ledger")
        .select("id")
        .eq("type", "ADMIN_WALLET_CREDIT")
        .in("driver_id", allDriverIds),
      loadUnrecordedCashoutFeePenceByDriver(supabase, allDriverIds),
    ]);
    for (const row of adminCreditRes.data ?? []) adminCreditLedgerIds.add(String(row.id));
    unrecordedFeeByDriver = feeMap;
  }

  const accounts: DriverPayoutAccountRow[] = [];
  let totalLive = 0;
  let totalAvailable = 0;
  let totalReserved = 0;
  let totalPending = 0;
  let totalHeld = 0;
  let totalUnbacked = 0;
  let totalDebt = 0;
  let nextBatchAmount = 0;
  let nextBatchDrivers = 0;
  let eligibleDrivers = 0;
  let heldDrivers = 0;
  let paused = 0;
  let unverified = 0;

  // Eligibility in parallel batches — sequential per-driver calls felt stuck on fleet load.
  const ELIGIBILITY_BATCH = 8;
  for (let i = 0; i < (drivers ?? []).length; i += ELIGIBILITY_BATCH) {
    const batch = (drivers ?? []).slice(i, i + ELIGIBILITY_BATCH);
    // deno-lint-ignore no-explicit-any
    await Promise.all(batch.map(async (d: Record<string, any>) => {
      let ctx;
      let sql;
      let gateAllowed = false;
      try {
        const [ctxRes, sqlRes, gateRes] = await Promise.all([
          fetchDriverPayoutEligibilityContext(supabase, {
            driver_id: d.id,
            service_area_id: args?.service_area_id ?? null,
          }),
          fetchDriverWalletEligibilityBalancesRpc(supabase, String(d.id)),
          supabase.rpc("driver_effective_payout_allowed", { p_driver_id: d.id }),
        ]);
        ctx = ctxRes;
        sql = sqlRes;
        gateAllowed = !gateRes.error && gateRes.data === true;
      } catch (eligErr) {
        console.warn("[admin-payout-ledger] eligibility failed", {
          driver_id: d.id,
          error: eligErr instanceof Error ? eligErr.message : String(eligErr),
        });
        return;
      }
      const pausedAccount = d.payout_operational_paused === true;
      const composition = resolvePayoutAccountComposition({
        sql,
        eligibility: ctx.eligibility,
        driver: {
          deleted: Boolean(d.deleted_at),
          driver_status: (d.driver_status as string | null) ?? null,
          approved: ctx.driver_approved,
          operational_paused: pausedAccount,
          global_payouts_enabled: ctx.global_payouts_enabled,
          verified_destination: ctx.provider_verified_active_destination,
          gate_allowed: gateAllowed,
        },
        admin_credit_ledger_ids: adminCreditLedgerIds,
        unrecorded_cashout_fee_pence: unrecordedFeeByDriver.get(String(d.id)) ?? 0,
      });
      const live = composition.live_pence;
      const available = composition.available_pence;
      const debt = Math.max(0, sql.outstanding_debt_pence);
      const name = `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim() || null;
      if (pausedAccount) paused += 1;

      if (live === 0 && available <= 0 && debt <= 0) {
        return;
      }

      totalLive += Math.max(0, live);
      totalAvailable += available;
      totalReserved += composition.reserved_pence;
      totalPending += composition.pending_pence;
      totalHeld += composition.held_pence;
      totalUnbacked += composition.unbacked_pence;
      totalDebt += debt;

      if (composition.payout_included) {
        nextBatchAmount += available;
        nextBatchDrivers += 1;
        eligibleDrivers += 1;
      } else if (live > 0) {
        heldDrivers += 1;
      }

      const saMeta = serviceAreaByDriver.get(String(d.id));
      const normalizedProvider = String(saMeta?.provider ?? "").toLowerCase();
      const verified = ctx.provider_verified_active_destination;
      const last4 = ctx.active_destination_last4;
      if (!verified) unverified += 1;
      const tierJoin = d.driver_categories as { name?: string } | { name?: string }[] | null;
      const tierName = Array.isArray(tierJoin)
        ? (tierJoin[0]?.name ?? null)
        : (tierJoin?.name ?? null);
      const lastPaid = lastPayoutByDriver.get(String(d.id));

      accounts.push({
        driver_id: d.id,
        name,
        code: (d.driver_code as string | null) ?? null,
        service_area_id: saMeta?.service_area_id ?? null,
        service_area: saMeta?.service_area ?? null,
        tier: tierName,
        provider: saMeta ? (normalizedProvider || "revolut") : null,
        connected_account: null,
        payout_destination: last4
          ? `Revolut · ••${last4}${verified ? "" : " (unverified)"}`
          : "Not set",
        verification: verified ? "verified" : (last4 ? "pending_verification" : "not_set"),
        live_balance_pence: live,
        available_balance_pence: available,
        pending_balance_pence: composition.pending_pence,
        reserved_pence: composition.reserved_pence,
        held_pence: composition.held_pence,
        unbacked_pence: composition.unbacked_pence,
        unbacked_reason: composition.unbacked_reason,
        debt_pence: debt,
        eligible_entry_count: composition.eligible_entry_count,
        held_entry_count: composition.held_entry_count,
        unavailable_reason: composition.hold_reason,
        payout_included: composition.payout_included,
        next_scheduled_at: composition.payout_included ? schedule.next_run_at_utc : null,
        next_scheduled_local: composition.payout_included ? schedule.next_run_at_local : null,
        next_scheduled_note: composition.payout_included
          ? null
          : payoutAccountNotScheduledNote(composition.hold_reason),
        last_payout_at: lastPaid?.at ?? null,
        last_payout_amount_pence: lastPaid?.amount_pence ?? null,
        schedule_label: schedule.schedule_label,
        payout_status: composition.status,
        driver_deleted: Boolean(d.deleted_at) || String(d.driver_status ?? "").toLowerCase() === "deleted",
        paused: pausedAccount,
        payout_operational_paused: pausedAccount,
      });
    }));
  }

  accounts.sort((a, b) =>
    (b.available_balance_pence + b.pending_balance_pence)
    - (a.available_balance_pence + a.pending_balance_pence)
  );

  const zeroGuard = shouldBlockZeroValuePayoutBatch({
    eligible_driver_count: eligibleDrivers,
    total_available_pence: totalAvailable,
  });

  const fleet_summary: AdminPayoutLedgerFleetSummary = {
    total_live_wallet_pence: totalLive,
    total_available_pence: totalAvailable,
    total_reserved_pence: totalReserved,
    // Settlement pending only — reservations, holds and unbacked balance are separate.
    total_pending_pence: Math.max(0, totalPending),
    total_held_pence: totalHeld,
    total_unbacked_pence: totalUnbacked,
    total_outstanding_debt_pence: totalDebt,
    total_scheduled_pence: itemTotals.scheduled_pence,
    total_processing_pence: itemTotals.processing_pence,
    paid_today_pence: itemTotals.paid_today_pence,
    paid_week_pence: itemTotals.paid_week_pence,
    paid_month_pence: itemTotals.paid_month_pence,
    paid_year_pence: itemTotals.paid_year_pence,
    failed_count: itemTotals.failed_count,
    paused_accounts: paused,
    unverified_accounts: unverified,
    next_batch_amount_pence: nextBatchAmount,
    next_batch_driver_count: nextBatchDrivers,
    eligible_driver_count: eligibleDrivers,
    held_driver_count: heldDrivers,
    scheduled_payouts_count: itemTotals.scheduled_count,
    processing_payouts_count: itemTotals.processing_count,
    completed_payouts_count: itemTotals.completed_count,
    zero_batch_guard: zeroGuard.block ? zeroGuard.error_code : null,
  };

  return {
    success: true,
    page_status: "LIVE",
    tab: "overview",
    items: [],
    batches: [],
    accounts,
    fleet_summary,
    summary: {
      ...emptySummary(),
      total_available_pence: totalAvailable,
      next_batch_amount_pence: nextBatchAmount,
      next_batch_driver_count: nextBatchDrivers,
      scheduled_count: itemTotals.scheduled_count,
      processing_count: itemTotals.processing_count,
      completed_count: itemTotals.completed_count,
      failed_count: itemTotals.failed_count,
      total_scheduled_pence: itemTotals.scheduled_pence,
      total_processing_pence: itemTotals.processing_pence,
    },
  };
}
