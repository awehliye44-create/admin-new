/**
 * Payout Ledger accounts overview — consumes canonical fetchDriverPayoutEligibility.
 * Never recalculates earnings / debt / available independently in the UI.
 */
// deno-lint-ignore no-explicit-any
type AnySupabase = any;

import type {
  AdminPayoutLedgerFleetSummary,
  AdminPayoutLedgerListResponse,
  DriverPayoutAccountRow,
} from "../../../shared/adminPayoutLedgerSSOT.ts";
import { payoutDestinationLabel } from "../../../shared/payoutLedgerHandoffSSOT.ts";
import { fetchDriverPayoutEligibility } from "./fetchDriverPayoutEligibility.ts";
import { shouldBlockZeroValuePayoutBatch } from "../../../shared/driverPayoutEligibilitySSOT.ts";
import { loadPayoutControlCentreSettings } from "./payoutControlCentreSettingsSSOT.ts";
import { buildPayoutScheduleDto } from "./payoutScheduleSSOT.ts";

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

async function loadPayoutItemStatusTotals(supabase: AnySupabase): Promise<{
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
  const { data: items } = await supabase
    .from("payout_items")
    .select("status, net_driver_payout_pence, amount_pence, created_at, updated_at, paid_at")
    .limit(2000);

  const SCHEDULED = new Set(["pending", "scheduled", "queued", "on_hold", "ready"]);
  const PROCESSING = new Set(["processing", "in_progress", "submitted", "pending_provider"]);
  const COMPLETED = new Set(["completed", "paid", "succeeded"]);
  const FAILED = new Set(["failed", "error", "ledger_sync_failed", "failed_duplicate"]);

  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(dayStart);
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

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
    } else if (COMPLETED.has(st)) {
      completed_count += 1;
      const paidAt = new Date(String(row.paid_at ?? row.updated_at ?? row.created_at ?? 0));
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
  args?: { service_area_id?: string | null; limit?: number },
): Promise<AdminPayoutLedgerListResponse> {
  let driverQuery = supabase
    .from("drivers")
    .select("id, first_name, last_name, driver_code, stripe_account_id, payouts_enabled, category_id, driver_categories(name)")
    .eq("approval_status", "approved")
    .limit(Math.min(200, Math.max(1, args?.limit ?? 100)));

  if (args?.service_area_id) {
    const { data: links } = await supabase
      .from("driver_service_areas")
      .select("driver_id")
      .eq("service_area_id", args.service_area_id);
    const ids = [...new Set((links ?? []).map((r: { driver_id: string }) => String(r.driver_id)).filter(Boolean))];
    if (ids.length === 0) {
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
    driverQuery = driverQuery.in("id", ids);
  }

  const [{ data: drivers, error }, itemTotals] = await Promise.all([
    driverQuery,
    loadPayoutItemStatusTotals(supabase),
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
        .select("driver_id, paid_at, updated_at, net_driver_payout_pence, amount_pence, status")
        .in("driver_id", driverIds)
        .in("status", ["completed", "paid", "succeeded"])
        .order("paid_at", { ascending: false })
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
          if (payoutGw && payoutGw !== "stripe") return payoutGw;
          const pay = String(sa?.payment_provider ?? "").trim().toLowerCase();
          if (pay && pay !== "stripe") return pay;
          return "revolut";
        })(),
      });
  }

  for (const item of paidItems) {
      const driverId = String(item.driver_id ?? "");
      if (!driverId || lastPayoutByDriver.has(driverId)) continue;
      lastPayoutByDriver.set(driverId, {
        at: (item.paid_at as string | null) ?? (item.updated_at as string | null) ?? null,
        amount_pence: Math.max(0, Number(item.net_driver_payout_pence ?? item.amount_pence ?? 0)),
      });
  }

  const reservedByDriver = new Map<string, number>();
  {
    const driverIds = (drivers ?? []).map((d: { id: string }) => String(d.id)).filter(Boolean);
    if (driverIds.length > 0) {
      const { data: resRows } = await supabase
        .from("driver_payout_reservations")
        .select("driver_id, amount_pence")
        .eq("status", "ACTIVE")
        .in("driver_id", driverIds);
      for (const row of resRows ?? []) {
        const id = String(row.driver_id ?? "");
        if (!id) continue;
        reservedByDriver.set(
          id,
          (reservedByDriver.get(id) ?? 0) + Math.max(0, Number(row.amount_pence ?? 0)),
        );
      }
    }
  }

  const accounts: DriverPayoutAccountRow[] = [];
  let totalLive = 0;
  let totalAvailable = 0;
  let totalReserved = 0;
  let totalPending = 0;
  let totalDebt = 0;
  let nextBatchAmount = 0;
  let nextBatchDrivers = 0;
  let eligibleDrivers = 0;
  let heldDrivers = 0;
  let paused = 0;
  let unverified = 0;

  for (const d of drivers ?? []) {
    let eligibility;
    try {
      eligibility = await fetchDriverPayoutEligibility(supabase, {
        driver_id: d.id,
        service_area_id: args?.service_area_id ?? null,
      });
    } catch (eligErr) {
      console.warn("[admin-payout-ledger] eligibility failed", {
        driver_id: d.id,
        error: eligErr instanceof Error ? eligErr.message : String(eligErr),
      });
      continue;
    }
    const available = Math.max(0, eligibility.available_balance_pence);
    const live = Math.round(eligibility.live_balance_pence);
    const pending = Math.max(0, eligibility.pending_balance_pence);
    const reserved = Math.max(0, reservedByDriver.get(String(d.id)) ?? 0);
    const debt = Math.max(0, eligibility.outstanding_debt_pence);
    const name = `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim() || null;
    const pausedAccount = d.payouts_enabled === false;
    if (pausedAccount) paused += 1;

    if (available <= 0 && live <= 0 && debt <= 0) {
      continue;
    }

    totalLive += Math.max(0, live);
    totalAvailable += available;
    totalReserved += reserved;
    totalPending += pending;
    totalDebt += debt;

    if (available > 0 && !pausedAccount) {
      nextBatchAmount += available;
      nextBatchDrivers += 1;
      eligibleDrivers += 1;
    } else if (live > 0 && available <= 0) {
      heldDrivers += 1;
    }

    const saMeta = serviceAreaByDriver.get(String(d.id));
    const provider = saMeta?.provider ?? null;
    const connected = (d.stripe_account_id as string | null) ?? null;
    const isRevolut = String(provider ?? "").toLowerCase() === "revolut";
    const manualBank = isRevolut || !connected;
    if (!manualBank && !connected) unverified += 1;
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
      provider: isRevolut ? "revolut" : (provider && provider.toLowerCase() !== "stripe" ? provider : "revolut"),
      connected_account: connected,
      payout_destination: payoutDestinationLabel({
        provider: isRevolut ? "revolut" : provider,
        connected_account_id: isRevolut ? null : connected,
        manual_bank: manualBank,
      }),
      verification: manualBank ? "manual_bank" : (connected ? "legacy_connect" : "not_set"),
      live_balance_pence: live,
      available_balance_pence: available,
      pending_balance_pence: pending,
      debt_pence: debt,
      eligible_entry_count: eligibility.eligible_entries.length,
      unavailable_reason: available <= 0 && live > 0
        ? (pausedAccount
          ? "ADMIN_HOLD"
          : (eligibility.primary_hold_reason ?? eligibility.held_entries[0]?.hold_reason ?? "UNKNOWN_ELIGIBILITY_ERROR"))
        : null,
      next_scheduled_at: schedule.next_run_at_utc,
      next_scheduled_local: schedule.next_run_at_local,
      last_payout_at: lastPaid?.at ?? null,
      last_payout_amount_pence: lastPaid?.amount_pence ?? null,
      schedule_label: schedule.schedule_label,
      payout_status: pausedAccount
        ? "PAUSED"
        : available > 0
        ? "ELIGIBLE"
        : live > 0
        ? "HELD"
        : "ZERO",
      paused: pausedAccount,
    });
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
    // Other holds only — ACTIVE reservations live under total_reserved_pence.
    total_pending_pence: Math.max(0, totalPending - totalReserved),
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
