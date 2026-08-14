/**
 * Canonical weekly payout orchestrator.
 * Cron + admin entry: claim occurrence â eligibility â batch â funding â
 * (LIVE+TRANSPORT only) reserve â Revolut submit â finalize â WEEKLY_PAYOUT debit.
 *
 * LIVE_PAYOUT_EXECUTION_ENABLED=false stops after planning with LIVE_PAYOUT_ROLLOUT_DISABLED.
 * dry_run=true never reserves, never calls Revolut, never debits.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { loadPayoutControlCentreSettings } from "../_shared/payoutControlCentreSettingsSSOT.ts";
import { computeLedgerWalletBalancePence } from "../_shared/onecabFinanceLedger.ts";
import { resolveLiveCompanyBalanceSnapshot } from "../_shared/companyBalanceResolveSSOT.ts";
import {
  CONFLICTING_ACTIVE_ITEM_STATUSES,
  WEEKLY_PAYOUT_BATCH_KIND,
  evaluateDriverBatchEligibility,
  isLivePayoutExecutionEnabled,
  isRevolutPaymentTransportEnabled,
  itemIdempotencyKey,
  resolveMostRecentDueOccurrence,
  resolveScheduleOccurrence,
  slugifyServiceAreaName,
  type ScheduleOccurrence,
  type ScheduleSettingsSnapshot,
} from "../_shared/weeklyDriverPayoutBatchWorkflowSSOT.ts";
import {
  FUNDING_RESULT,
  ORCHESTRATOR_BATCH_STATUS,
  ORCHESTRATOR_BLOCKER,
  ORCHESTRATOR_ITEM_STATUS,
  ORCHESTRATOR_RUN_STATUS,
  buildOrchestratorPlanSnapshot,
  evaluateBatchFundingGate,
  orchestratorBlockerLabel,
  resolveOrchestratorRunFinish,
  isOrchestratorReconcileOnlyItemStatus,
  shouldReleaseReservationOnSubmitClaimFailure,
  isOrchestratorInFlightItemStatus,
  shouldContinueOrchestratorMoneyPath,
} from "../_shared/weeklyPayoutOrchestratorSSOT.ts";
import {
  canonicalIdempotencyKey,
  canonicalProviderRequestId,
  validateApprovedDriverPayoutPayment,
} from "../_shared/revolutDriverPayoutPaymentSSOT.ts";
import {
  mapProviderSubmissionOutcome,
  redactProviderEvidence,
} from "../_shared/driverPayoutSubmissionSSOT.ts";
import {
  isCanonicalProviderCompleted,
  mayFinaliseFromProviderState,
  redactCompletionEvidence,
} from "../_shared/driverPayoutCompletionSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayApprovedDriverPayoutPayment,
  relayDriverPayoutPaymentStatus,
} from "../_shared/revolutBusinessRelayClient.ts";
import { ensureFreshRevolutBusinessAccessToken } from "../_shared/revolutBusinessAccessTokenRefresh.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
  "Content-Type": "application/json",
};

type AnySupabase = ReturnType<typeof createClient>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders } });
}

async function assertAdmin(req: Request, supabase: AnySupabase): Promise<
  { ok: true; userId: string } | { ok: false; response: Response }
> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { ok: false, response: json({ error: "Unauthorized" }, 401) };
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false, response: json({ error: "Unauthorized" }, 401) };
  const { data: roleData } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleData) return { ok: false, response: json({ error: "Admin access required" }, 403) };
  return { ok: true, userId: user.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const live = isLivePayoutExecutionEnabled();
  const transport = isRevolutPaymentTransportEnabled();

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const scheduledRun = body.scheduled === true || body.source === "pg_cron";
  const dryRun = body.dry_run === true;
  const force = body.force === true
    || Boolean(body.force_schedule_occurrence_key)
    || Boolean(body.force_local_iso);

  if (scheduledRun) {
    const cronAuth = await assertCronOrServiceRoleAuth(req, body);
    if (!cronAuth.ok) return cronAuth.response;
  } else {
    const cronAuth = await assertCronOrServiceRoleAuth(req, body);
    if (!cronAuth.ok) {
      const adminAuth = await assertAdmin(req, supabase);
      if (!adminAuth.ok) return adminAuth.response;
    }
  }

  const serviceAreaId = (body.service_area_id as string | undefined) ?? null;
  const regionId = (body.region_id as string | undefined) ?? null;

  const controlCentre = await loadPayoutControlCentreSettings(supabase, { serviceAreaId });
  const settings: ScheduleSettingsSnapshot = {
    payouts_enabled: controlCentre.payouts_enabled,
    payout_frequency: controlCentre.payout_frequency,
    weekly_payout_day: controlCentre.weekly_payout_day,
    payout_processing_time: controlCentre.payout_processing_time,
    payout_timezone: controlCentre.payout_timezone || "Europe/London",
  };

  let serviceAreaSlug = "milton-keynes";
  let serviceAreaCurrency = "GBP";
  let resolvedServiceAreaId = serviceAreaId;
  {
    let saQuery = supabase.from("service_areas").select("id, name, currency_code").limit(1);
    if (serviceAreaId) saQuery = saQuery.eq("id", serviceAreaId);
    else saQuery = saQuery.ilike("name", "%Milton Keynes%");
    const { data: sa } = await saQuery.maybeSingle();
    if (sa) {
      resolvedServiceAreaId = String(sa.id);
      serviceAreaSlug = slugifyServiceAreaName(String(sa.name));
      serviceAreaCurrency = String(sa.currency_code ?? "GBP").toUpperCase() || "GBP";
    }
  }

  let occurrence: ScheduleOccurrence | { not_due: true; reason: string; next_run_at_utc: string | null };
  if (body.force_schedule_occurrence_key) {
    const key = String(body.force_schedule_occurrence_key).trim();
    const localMatch = key.match(/:(\d{4}-\d{2}-\d{2}T[\d:+-]+)$/);
    const localIso = localMatch?.[1] ?? key;
    const utc = new Date(localIso);
    occurrence = {
      schedule_occurrence_key: key,
      schedule_id: `payout-schedule:weekly:${settings.weekly_payout_day}:${settings.payout_processing_time}:${settings.payout_timezone}`,
      service_area_id: resolvedServiceAreaId,
      service_area_slug: serviceAreaSlug,
      frequency: String(settings.payout_frequency ?? "weekly"),
      weekly_day: String(settings.weekly_payout_day),
      timezone: settings.payout_timezone || "Europe/London",
      scheduled_local_at: localIso,
      scheduled_utc_at: Number.isNaN(utc.getTime()) ? new Date().toISOString() : utc.toISOString(),
      local_iso_with_offset: localIso,
      currency: serviceAreaCurrency,
    };
  } else if (force) {
    occurrence = resolveMostRecentDueOccurrence({
      settings,
      service_area_id: resolvedServiceAreaId,
      service_area_slug: serviceAreaSlug,
      currency: serviceAreaCurrency,
      now: new Date(),
    });
  } else {
    occurrence = resolveScheduleOccurrence({
      settings,
      service_area_id: resolvedServiceAreaId,
      service_area_slug: serviceAreaSlug,
      currency: serviceAreaCurrency,
      now: new Date(),
    });
  }

  if ("not_due" in occurrence && occurrence.not_due) {
    if (scheduledRun && !force) {
      return json({
        success: true,
        skipped: true,
        error_code: occurrence.reason,
        blocker_code: occurrence.reason,
        blocker_label: orchestratorBlockerLabel(occurrence.reason),
        message: `Scheduler idle â ${occurrence.reason}`,
        next_run_at_utc: occurrence.next_run_at_utc,
        settings,
        live_payout_execution_enabled: live,
        revolut_payment_transport_enabled: transport,
        revolut_pay_called: false,
        wallet_debited: false,
      });
    }
    return json({
      success: false,
      error_code: occurrence.reason,
      blocker_code: occurrence.reason,
      blocker_label: orchestratorBlockerLabel(occurrence.reason),
      message: `Schedule not due (${occurrence.reason})`,
      next_run_at_utc: occurrence.next_run_at_utc,
      settings,
    }, 409);
  }

  const occurrenceKey = occurrence.schedule_occurrence_key;

  const { data: claimRaw, error: claimErr } = await supabase.rpc(
    "claim_weekly_payout_occurrence",
    { p_schedule_occurrence_key: occurrenceKey, p_dry_run: dryRun },
  );
  if (claimErr) {
    return json({
      success: false,
      error: "claim_rpc_failed",
      message: claimErr.message,
      hint: "Apply migration 20260832010000_weekly_payout_orchestrator_claim_cron.sql",
      revolut_pay_called: false,
    }, 500);
  }
  const claim = (claimRaw ?? {}) as Record<string, unknown>;
  if (claim.ok !== true) {
    return json({ success: false, error: claim.error ?? "claim_failed", revolut_pay_called: false }, 500);
  }
  const runId = String(claim.run_id);
  if (
    !dryRun
    && String(claim.status) === ORCHESTRATOR_RUN_STATUS.COMPLETED
    && claim.money_path_executed === true
  ) {
    return json({
      success: true,
      reused: true,
      schedule_occurrence_key: occurrenceKey,
      run_id: runId,
      batch_id: claim.batch_id ?? null,
      status: ORCHESTRATOR_RUN_STATUS.COMPLETED,
      blocker_code: null,
      message: "Occurrence already completed â no duplicate pay/debit",
      result: claim.result_json ?? {},
      revolut_pay_called: false,
      wallet_debited: false,
    });
  }

  // --- Eligibility + batch create/reuse ---
  let driverQuery = supabase
    .from("drivers")
    .select(
      "id, region_id, service_area_id, first_name, last_name, payouts_enabled, approval_status, driver_status",
    )
    .eq("approval_status", "approved");
  if (regionId) driverQuery = driverQuery.eq("region_id", regionId);
  if (resolvedServiceAreaId) driverQuery = driverQuery.eq("service_area_id", resolvedServiceAreaId);
  const { data: drivers, error: driversError } = await driverQuery;
  if (driversError) return json({ success: false, error: driversError.message }, 500);

  const driverIds = (drivers ?? []).map((d) => String(d.id));
  const ledgerByDriver = new Map<string, Array<{ type: string; amount_pence: number }>>();
  if (driverIds.length > 0) {
    const { data: ledgerRows, error: ledgerError } = await supabase
      .from("driver_wallet_ledger")
      .select("driver_id, type, amount_pence")
      .in("driver_id", driverIds);
    if (ledgerError) return json({ success: false, error: ledgerError.message }, 500);
    for (const row of ledgerRows ?? []) {
      const id = String(row.driver_id);
      const list = ledgerByDriver.get(id) ?? [];
      list.push({ type: String(row.type ?? ""), amount_pence: Number(row.amount_pence ?? 0) });
      ledgerByDriver.set(id, list);
    }
  }

  const destByDriver = new Map<string, Record<string, unknown>>();
  if (driverIds.length > 0) {
    const { data: dests } = await supabase
      .from("driver_payout_destinations")
      .select(
        "id, driver_id, is_active, archived_at, provider_link_status, provider_counterparty_id, provider_recipient_account_id, currency_code",
      )
      .in("driver_id", driverIds)
      .eq("is_active", true)
      .is("archived_at", null);
    for (const d of dests ?? []) {
      const did = String(d.driver_id);
      const existing = destByDriver.get(did);
      const link = String(d.provider_link_status ?? "").toUpperCase();
      if (!existing || link === "PROVIDER_VERIFIED") destByDriver.set(did, d as Record<string, unknown>);
    }
  }

  const conflictDrivers = new Set<string>();
  if (driverIds.length > 0) {
    const { data: activeItems } = await supabase
      .from("payout_items")
      .select("driver_id, status, execution_status")
      .in("driver_id", driverIds);
    for (const item of activeItems ?? []) {
      const st = String(item.execution_status ?? item.status ?? "");
      if (CONFLICTING_ACTIVE_ITEM_STATUSES.has(st)) conflictDrivers.add(String(item.driver_id));
    }
  }

  type Planned = {
    driver_id: string;
    driver_name: string | null;
    amount_pence: number;
    payout_destination_id: string;
    provider_counterparty_id: string;
    provider_recipient_account_id: string;
    wallet_snapshot_balance_pence: number;
    wallet_snapshot_available_pence: number;
    eligibility_snapshot: Record<string, unknown>;
    destination_verified: boolean;
  };
  const planned: Planned[] = [];
  for (const driver of drivers ?? []) {
    const driverId = String(driver.id);
    const ledger = ledgerByDriver.get(driverId) ?? [];
    const balance = computeLedgerWalletBalancePence(ledger);
    const available = Math.max(0, balance);
    const dest = destByDriver.get(driverId) ?? null;
    const driverStatus = String(driver.driver_status ?? "").toLowerCase();
    const held = ["suspended", "blocked", "banned", "held"].includes(driverStatus);
    const decision = evaluateDriverBatchEligibility({
      driver_id: driverId,
      wallet_balance_pence: balance,
      available_payout_pence: available,
      payouts_enabled: driver.payouts_enabled !== false,
      driver_held_or_blocked: held,
      currency: serviceAreaCurrency,
      expected_currency: serviceAreaCurrency,
      destination: dest
        ? {
          id: String(dest.id),
          is_active: dest.is_active !== false,
          archived_at: (dest.archived_at as string | null) ?? null,
          provider_link_status: (dest.provider_link_status as string | null) ?? null,
          provider_counterparty_id: (dest.provider_counterparty_id as string | null) ?? null,
          provider_recipient_account_id:
            (dest.provider_recipient_account_id as string | null) ?? null,
        }
        : null,
      has_conflicting_active_item: conflictDrivers.has(driverId),
    });
    if (!decision.eligible) continue;
    planned.push({
      driver_id: driverId,
      driver_name: `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim() || null,
      amount_pence: decision.amount_pence,
      payout_destination_id: decision.payout_destination_id,
      provider_counterparty_id: decision.provider_counterparty_id,
      provider_recipient_account_id: decision.provider_recipient_account_id,
      wallet_snapshot_balance_pence: decision.wallet_snapshot_balance_pence,
      wallet_snapshot_available_pence: decision.wallet_snapshot_available_pence,
      eligibility_snapshot: decision.eligibility_snapshot,
      destination_verified: true,
    });
  }

  const requiredBatchPence = planned.reduce((s, p) => s + p.amount_pence, 0);

  // Funding refresh (configured Revolut payout source only).
  let fundingAvailable: number | null = null;
  let sourceAccountId: string | null = null;
  let sourceLabel: string | null = null;
  try {
    const companyBalance = await resolveLiveCompanyBalanceSnapshot({
      supabase,
      service_area_id: resolvedServiceAreaId,
    });
    fundingAvailable = companyBalance.provider_available_balance_pence
      ?? companyBalance.provider_cash_balance_pence
      ?? null;
    sourceAccountId = companyBalance.source_account_id ?? null;
    sourceLabel = companyBalance.source_account_label ?? null;
  } catch (err) {
    console.warn("[orchestrator] company balance refresh failed", err);
  }
  // Fallback: persisted default payout source (settled available last synced).
  if (fundingAvailable == null || sourceAccountId == null) {
    const { data: srcRows } = await supabase
      .from("revolut_business_source_accounts")
      .select(
        "id, revolut_account_id, account_name, last_available_balance_pence, last_balance_pence, is_default_payout_source",
      )
      .eq("provider", "revolut_business")
      .eq("is_active", true)
      .eq("is_default_payout_source", true)
      .limit(1);
    const src = srcRows?.[0] as Record<string, unknown> | undefined;
    if (src) {
      sourceAccountId = sourceAccountId
        ?? (src.revolut_account_id == null ? null : String(src.revolut_account_id));
      sourceLabel = sourceLabel
        ?? (src.account_name == null ? null : String(src.account_name));
      if (fundingAvailable == null) {
        const avail = src.last_available_balance_pence ?? src.last_balance_pence;
        fundingAvailable = avail == null ? null : Math.round(Number(avail));
      }
    }
  }
  const fundingGate = evaluateBatchFundingGate({
    required_batch_pence: requiredBatchPence,
    available_pence: fundingAvailable,
  });

  // Create or reuse batch (skip DB writes for dry_run planning-only when requested).
  let batchId: string | null = null;
  let batchReused = false;
  const itemIdsByDriver = new Map<string, string>();
  type ExistingBatchItem = {
    id: string;
    driver_id: string;
    amount_pence: number;
    status: string;
    execution_status: string | null;
    payout_destination_id: string | null;
    provider_counterparty_id: string | null;
    provider_recipient_account_id: string | null;
  };
  let existingBatchItems: ExistingBatchItem[] = [];

  const { data: existingBatch } = await supabase
    .from("payout_batches")
    .select("id, status, total_amount_pence, eligible_driver_count, blocker_code")
    .eq("schedule_occurrence_key", occurrenceKey)
    .maybeSingle();

  if (existingBatch?.id) {
    batchId = String(existingBatch.id);
    batchReused = true;
    const { data: existingItems } = await supabase
      .from("payout_items")
      .select(
        "id, driver_id, amount_pence, status, execution_status, payout_destination_id, provider_counterparty_id, provider_recipient_account_id",
      )
      .eq("batch_id", batchId);
    existingBatchItems = (existingItems ?? []).map((it) => ({
      id: String(it.id),
      driver_id: String(it.driver_id),
      amount_pence: Number(it.amount_pence ?? 0),
      status: String(it.status ?? ""),
      execution_status: it.execution_status == null ? null : String(it.execution_status),
      payout_destination_id: it.payout_destination_id == null
        ? null
        : String(it.payout_destination_id),
      provider_counterparty_id: it.provider_counterparty_id == null
        ? null
        : String(it.provider_counterparty_id),
      provider_recipient_account_id: it.provider_recipient_account_id == null
        ? null
        : String(it.provider_recipient_account_id),
    }));
    for (const it of existingBatchItems) {
      itemIdsByDriver.set(it.driver_id, it.id);
    }
  } else if (!dryRun) {
    const runDate = occurrence.scheduled_utc_at.slice(0, 10);
    const { data: batch, error: batchError } = await supabase
      .from("payout_batches")
      .insert({
        kind: WEEKLY_PAYOUT_BATCH_KIND,
        run_date: runDate,
        status: "ELIGIBILITY_SNAPSHOTTED",
        total_drivers: planned.length,
        total_amount_pence: requiredBatchPence,
        eligible_driver_count: planned.length,
        service_area_id: occurrence.service_area_id ?? resolvedServiceAreaId,
        schedule_id: occurrence.schedule_id,
        schedule_occurrence_key: occurrenceKey,
        frequency: occurrence.frequency,
        scheduled_local_at: occurrence.scheduled_local_at,
        scheduled_utc_at: occurrence.scheduled_utc_at,
        timezone: occurrence.timezone,
        currency: occurrence.currency,
        notes: scheduledRun
          ? "created_by=pg_cron_orchestrator"
          : "created_by=admin_orchestrator",
      })
      .select("id")
      .single();
    if (batchError || !batch) {
      return json({
        success: false,
        error: "batch_create_failed",
        message: batchError?.message ?? "batch insert failed",
        revolut_pay_called: false,
      }, 500);
    }
    batchId = String(batch.id);
    const rows = planned.map((p) => ({
      batch_id: batchId,
      driver_id: p.driver_id,
      amount_pence: p.amount_pence,
      net_driver_payout_pence: p.amount_pence,
      status: "CREATED",
      execution_status: "CREATED",
      payout_destination_id: p.payout_destination_id,
      provider_counterparty_id: p.provider_counterparty_id,
      provider_recipient_account_id: p.provider_recipient_account_id,
      currency: serviceAreaCurrency,
      wallet_snapshot_balance_pence: p.wallet_snapshot_balance_pence,
      wallet_snapshot_available_pence: p.wallet_snapshot_available_pence,
      eligibility_snapshot: p.eligibility_snapshot,
      // Placeholder until item UUID exists â replaced with canonical oc-dp:{uuidhex} below.
      provider_request_id: `wppending:${p.driver_id}`.slice(0, 40),
      idempotency_key: itemIdempotencyKey(occurrenceKey, p.driver_id),
    }));
    if (rows.length > 0) {
      const { data: inserted, error: itemsError } = await supabase
        .from("payout_items")
        .insert(rows)
        .select("id, driver_id");
      if (itemsError) {
        return json({
          success: false,
          error: "items_create_failed",
          message: itemsError.message,
          revolut_pay_called: false,
        }, 500);
      }
      for (const it of inserted ?? []) {
        const itemId = String(it.id);
        itemIdsByDriver.set(String(it.driver_id), itemId);
        const requestId = canonicalProviderRequestId(itemId);
        await supabase.from("payout_items").update({
          provider_request_id: requestId,
          updated_at: new Date().toISOString(),
        }).eq("id", itemId);
      }
    }
    await supabase.from("payout_batches").update({
      status: "ITEMS_CREATED",
      updated_at: new Date().toISOString(),
    }).eq("id", batchId);
  }

  const planItems = planned.map((p) => ({
    driver_id: p.driver_id,
    driver_name: p.driver_name,
    amount_pence: p.amount_pence,
    payout_item_id: itemIdsByDriver.get(p.driver_id) ?? null,
    payout_destination_id: p.payout_destination_id,
    provider_counterparty_id: p.provider_counterparty_id,
    provider_recipient_account_id: p.provider_recipient_account_id,
    destination_verified: p.destination_verified,
  }));

  const plan = buildOrchestratorPlanSnapshot({
    schedule_occurrence_key: occurrenceKey,
    items: planItems.map((p) => ({
      ...p,
      payout_item_id: p.payout_item_id,
    })),
    available_pence: fundingAvailable,
    live_enabled: live,
    transport_enabled: transport,
    dry_run: dryRun,
  });

  // Prefer funding gate from live refresh if plan didn't already set it.
  let blocker = plan.blocker_code;
  if (!blocker && fundingGate.blocker_code) blocker = fundingGate.blocker_code;

  // Reconcile path: reserved/submitted drivers drop out of fresh eligibility â continue
  // money path from existing in-flight batch items so cron can poll/finalize.
  const inFlightExisting = existingBatchItems.filter((it) =>
    isOrchestratorInFlightItemStatus(it.execution_status ?? it.status)
  );
  type MoneyWork = {
    driver_id: string;
    driver_name: string | null;
    amount_pence: number;
    payout_destination_id: string;
    provider_counterparty_id: string;
    provider_recipient_account_id: string;
  };
  let moneyWork: MoneyWork[] = planned.map((p) => ({
    driver_id: p.driver_id,
    driver_name: p.driver_name,
    amount_pence: p.amount_pence,
    payout_destination_id: p.payout_destination_id,
    provider_counterparty_id: p.provider_counterparty_id,
    provider_recipient_account_id: p.provider_recipient_account_id,
  }));
  if (moneyWork.length === 0 && inFlightExisting.length > 0) {
    moneyWork = inFlightExisting.map((it) => ({
      driver_id: it.driver_id,
      driver_name: null,
      amount_pence: it.amount_pence,
      payout_destination_id: it.payout_destination_id ?? "",
      provider_counterparty_id: it.provider_counterparty_id ?? "",
      provider_recipient_account_id: it.provider_recipient_account_id ?? "",
    }));
  }

  const moneyGate = shouldContinueOrchestratorMoneyPath({
    dry_run: dryRun,
    live_enabled: live,
    transport_enabled: transport,
    has_batch: batchId != null,
    fresh_eligible_count: planned.length,
    in_flight_item_count: inFlightExisting.length,
    blocker_code: blocker,
  });
  if (moneyGate.ignore_zero_eligible_blocker && blocker === "ZERO_ELIGIBLE_DRIVERS") {
    blocker = null;
  }
  const moneyPath = moneyGate.continue && moneyWork.length > 0;

  const providerPayloads = plan.items.map((item) => ({
    driver_id: item.driver_id,
    driver_name: item.driver_name,
    amount_pence: item.amount_pence,
    amount_major: (item.amount_pence / 100).toFixed(2),
    provider_counterparty_id: item.provider_counterparty_id,
    provider_recipient_account_id: item.provider_recipient_account_id,
    source_account_id: sourceAccountId,
    provider_request_id: item.provider_request_id,
    idempotency_key_reserve: item.idempotency_reserve_key,
    idempotency_key_submit: item.idempotency_submit_key,
    ledger_effect_if_completed: {
      type: "WEEKLY_PAYOUT",
      amount_pence: -item.amount_pence,
      live_wallet_delta_pence: -item.amount_pence,
    },
    rollback_on_safe_failure: "release_driver_payout_reservation",
  }));

  if (!moneyPath) {
    const runStatus = ORCHESTRATOR_RUN_STATUS.BLOCKED;
    const batchStatus = ORCHESTRATOR_BATCH_STATUS.BLOCKED;
    if (batchId && !dryRun) {
      // Use Slice 6âreservable batch status so enabling LIVE can reserve without admin.
      await supabase.from("payout_batches").update({
        status: "BLOCKED_EXECUTION_DISABLED",
        blocker_code: blocker,
        failure_code: blocker,
        failure_reason: blocker ? orchestratorBlockerLabel(blocker) : null,
        updated_at: new Date().toISOString(),
      }).eq("id", batchId);
      // Mark items blocked (not paid) without implying additive unpaid liability.
      await supabase.from("payout_items").update({
        status: "BLOCKED_EXECUTION_DISABLED",
        execution_status: "BLOCKED_EXECUTION_DISABLED",
        updated_at: new Date().toISOString(),
      }).eq("batch_id", batchId).in("status", ["CREATED", "VALIDATED", "BLOCKED_EXECUTION_DISABLED"]);
    }

    const resultJson = {
      dry_run: dryRun,
      schedule_occurrence_key: occurrenceKey,
      scheduled_local_at: occurrence.scheduled_local_at,
      batch_id: batchId,
      batch_reused: batchReused,
      batch_status: batchStatus,
      blocker_code: blocker,
      blocker_label: blocker ? orchestratorBlockerLabel(blocker) : null,
      funding: {
        ...fundingGate,
        source_account_id: sourceAccountId,
        source_account_label: sourceLabel,
        result: fundingGate.result,
      },
      expected_drivers: plan.eligible_driver_count,
      required_batch_pence: plan.required_batch_pence,
      items: plan.items,
      provider_request_payloads: providerPayloads,
      revolut_pay_called: false,
      wallet_debited: false,
      money_path_allowed: false,
      live_payout_execution_enabled: live,
      revolut_payment_transport_enabled: transport,
    };

    await supabase.rpc("finish_weekly_payout_occurrence", {
      p_run_id: runId,
      p_status: runStatus,
      p_batch_id: batchId,
      p_blocker_code: blocker,
      p_required_batch_pence: plan.required_batch_pence,
      p_funding_available_pence: fundingAvailable,
      p_funding_result: fundingGate.result,
      p_money_path_executed: false,
      p_result_json: resultJson,
    });

    return json({
      success: true,
      dry_run: dryRun,
      schedule_occurrence_key: occurrenceKey,
      run_id: runId,
      batch_id: batchId,
      batch_reused: batchReused,
      status: runStatus,
      batch_status: batchStatus,
      blocker_code: blocker,
      blocker_label: blocker ? orchestratorBlockerLabel(blocker) : null,
      funding: resultJson.funding,
      expected_drivers: plan.eligible_driver_count,
      required_batch_pence: plan.required_batch_pence,
      items: plan.items,
      provider_request_payloads: providerPayloads,
      revolut_pay_called: false,
      wallet_debited: false,
      money_path_allowed: false,
      live_payout_execution_enabled: live,
      revolut_payment_transport_enabled: transport,
      message: blocker
        ? orchestratorBlockerLabel(blocker)
        : (dryRun ? "Dry-run complete â no money moved" : "Blocked â no money moved"),
    });
  }

  // --- LIVE money path ---
  // Make batch/items reservable (CREATED / planning-blocked â VALIDATED + ITEMS_CREATED).
  await supabase.from("payout_batches").update({
    status: "ITEMS_CREATED",
    blocker_code: null,
    failure_code: null,
    failure_reason: null,
    updated_at: new Date().toISOString(),
  }).eq("id", batchId!).in("status", [
    "ELIGIBILITY_SNAPSHOTTED",
    "ITEMS_CREATED",
    "BLOCKED",
    "BLOCKED_EXECUTION_DISABLED",
    "PLANNED",
    "PROCESSING",
  ]);
  await supabase.from("payout_items").update({
    status: "VALIDATED",
    execution_status: "VALIDATED",
    updated_at: new Date().toISOString(),
  }).eq("batch_id", batchId!).in("status", [
    "CREATED",
    "VALIDATED",
    "BLOCKED_EXECUTION_DISABLED",
  ]);

  const itemOutcomes: Array<Record<string, unknown>> = [];
  let anyPayCalled = false;
  let anyDebited = false;

  for (const p of moneyWork) {
    const payoutItemId = itemIdsByDriver.get(p.driver_id);
    if (!payoutItemId) {
      itemOutcomes.push({
        driver_id: p.driver_id,
        status: ORCHESTRATOR_ITEM_STATUS.FAILED_PERMANENT,
        error: "missing_payout_item",
      });
      continue;
    }

    const { data: itemRow } = await supabase
      .from("payout_items")
      .select(
        "id, status, execution_status, provider_request_id, provider_reference, amount_pence",
      )
      .eq("id", payoutItemId)
      .maybeSingle();
    const itemStatus = String(
      (itemRow as { status?: string } | null)?.status
        ?? (itemRow as { execution_status?: string } | null)?.execution_status
        ?? "",
    ).toUpperCase();
    let existingPaymentId =
      (itemRow as { provider_reference?: string | null } | null)?.provider_reference
        ? String((itemRow as { provider_reference: string }).provider_reference)
        : null;
    if (!existingPaymentId) {
      const { data: intentRow } = await supabase
        .from("driver_payout_payment_intents")
        .select("provider_payment_id, execution_status, provider_state")
        .eq("payout_item_id", payoutItemId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if ((intentRow as { provider_payment_id?: string | null } | null)?.provider_payment_id) {
        existingPaymentId = String(
          (intentRow as { provider_payment_id: string }).provider_payment_id,
        );
      }
    }

    if (itemStatus === "COMPLETED" || itemStatus === "PAID") {
      anyDebited = true;
      itemOutcomes.push({
        driver_id: p.driver_id,
        driver_name: p.driver_name,
        payout_item_id: payoutItemId,
        amount_pence: p.amount_pence,
        status: ORCHESTRATOR_ITEM_STATUS.COMPLETED,
        provider_payment_id: existingPaymentId,
        reused: true,
      });
      continue;
    }

    // Reconcile already-submitted / UNKNOWN items (no second /pay, no re-reserve).
    if (isOrchestratorReconcileOnlyItemStatus(itemStatus) || existingPaymentId) {
      if (!existingPaymentId) {
        // Timeout/UNKNOWN after possible accept: keep reservation; never blind-retry /pay.
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: itemStatus === "UNKNOWN"
            ? ORCHESTRATOR_ITEM_STATUS.SUBMITTING
            : ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE,
          error: ORCHESTRATOR_BLOCKER.PROVIDER_STATUS_PENDING,
          note: itemStatus === "UNKNOWN"
            ? "UNKNOWN â reservation kept; no debit and no second /pay until provider id known"
            : "Submitted without provider_payment_id â needs reconcile",
          reservation_kept_active: true,
        });
        continue;
      }
      let accessToken: string;
      try {
        const tok = await ensureFreshRevolutBusinessAccessToken(supabase);
        accessToken = tok.accessToken;
      } catch (err) {
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.PROVIDER_ACCEPTED,
          provider_payment_id: existingPaymentId,
          error: ORCHESTRATOR_BLOCKER.PROVIDER_UNAVAILABLE,
          message: err instanceof Error ? err.message : "token",
        });
        continue;
      }
      const statusResult = await relayDriverPayoutPaymentStatus({
        providerPaymentId: existingPaymentId,
        accessToken,
        payoutItemId,
      });
      const syncedState = statusResult.provider_state;
      if (!syncedState || !mayFinaliseFromProviderState(syncedState).ok
        || !isCanonicalProviderCompleted(syncedState)) {
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.PROVIDER_ACCEPTED,
          provider_payment_id: existingPaymentId,
          provider_state: syncedState,
          error: ORCHESTRATOR_BLOCKER.PROVIDER_STATUS_PENDING,
        });
        continue;
      }
      const completionEvidence = redactCompletionEvidence({
        provider_payment_id: existingPaymentId,
        provider_state: syncedState,
        provider_request_id: (itemRow as { provider_request_id?: string | null } | null)
          ?.provider_request_id ?? null,
        completed_at: statusResult.completed_at,
        amount_pence: p.amount_pence,
        currency: serviceAreaCurrency,
      });
      const { data: finalized, error: finalizeErr } = await supabase.rpc(
        "finalize_driver_payout_completion",
        {
          p_payout_item_id: payoutItemId,
          p_provider_payment_id: existingPaymentId,
          p_provider_state: "completed",
          p_provider_completed_at: statusResult.completed_at,
          p_evidence_redacted: completionEvidence,
        },
      );
      if (finalizeErr || (finalized as Record<string, unknown>)?.ok === false) {
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.PROVIDER_ACCEPTED,
          error: finalizeErr?.message ?? "finalize_failed",
          provider_payment_id: existingPaymentId,
        });
        continue;
      }
      anyDebited = true;
      itemOutcomes.push({
        driver_id: p.driver_id,
        driver_name: p.driver_name,
        payout_item_id: payoutItemId,
        amount_pence: p.amount_pence,
        status: ORCHESTRATOR_ITEM_STATUS.COMPLETED,
        provider_payment_id: existingPaymentId,
        reconciled: true,
      });
      continue;
    }

    if (itemStatus !== "RESERVED" && itemStatus !== "RESERVING") {
      const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
        "reserve_driver_payout_item",
        { p_payout_item_id: payoutItemId },
      );
      if (reserveErr || (reserveRaw as Record<string, unknown>)?.ok === false) {
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE,
          error: reserveErr?.message
            ?? (reserveRaw as Record<string, unknown>)?.error
            ?? (reserveRaw as Record<string, unknown>)?.error_code
            ?? "reserve_failed",
        });
        continue;
      }
    }

    // Submit
    const amountGate = evaluateBatchFundingGate({
      required_batch_pence: p.amount_pence,
      available_pence: fundingAvailable,
    });
    if (amountGate.result !== FUNDING_RESULT.SUFFICIENT || !sourceAccountId) {
      await supabase.rpc("release_driver_payout_reservation", {
        p_payout_item_id: payoutItemId,
        p_release_reason: "INSUFFICIENT_SETTLED_FUNDS",
      });
      itemOutcomes.push({
        driver_id: p.driver_id,
        payout_item_id: payoutItemId,
        status: ORCHESTRATOR_ITEM_STATUS.RESERVATION_RELEASED,
        error: ORCHESTRATOR_BLOCKER.INSUFFICIENT_SETTLED_FUNDS,
      });
      continue;
    }

    let accessToken: string;
    try {
      const tok = await ensureFreshRevolutBusinessAccessToken(supabase);
      accessToken = tok.accessToken;
    } catch (err) {
      await supabase.rpc("release_driver_payout_reservation", {
        p_payout_item_id: payoutItemId,
        p_release_reason: "PROVIDER_UNAVAILABLE",
      });
      itemOutcomes.push({
        driver_id: p.driver_id,
        payout_item_id: payoutItemId,
        status: ORCHESTRATOR_ITEM_STATUS.RESERVATION_RELEASED,
        error: ORCHESTRATOR_BLOCKER.PROVIDER_UNAVAILABLE,
        message: err instanceof Error ? err.message : "token",
      });
      continue;
    }

    const { data: claimSubRaw, error: claimSubErr } = await supabase.rpc(
      "claim_driver_payout_submission",
      {
        p_payout_item_id: payoutItemId,
        p_source_account_id: sourceAccountId,
        p_claim_token: crypto.randomUUID(),
      },
    );
    if (claimSubErr || (claimSubRaw as Record<string, unknown>)?.ok !== true) {
      const errCode = String((claimSubRaw as Record<string, unknown>)?.error ?? claimSubErr?.message ?? "");
      if (errCode === "ALREADY_SUBMITTED") {
        // Fall through to reconcile on next tick via PROVIDER_ACCEPTED / payment id.
        const alreadyId = (claimSubRaw as Record<string, unknown>)?.provider_payment_id
          ? String((claimSubRaw as Record<string, unknown>).provider_payment_id)
          : existingPaymentId;
        if (alreadyId) {
          const statusResult = await relayDriverPayoutPaymentStatus({
            providerPaymentId: alreadyId,
            accessToken,
            payoutItemId,
          });
          const syncedState = statusResult.provider_state;
          if (syncedState && mayFinaliseFromProviderState(syncedState).ok
            && isCanonicalProviderCompleted(syncedState)) {
            const completionEvidence = redactCompletionEvidence({
              provider_payment_id: alreadyId,
              provider_state: syncedState,
              completed_at: statusResult.completed_at,
              amount_pence: p.amount_pence,
              currency: serviceAreaCurrency,
            });
            const { data: finalized, error: finalizeErr } = await supabase.rpc(
              "finalize_driver_payout_completion",
              {
                p_payout_item_id: payoutItemId,
                p_provider_payment_id: alreadyId,
                p_provider_state: "completed",
                p_provider_completed_at: statusResult.completed_at,
                p_evidence_redacted: completionEvidence,
              },
            );
            if (!finalizeErr && (finalized as Record<string, unknown>)?.ok !== false) {
              anyDebited = true;
              itemOutcomes.push({
                driver_id: p.driver_id,
                driver_name: p.driver_name,
                payout_item_id: payoutItemId,
                amount_pence: p.amount_pence,
                status: ORCHESTRATOR_ITEM_STATUS.COMPLETED,
                provider_payment_id: alreadyId,
                reused: true,
              });
              continue;
            }
          }
        }
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.PROVIDER_ACCEPTED,
          provider_payment_id: alreadyId,
          reused: true,
          error: ORCHESTRATOR_BLOCKER.PROVIDER_STATUS_PENDING,
        });
      } else if (shouldReleaseReservationOnSubmitClaimFailure(errCode)) {
        await supabase.rpc("release_driver_payout_reservation", {
          p_payout_item_id: payoutItemId,
          p_release_reason: "SUBMIT_CLAIM_FAILED",
        });
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.RESERVATION_RELEASED,
          error: errCode || "claim_failed",
        });
      } else {
        // UNKNOWN_NO_BLIND_RETRY etc. â keep reservation; later tick reconciles.
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.SUBMITTING,
          error: errCode || "claim_failed_keep_reservation",
          reservation_kept_active: true,
          note: "No reservation release; no second /pay",
        });
      }
      continue;
    }
    const claimSub = claimSubRaw as Record<string, unknown>;

    const paymentBody: Record<string, unknown> = {
      payout_item_id: String(claimSub.payout_item_id),
      driver_id: String(claimSub.driver_id),
      payout_destination_id: String(claimSub.payout_destination_id),
      source_account_id: String(claimSub.source_account_id),
      provider_counterparty_id: String(claimSub.provider_counterparty_id),
      provider_recipient_account_id: String(claimSub.provider_recipient_account_id),
      amount_pence: Number(claimSub.amount_pence),
      currency: String(claimSub.currency ?? "GBP"),
      payment_reference: claimSub.payment_reference ?? null,
      provider_request_id: canonicalProviderRequestId(String(claimSub.payout_item_id)),
      idempotency_key: canonicalIdempotencyKey(String(claimSub.payout_item_id)),
    };

    const { data: dest } = await supabase
      .from("driver_payout_destinations")
      .select(
        "id, driver_id, currency_code, verification_status, provider_link_status, provider_counterparty_id, provider_recipient_account_id, is_active, archived_at",
      )
      .eq("id", String(claimSub.payout_destination_id))
      .maybeSingle();

    const validated = validateApprovedDriverPayoutPayment({ body: paymentBody, destination: dest });
    if (!validated.ok) {
      await supabase.rpc("finalize_driver_payout_submission", {
        p_payout_item_id: payoutItemId,
        p_claim_token: String(claimSub.claim_token),
        p_execution_status: "FAILED",
        p_provider_failure_code: validated.code,
        p_provider_failure_reason_safe: validated.message,
        p_evidence_redacted: { validation_failed: true },
        p_release_reservation: true,
      });
      itemOutcomes.push({
        driver_id: p.driver_id,
        payout_item_id: payoutItemId,
        status: ORCHESTRATOR_ITEM_STATUS.RESERVATION_RELEASED,
        error: validated.code,
      });
      continue;
    }

    if (!isRevolutBusinessRelayConfigured()) {
      await supabase.rpc("abort_driver_payout_submission_claim", {
        p_payout_item_id: payoutItemId,
        p_claim_token: String(claimSub.claim_token),
        p_failure_code: ORCHESTRATOR_BLOCKER.PROVIDER_UNAVAILABLE,
        p_failure_reason_safe: "relay not configured",
      });
      itemOutcomes.push({
        driver_id: p.driver_id,
        payout_item_id: payoutItemId,
        status: ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE,
        error: ORCHESTRATOR_BLOCKER.PROVIDER_UNAVAILABLE,
        reservation_kept_active: true,
      });
      continue;
    }

    let timedOut = false;
    let relayResult: Awaited<ReturnType<typeof relayApprovedDriverPayoutPayment>>;
    try {
      relayResult = await relayApprovedDriverPayoutPayment({
        body: {
          payout_item_id: validated.normalized.payout_item_id,
          driver_id: validated.normalized.driver_id,
          payout_destination_id: validated.normalized.payout_destination_id,
          source_account_id: validated.normalized.source_account_id,
          provider_counterparty_id: validated.normalized.provider_counterparty_id,
          provider_recipient_account_id: validated.normalized.provider_recipient_account_id,
          amount_pence: validated.normalized.amount_pence,
          currency: validated.normalized.currency,
          payment_reference: validated.normalized.payment_reference,
          provider_request_id: validated.normalized.provider_request_id,
          idempotency_key: validated.normalized.idempotency_key,
        },
        idempotencyKey: validated.normalized.idempotency_key,
        accessToken,
        timeoutMs: 25_000,
      });
    } catch {
      timedOut = true;
      relayResult = {
        status: 0,
        error: "relay_timeout",
        revolut_pay_called: true,
        provider_payment_id: null,
        provider_state: null,
        json: {},
      };
    }

    if (relayResult.revolut_pay_called === true) anyPayCalled = true;

    const providerPaymentId = relayResult.provider_payment_id
      ?? (typeof relayResult.json?.id === "string" ? String(relayResult.json.id) : null);
    const providerState = relayResult.provider_state
      ?? (typeof relayResult.json?.state === "string" ? String(relayResult.json.state) : null);

    const outcome = mapProviderSubmissionOutcome({
      http_ok: relayResult.status >= 200 && relayResult.status < 300,
      timed_out: timedOut || relayResult.error === "relay_timeout",
      provider_payment_id: providerPaymentId,
      provider_state: providerState,
      hard_reject: relayResult.revolut_pay_called === true
        && relayResult.status >= 400
        && relayResult.status < 500
        && !timedOut
        && !providerPaymentId,
    });

    const evidence = redactProviderEvidence({
      provider_payment_id: providerPaymentId,
      provider_state: providerState,
      provider_request_id: validated.normalized.provider_request_id,
      amount_pence: validated.normalized.amount_pence,
      currency: validated.normalized.currency,
    });

    await supabase.rpc("finalize_driver_payout_submission", {
      p_payout_item_id: payoutItemId,
      p_claim_token: String(claimSub.claim_token),
      p_execution_status: outcome.execution_status,
      p_provider_payment_id: providerPaymentId,
      p_provider_state: providerState,
      p_provider_failure_code: outcome.failure_code,
      p_provider_failure_reason_safe: outcome.failure_reason,
      p_evidence_redacted: evidence,
      p_release_reservation: outcome.release_reservation === true,
    });

    if (outcome.release_reservation) {
      itemOutcomes.push({
        driver_id: p.driver_id,
        payout_item_id: payoutItemId,
        status: ORCHESTRATOR_ITEM_STATUS.RESERVATION_RELEASED,
        error: outcome.failure_code,
      });
      continue;
    }

    if (outcome.execution_status !== "SUBMITTED" || !providerPaymentId) {
      itemOutcomes.push({
        driver_id: p.driver_id,
        payout_item_id: payoutItemId,
        status: timedOut
          ? ORCHESTRATOR_ITEM_STATUS.SUBMITTING
          : ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE,
        error: outcome.failure_code ?? ORCHESTRATOR_BLOCKER.PROVIDER_STATUS_PENDING,
        provider_payment_id: providerPaymentId,
        note: timedOut
          ? "Timeout/unknown â reservation kept; no debit until provider truth known"
          : undefined,
      });
      continue;
    }

    // Finalize when provider completed
    const statusResult = await relayDriverPayoutPaymentStatus({
      providerPaymentId,
      accessToken,
      payoutItemId,
    });
    const syncedState = statusResult.provider_state ?? providerState;
    if (!syncedState || !mayFinaliseFromProviderState(syncedState).ok
      || !isCanonicalProviderCompleted(syncedState)) {
      itemOutcomes.push({
        driver_id: p.driver_id,
        payout_item_id: payoutItemId,
        status: ORCHESTRATOR_ITEM_STATUS.PROVIDER_ACCEPTED,
        provider_payment_id: providerPaymentId,
        provider_state: syncedState,
        error: ORCHESTRATOR_BLOCKER.PROVIDER_STATUS_PENDING,
      });
      continue;
    }

    const completionEvidence = redactCompletionEvidence({
      provider_payment_id: providerPaymentId,
      provider_state: syncedState,
      provider_request_id: validated.normalized.provider_request_id,
      completed_at: statusResult.completed_at,
      amount_pence: p.amount_pence,
      currency: serviceAreaCurrency,
    });

    const { data: finalized, error: finalizeErr } = await supabase.rpc(
      "finalize_driver_payout_completion",
      {
        p_payout_item_id: payoutItemId,
        p_provider_payment_id: providerPaymentId,
        p_provider_state: "completed",
        p_provider_completed_at: statusResult.completed_at,
        p_evidence_redacted: completionEvidence,
      },
    );
    if (finalizeErr || (finalized as Record<string, unknown>)?.ok === false) {
      itemOutcomes.push({
        driver_id: p.driver_id,
        payout_item_id: payoutItemId,
        status: ORCHESTRATOR_ITEM_STATUS.PROVIDER_ACCEPTED,
        error: finalizeErr?.message ?? "finalize_failed",
        provider_payment_id: providerPaymentId,
      });
      continue;
    }

    anyDebited = true;
    itemOutcomes.push({
      driver_id: p.driver_id,
      driver_name: p.driver_name,
      payout_item_id: payoutItemId,
      amount_pence: p.amount_pence,
      status: ORCHESTRATOR_ITEM_STATUS.COMPLETED,
      provider_payment_id: providerPaymentId,
    });
  }

  const finish = resolveOrchestratorRunFinish({
    item_statuses: itemOutcomes.map((o) => String(o.status)),
    any_pay_called: anyPayCalled,
    any_debited: anyDebited,
  });
  const agg = finish.batch_aggregate;
  if (batchId) {
    await supabase.from("payout_batches").update({
      status: agg.status,
      blocker_code: null,
      successful_payouts: agg.successful,
      failed_payouts: agg.failed,
      updated_at: new Date().toISOString(),
    }).eq("id", batchId);
  }

  const resultJson = {
    dry_run: false,
    schedule_occurrence_key: occurrenceKey,
    batch_id: batchId,
    batch_status: agg.status,
    funding: fundingGate,
    items: itemOutcomes,
    revolut_pay_called: anyPayCalled,
    wallet_debited: anyDebited,
    unfinished_count: agg.unfinished,
    live_payout_execution_enabled: live,
    revolut_payment_transport_enabled: transport,
  };

  await supabase.rpc("finish_weekly_payout_occurrence", {
    p_run_id: runId,
    p_status: finish.run_status,
    p_batch_id: batchId,
    p_blocker_code: null,
    p_required_batch_pence: requiredBatchPence,
    p_funding_available_pence: fundingAvailable,
    p_funding_result: fundingGate.result,
    p_money_path_executed: finish.money_path_executed,
    p_result_json: resultJson,
  });

  return json({
    success: true,
    dry_run: false,
    schedule_occurrence_key: occurrenceKey,
    run_id: runId,
    batch_id: batchId,
    status: finish.run_status,
    batch_status: agg.status,
    funding: fundingGate,
    items: itemOutcomes,
    revolut_pay_called: anyPayCalled,
    wallet_debited: anyDebited,
    money_path_executed: finish.money_path_executed,
    live_payout_execution_enabled: live,
    revolut_payment_transport_enabled: transport,
    message: finish.run_status === ORCHESTRATOR_RUN_STATUS.RUNNING
      ? "Orchestrator in progress â later ticks will reconcile unfinished items"
      : `Orchestrator finished â ${agg.status}`,
  });
});
