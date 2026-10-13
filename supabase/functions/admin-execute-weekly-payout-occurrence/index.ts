import type { AnySupabaseClient } from "../_shared/supabaseClientTypes.ts";
/**
 * Canonical weekly payout orchestrator.
 * Cron + admin entry: claim occurrence â eligibility â batch â funding â
 * (LIVE+TRANSPORT only) reserve â Revolut submit â finalize â WEEKLY_PAYOUT debit.
 *
 * LIVE_PAYOUT_EXECUTION_ENABLED=false stops after planning with LIVE_PAYOUT_ROLLOUT_DISABLED.
 * dry_run=true never reserves, never calls Revolut, never debits.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { loadPayoutControlCentreSettings } from "../_shared/payoutControlCentreSettingsSSOT.ts";
import { resolveLiveCompanyBalanceSnapshot } from "../_shared/companyBalanceResolveSSOT.ts";
import { fetchDriverPayoutEligibility } from "../_shared/fetchDriverPayoutEligibility.ts";
import { planPayoutItemFromEligibleEntries, type PlannedLedgerAllocation } from "../_shared/payoutLedgerHandoffSSOT.ts";
import {
  WEEKLY_PAYOUT_FEE_PENCE,
  freezeWeeklyOccurrencePeriod,
  resolveWeeklyOccurrenceMoneyAmounts,
  resolveWeeklyPayableAmountPence,
  selectWeeklyPeriodPayableCredits,
} from "../_shared/weeklyPayoutPeriodSSOT.ts";
import {
  STALE_UNSUBMITTED_RETIRE_RPC,
  isStaleUnsubmittedWeeklyItemCandidate,
} from "../_shared/payoutItemLifecycleSSOT.ts";
import {
  assertPayoutItemLedgerLineage,
  persistPayoutItemLedgerAllocations,
} from "../_shared/payoutItemLedgerAllocationWrite.ts";
import {
  isConflictingActivePayoutItem,
  WEEKLY_PAYOUT_BATCH_KIND,
  evaluateDriverBatchEligibility,
  isPayoutDriverDeleted,
  isPayoutDriverHeldOrBlocked,
  isLivePayoutExecutionEnabled,
  isRevolutPaymentTransportEnabled,
  itemIdempotencyKey,
  resolveMostRecentDueOccurrence,
  resolveScheduleOccurrence,
  slugifyServiceAreaName,
  type ScheduleOccurrence,
  type ScheduleSettingsSnapshot,
} from "../_shared/weeklyDriverPayoutBatchWorkflowSSOT.ts";
import { FINANCIAL_MODEL, resolveServiceAreaFinancialScope } from "../_shared/financialModelScopeGate.ts";
import { resolvePlatformCollectedDriverIds } from "../_shared/platformCollectedDriverScope.ts";
import {
  FUNDING_RESULT,
  ORCHESTRATOR_BATCH_STATUS,
  ORCHESTRATOR_BLOCKER,
  ORCHESTRATOR_ITEM_STATUS,
  ORCHESTRATOR_RUN_STATUS,
  allocateRunningPayoutFunding,
  buildOrchestratorPlanSnapshot,
  buildPayoutFundingAttemptSnapshot,
  classifyPayoutReversalProviderState,
  type RunningFundingDecision,
  classifyWeeklyOccurrenceClaimFailure,
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
  relayApprovedDriverPayoutPaymentStatus,
} from "../_shared/revolutBusinessRelayClient.ts";
import { ensureFreshRevolutBusinessAccessToken } from "../_shared/revolutBusinessAccessTokenRefresh.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
  "Content-Type": "application/json",
};

type AnySupabase = AnySupabaseClient;

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
  try {
    return await handleWeeklyPayoutOccurrence(req);
  } catch (err) {
    console.error("[orchestrator] unhandled", err);
    return json({
      success: false,
      error: "unhandled_orchestrator_exception",
      message: err instanceof Error ? err.message : String(err),
      revolut_pay_called: false,
      wallet_debited: false,
    }, 500);
  }
});

async function handleWeeklyPayoutOccurrence(req: Request): Promise<Response> {

  const live = isLivePayoutExecutionEnabled();
  const transport = isRevolutPaymentTransportEnabled();

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  if (body.health === true || body.boot_probe === true) {
    const baseHealth = {
      ok: true,
      function: "admin-execute-weekly-payout-occurrence",
      boot: "ok",
      live_payout_execution_enabled: live,
      revolut_payment_transport_enabled: transport,
      revolut_business_relay_configured: isRevolutBusinessRelayConfigured(),
    };
    if (body.funding_probe !== true) {
      return json(baseHealth);
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const probeClient = createClient(supabaseUrl, supabaseServiceKey);
    const auth = await assertCronOrServiceRoleAuth(req, body);
    if (!auth.ok) return auth.response;
    let fundingAvailable: number | null = null;
    let sourceAccountId: string | null = null;
    let sourceLabel: string | null = null;
    let balanceStatus = "UNAVAILABLE";
    try {
      const companyBalance = await resolveLiveCompanyBalanceSnapshot({
        supabase: probeClient,
        currency: "GBP",
      });
      fundingAvailable = companyBalance.provider_available_balance_pence
        ?? companyBalance.provider_cash_balance_pence
        ?? null;
      sourceAccountId = companyBalance.source_account_id ?? null;
      sourceLabel = companyBalance.source_account_label ?? null;
      balanceStatus = String(companyBalance.status_code ?? companyBalance.status ?? "UNAVAILABLE");
    } catch (err) {
      console.warn("[orchestrator] funding_probe balance read failed", err);
    }
    const requiredBatchPence = 1703;
    const fundingGate = evaluateBatchFundingGate({
      required_batch_pence: requiredBatchPence,
      available_pence: fundingAvailable,
    });
    return json({
      ...baseHealth,
      funding_probe: {
        read_only: true,
        source: "relay_revolut_business_accounts",
        balance_status: balanceStatus,
        source_account_id: sourceAccountId,
        source_account_label: sourceLabel,
        settled_available_pence: fundingAvailable,
        required_batch_pence: requiredBatchPence,
        funding_result: fundingGate.result,
        blocker_code: fundingGate.blocker_code,
        shortfall_pence: fundingAvailable != null && fundingAvailable < requiredBatchPence
          ? requiredBatchPence - fundingAvailable
          : null,
        surplus_pence: fundingAvailable != null && fundingAvailable >= requiredBatchPence
          ? fundingAvailable - requiredBatchPence
          : null,
      },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
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
      ...classifyWeeklyOccurrenceClaimFailure({ message: claimErr.message }),
      revolut_pay_called: false,
      wallet_debited: false,
    }, 500);
  }
  const claim = (claimRaw ?? {}) as Record<string, unknown>;
  if (claim.ok !== true) {
    return json({
      ...classifyWeeklyOccurrenceClaimFailure({
        message: String(claim.error ?? "claim_failed"),
        code: String(claim.error ?? ""),
      }),
      revolut_pay_called: false,
      wallet_debited: false,
    }, 500);
  }
  const runId = String(claim.run_id);
  const occurrencePeriod = freezeWeeklyOccurrencePeriod({
    frozen_period_start: claim.period_start != null ? String(claim.period_start) : null,
    frozen_period_end: claim.period_end != null ? String(claim.period_end) : null,
    scheduled_local_at: occurrence.scheduled_local_at,
    schedule_occurrence_key: occurrenceKey,
    timezone: occurrence.timezone,
  });
  if (claim.period_start == null || claim.period_end == null) {
    await supabase.from("weekly_payout_occurrence_runs").update({
      period_start: occurrencePeriod.period_start,
      period_end: occurrencePeriod.period_end,
      updated_at: new Date().toISOString(),
    }).eq("id", runId).is("period_start", null);
  }
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

  // --- Eligibility + batch create/reuse (PLATFORM_COLLECTED drivers only) ---
  const modelScope = await resolveServiceAreaFinancialScope(
    supabase,
    FINANCIAL_MODEL.PLATFORM_COLLECTED,
    resolvedServiceAreaId,
  );
  if (!modelScope.ok) {
    return json({
      success: false,
      error: modelScope.error,
      error_code: modelScope.code,
    }, 400);
  }
  const platformDriverIds = await resolvePlatformCollectedDriverIds(supabase, {
    service_area_id: resolvedServiceAreaId,
    allowed_service_area_ids: modelScope.allowedServiceAreaIds,
  });
  if (platformDriverIds.length === 0) {
    return json({
      success: true,
      planned_count: 0,
      message: "No PLATFORM_COLLECTED drivers in scope",
      revolut_pay_called: false,
      wallet_debited: false,
    });
  }

  let driverQuery = supabase
    .from("drivers")
    .select(
      "id, region_id, service_area_id, first_name, last_name, payouts_enabled, payout_operational_paused, approval_status, driver_status, deleted_at",
    )
    .eq("approval_status", "approved")
    .in("id", platformDriverIds);
  if (regionId) driverQuery = driverQuery.eq("region_id", regionId);
  if (resolvedServiceAreaId) driverQuery = driverQuery.eq("service_area_id", resolvedServiceAreaId);
  const { data: drivers, error: driversError } = await driverQuery;
  if (driversError) return json({ success: false, error: driversError.message }, 500);

  const driverIds = (drivers ?? []).map((d) => String(d.id));

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
  const staleItemOutcomes: Array<Record<string, unknown>> = [];
  if (driverIds.length > 0) {
    const { data: activeItems } = await supabase
      .from("payout_items")
      .select(
        "id, batch_id, driver_id, status, execution_status, provider_reference, provider_payout_id, provider_transfer_id, ledger_entry_id",
      )
      .in("driver_id", driverIds);
    const conflicting = (activeItems ?? []).filter((item) =>
      isConflictingActivePayoutItem({
        status: item.status,
        execution_status: item.execution_status,
      })
    );
    const conflictBatchIds = [...new Set(conflicting.map((item) => String(item.batch_id)))];
    const batchById = new Map<string, { kind: string | null; schedule_occurrence_key: string | null }>();
    if (conflictBatchIds.length > 0) {
      const { data: conflictBatches } = await supabase
        .from("payout_batches")
        .select("id, kind, schedule_occurrence_key")
        .in("id", conflictBatchIds);
      for (const b of conflictBatches ?? []) {
        batchById.set(String(b.id), {
          kind: b.kind == null ? null : String(b.kind),
          schedule_occurrence_key: b.schedule_occurrence_key == null
            ? null
            : String(b.schedule_occurrence_key),
        });
      }
    }
    for (const item of conflicting) {
      const batch = batchById.get(String(item.batch_id));
      const candidate = batch != null && isStaleUnsubmittedWeeklyItemCandidate({
        status: item.status,
        execution_status: item.execution_status,
        batch_kind: batch.kind,
        batch_schedule_occurrence_key: batch.schedule_occurrence_key,
        current_schedule_occurrence_key: occurrenceKey,
        provider_reference: item.provider_reference,
        provider_payout_id: item.provider_payout_id,
        provider_transfer_id: item.provider_transfer_id,
        ledger_entry_id: item.ledger_entry_id,
      });
      if (candidate) {
        const { data: retired, error: retireErr } = await supabase.rpc(STALE_UNSUBMITTED_RETIRE_RPC, {
          p_payout_item_id: String(item.id),
          p_reason: `superseded_by_occurrence:${occurrenceKey}`,
          p_actor: scheduledRun ? "pg_cron_orchestrator" : "admin_orchestrator",
          p_dry_run: dryRun,
        });
        const result = (retired ?? {}) as Record<string, unknown>;
        const retiredOk = !retireErr && result.ok === true;
        staleItemOutcomes.push({
          payout_item_id: String(item.id),
          driver_id: String(item.driver_id),
          dry_run: dryRun,
          retired: retiredOk && !dryRun,
          would_retire: retiredOk && dryRun,
          error: retireErr?.message ?? (retiredOk ? null : String(result.error ?? "retire_refused")),
          released_allocation_pence: result.released_allocation_pence ?? null,
        });
        if (retiredOk) continue;
      }
      conflictDrivers.add(String(item.driver_id));
    }

    // Cross-run: a provider intent still in flight blocks a new item even when its
    // payout_items row was (wrongly) left terminal by an earlier run.
    const { data: openIntents, error: openIntentsErr } = await supabase
      .from("driver_payout_payment_intents")
      .select("driver_id, payout_item_id, execution_status")
      .in("driver_id", driverIds)
      .in("execution_status", ["SUBMITTING", "SUBMITTED", "UNKNOWN", "PROCESSING"]);
    if (openIntentsErr) {
      return json({
        success: false,
        error: "open_intent_check_failed",
        message: openIntentsErr.message,
        revolut_pay_called: false,
        wallet_debited: false,
      }, 500);
    }
    for (const intent of openIntents ?? []) {
      conflictDrivers.add(String(intent.driver_id));
    }
  }

  type Planned = {
    driver_id: string;
    driver_name: string | null;
    amount_pence: number;
    allocations: PlannedLedgerAllocation[];
    payout_destination_id: string;
    provider_counterparty_id: string;
    provider_recipient_account_id: string;
    wallet_snapshot_balance_pence: number;
    wallet_snapshot_available_pence: number;
    eligibility_snapshot: Record<string, unknown>;
    destination_verified: boolean;
  };
  const planned: Planned[] = [];
  const deletedDriversHeldForReview: Array<Record<string, unknown>> = [];
  for (const driver of drivers ?? []) {
    const driverId = String(driver.id);
    const dest = destByDriver.get(driverId) ?? null;
    const held = isPayoutDriverHeldOrBlocked(driver);
    const eligibility = await fetchDriverPayoutEligibility(supabase, { driver_id: driverId });
    if (isPayoutDriverDeleted(driver)) {
      // Never planned: no item, no allocation lock, no share of the batch total.
      if (eligibility.live_balance_pence > 0 || eligibility.available_balance_pence > 0) {
        deletedDriversHeldForReview.push({
          driver_id: driverId,
          deleted_at: driver.deleted_at ?? null,
          driver_status: driver.driver_status ?? null,
          wallet_live_balance_pence: eligibility.live_balance_pence,
          wallet_available_pence: eligibility.available_balance_pence,
          reason: "DRIVER_DELETED",
        });
      }
      continue;
    }
    const { data: econRows } = await supabase.rpc("driver_wallet_ledger_economic_fields", {
      p_driver_id: driverId,
    });
    const econById = new Map<string, Record<string, unknown>>();
    for (const row of econRows ?? []) {
      const rec = row as Record<string, unknown>;
      const id = String(rec.ledger_entry_id ?? "");
      if (id) econById.set(id, rec);
    }
    const periodScope = selectWeeklyPeriodPayableCredits({
      period_start: occurrencePeriod.period_start,
      period_end: occurrencePeriod.period_end,
      entries: eligibility.eligible_entries.map((entry) => {
        const econ = econById.get(entry.ledger_entry_id);
        return {
          ledger_entry_id: entry.ledger_entry_id,
          trip_id: entry.trip_id,
          amount_pence: entry.amount_pence,
          type: econ?.type != null ? String(econ.type) : null,
          economic_earned_at: econ?.economic_earned_at != null ? String(econ.economic_earned_at) : null,
          posting_created_at: econ?.posting_created_at != null ? String(econ.posting_created_at) : null,
        };
      }),
    });
    const payable = resolveWeeklyPayableAmountPence({
      scoped_amount_pence: periodScope.amount_pence,
      wallet_available_pence: eligibility.available_balance_pence,
      minimum_payout_pence: controlCentre.payout_min_pence,
    });
    if (payable.amount_pence <= 0) continue;
    // Period scope never exceeds wallet Available: credits already held by an
    // in-flight or stale item must not be planned a second time.
    const scoped = { ...periodScope, amount_pence: payable.amount_pence };
    let lineage: ReturnType<typeof planPayoutItemFromEligibleEntries> = null;
    try {
      lineage = planPayoutItemFromEligibleEntries({
        eligible_entries: scoped.selected.map((e) => ({
          ledger_entry_id: e.ledger_entry_id,
          amount_pence: e.amount_pence,
        })),
        available_balance_pence: scoped.amount_pence,
      });
    } catch {
      lineage = null;
    }
    if (!lineage) continue;
    const decision = evaluateDriverBatchEligibility({
      driver_id: driverId,
      wallet_balance_pence: eligibility.live_balance_pence,
      available_payout_pence: lineage.amount_pence,
      payout_operational_paused: driver.payout_operational_paused === true,
      payouts_enabled: driver.payouts_enabled !== false,
      driver_held_or_blocked: held,
      driver_deleted: false,
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
      amount_pence: lineage.amount_pence,
      allocations: lineage.allocations,
      payout_destination_id: decision.payout_destination_id,
      provider_counterparty_id: decision.provider_counterparty_id,
      provider_recipient_account_id: decision.provider_recipient_account_id,
      wallet_snapshot_balance_pence: decision.wallet_snapshot_balance_pence,
      wallet_snapshot_available_pence: lineage.amount_pence,
      eligibility_snapshot: {
        ...decision.eligibility_snapshot,
        source: "eligible_driver_wallet_ledger_entries",
        weekly_period_scope: true,
        weekly_fee_pence: WEEKLY_PAYOUT_FEE_PENCE,
        period_start: occurrencePeriod.period_start,
        period_end: occurrencePeriod.period_end,
        period_timezone: occurrencePeriod.timezone,
        ledger_allocation_ids: lineage.allocations.map((a) => a.ledger_entry_id),
        period_scoped_amount_pence: periodScope.amount_pence,
        wallet_available_cap_pence: eligibility.available_balance_pence,
        excluded_current_week_pence: scoped.excluded_current_week_pence,
        excluded_older_unpaid_pence: scoped.excluded_older_unpaid_pence,
        included_arrears_pence: scoped.included_arrears_pence,
        previous_week_pence: scoped.previous_week_pence,
        arrears_ledger_allocation_ids: scoped.arrears_selected.map((a) => a.ledger_entry_id),
        previous_week_ledger_allocation_ids: scoped.previous_week_selected.map((a) => a.ledger_entry_id),
      },
      destination_verified: true,
    });
  }

  let requiredBatchPence = planned.reduce((s, p) => s + p.amount_pence, 0);

  // Funding refresh (configured Revolut payout source only).
  let fundingAvailable: number | null = null;
  let sourceAccountId: string | null = null;
  let sourceLabel: string | null = null;
  const balanceReadAt = new Date().toISOString();
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
  }

  const moneyAmounts = resolveWeeklyOccurrenceMoneyAmounts({
    frozen_items: existingBatchItems.map((it) => ({
      driver_id: it.driver_id,
      amount_pence: it.amount_pence,
    })),
    planned_items: planned.map((p) => ({
      driver_id: p.driver_id,
      amount_pence: p.amount_pence,
    })),
  });
  requiredBatchPence = moneyAmounts.required_batch_pence;

  if (!batchId && !dryRun && moneyAmounts.items.length > 0) {
    const runDate = occurrence.scheduled_utc_at.slice(0, 10);
    const { data: batch, error: batchError } = await supabase
      .from("payout_batches")
      .insert({
        kind: WEEKLY_PAYOUT_BATCH_KIND,
        run_date: runDate,
        status: "ELIGIBILITY_SNAPSHOTTED",
        total_drivers: moneyAmounts.items.length,
        total_amount_pence: requiredBatchPence,
        eligible_driver_count: moneyAmounts.items.length,
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
        const plannedItem = planned.find((p) => p.driver_id === String(it.driver_id));
        if (plannedItem) {
          await persistPayoutItemLedgerAllocations({
            supabase,
            payout_item_id: itemId,
            allocations: plannedItem.allocations,
            amount_pence: plannedItem.amount_pence,
          });
        }
      }
    }
    await supabase.from("payout_batches").update({
      status: "ITEMS_CREATED",
      updated_at: new Date().toISOString(),
    }).eq("id", batchId);
  }

  const fundingGate = evaluateBatchFundingGate({
    required_batch_pence: requiredBatchPence,
    available_pence: fundingAvailable,
  });

  const planItems = moneyAmounts.source === "FROZEN_OCCURRENCE_MANIFEST"
    ? existingBatchItems.map((it) => {
      const plannedItem = planned.find((p) => p.driver_id === it.driver_id);
      return {
        driver_id: it.driver_id,
        driver_name: plannedItem?.driver_name ?? null,
        amount_pence: it.amount_pence,
        payout_item_id: it.id,
        payout_destination_id: it.payout_destination_id ?? plannedItem?.payout_destination_id ?? "",
        provider_counterparty_id: it.provider_counterparty_id ?? plannedItem?.provider_counterparty_id ?? "",
        provider_recipient_account_id:
          it.provider_recipient_account_id ?? plannedItem?.provider_recipient_account_id ?? "",
        destination_verified: plannedItem?.destination_verified ?? true,
      };
    })
    : planned.map((p) => ({
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
    isOrchestratorInFlightItemStatus(it.status, it.execution_status)
  );
  type MoneyWork = {
    driver_id: string;
    driver_name: string | null;
    amount_pence: number;
    payout_destination_id: string;
    provider_counterparty_id: string;
    provider_recipient_account_id: string;
  };
  let moneyWork: MoneyWork[] = moneyAmounts.source === "FROZEN_OCCURRENCE_MANIFEST"
    ? existingBatchItems.map((it) => ({
      driver_id: it.driver_id,
      driver_name: planned.find((p) => p.driver_id === it.driver_id)?.driver_name ?? null,
      amount_pence: it.amount_pence,
      payout_destination_id: it.payout_destination_id ?? "",
      provider_counterparty_id: it.provider_counterparty_id ?? "",
      provider_recipient_account_id: it.provider_recipient_account_id ?? "",
    }))
    : planned.map((p) => ({
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

  // Items already submitted / completed spend no new funds; only fresh /pay attempts
  // draw on the single running allowance for this pass.
  const existingStatusByDriver = new Map(
    existingBatchItems.map((it) => [it.driver_id, String(it.status || it.execution_status || "").toUpperCase()]),
  );
  const needsFunding = (driverId: string): boolean => {
    const st = existingStatusByDriver.get(driverId) ?? "";
    return !(st === "COMPLETED" || st === "PAID" || isOrchestratorReconcileOnlyItemStatus(st));
  };
  moneyWork = [...moneyWork].sort((a, b) =>
    a.amount_pence - b.amount_pence || (a.driver_id < b.driver_id ? -1 : a.driver_id > b.driver_id ? 1 : 0)
  );
  const runningFunding = allocateRunningPayoutFunding({
    available_pence: sourceAccountId ? fundingAvailable : null,
    items: moneyWork
      .filter((w) => needsFunding(w.driver_id))
      .map((w) => ({ key: w.driver_id, amount_pence: w.amount_pence })),
  });
  const fundingDecisionByDriver = new Map<string, RunningFundingDecision>(
    runningFunding.decisions.map((d) => [d.key, d]),
  );

  const moneyGate = shouldContinueOrchestratorMoneyPath({
    dry_run: dryRun,
    live_enabled: live,
    transport_enabled: transport,
    has_batch: batchId != null,
    fresh_eligible_count: planned.length,
    in_flight_item_count: inFlightExisting.length,
    blocker_code: blocker,
    fundable_item_count: runningFunding.funded_count,
  });
  if (
    moneyGate.ignore_zero_eligible_blocker
    && (blocker === "ZERO_ELIGIBLE_DRIVERS" || blocker === "INSUFFICIENT_SETTLED_FUNDS")
  ) {
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
      period_start: occurrencePeriod.period_start,
      period_end: occurrencePeriod.period_end,
      period_timezone: occurrencePeriod.timezone,
      weekly_fee_pence: WEEKLY_PAYOUT_FEE_PENCE,
      money_amount_source: moneyAmounts.source,
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
      stale_items: staleItemOutcomes,
      deleted_drivers_held_for_review: deletedDriversHeldForReview,
      running_funding: runningFunding,
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
      stale_items: staleItemOutcomes,
      deleted_drivers_held_for_review: deletedDriversHeldForReview,
      running_funding: runningFunding,
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
    try {
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
        const statusResult = await relayApprovedDriverPayoutPaymentStatus({
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

      // Submit — only against this item's share of the single running allowance.
      const fundingDecision = fundingDecisionByDriver.get(p.driver_id);
      if (!fundingDecision?.funded || fundingDecision.amount_pence !== p.amount_pence || !sourceAccountId) {
        await supabase.rpc("release_driver_payout_reservation", {
          p_payout_item_id: payoutItemId,
          p_release_reason: "INSUFFICIENT_SETTLED_FUNDS",
        });
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.RESERVATION_RELEASED,
          error: ORCHESTRATOR_BLOCKER.INSUFFICIENT_SETTLED_FUNDS,
          funding_remaining_before_pence: fundingDecision?.remaining_before_pence ?? null,
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
            const statusResult = await relayApprovedDriverPayoutPaymentStatus({
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

      try {
        await assertPayoutItemLedgerLineage({
          supabase,
          payout_item_id: payoutItemId,
          expected_amount_pence: p.amount_pence,
        });
      } catch (lineageErr) {
        await supabase.rpc("abort_driver_payout_submission_claim", {
          p_payout_item_id: payoutItemId,
          p_claim_token: String(claimSub.claim_token),
          p_failure_code: "PAYOUT_LINEAGE_MISSING",
          p_failure_reason_safe: lineageErr instanceof Error ? lineageErr.message : "lineage missing",
        });
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE,
          error: "PAYOUT_LINEAGE_MISSING",
        });
        continue;
      }

      // Immutable evidence of the funding this /pay relies on. No snapshot → no /pay.
      let fundingSnapshotOk = false;
      try {
        const snapshot = buildPayoutFundingAttemptSnapshot({
          run_id: runId,
          schedule_occurrence_key: occurrenceKey,
          payout_item_id: payoutItemId,
          intent_id: String(claimSub.intent_id ?? ""),
          driver_id: p.driver_id,
          claim_token: String(claimSub.claim_token),
          source_account_id: sourceAccountId,
          source_account_label: sourceLabel,
          balance_read_at: balanceReadAt,
          provider_available_pence: Number(fundingAvailable ?? 0),
          decision: fundingDecision,
        });
        if (!claimSub.intent_id) throw new Error("claim returned no intent_id");
        const { error: snapErr } = await supabase
          .from("driver_payout_funding_attempt_snapshots")
          .insert({
            intent_id: snapshot.intent_id,
            payout_item_id: snapshot.payout_item_id,
            driver_id: snapshot.driver_id,
            claim_token: snapshot.claim_token,
            run_id: snapshot.run_id,
            schedule_occurrence_key: snapshot.schedule_occurrence_key,
            source_account_id: snapshot.source_account_id,
            balance_read_at: snapshot.balance_read_at,
            provider_available_pence: snapshot.provider_available_pence,
            remaining_before_pence: snapshot.remaining_before_pence,
            amount_pence: snapshot.amount_pence,
            remaining_after_pence: snapshot.remaining_after_pence,
            snapshot,
          });
        if (snapErr) throw new Error(snapErr.message);
        fundingSnapshotOk = true;
      } catch (snapshotErr) {
        await supabase.rpc("abort_driver_payout_submission_claim", {
          p_payout_item_id: payoutItemId,
          p_claim_token: String(claimSub.claim_token),
          p_failure_code: "FUNDING_SNAPSHOT_FAILED",
          p_failure_reason_safe: snapshotErr instanceof Error ? snapshotErr.message : "funding snapshot failed",
        });
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE,
          error: "FUNDING_SNAPSHOT_FAILED",
          reservation_kept_active: true,
        });
      }
      if (!fundingSnapshotOk) continue;

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
        http_status: relayResult.status,
        pay_call_explicitly_not_made: relayResult.revolut_pay_called === false
          || relayResult.json?.revolut_pay_called === false,
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
        const uncertain = timedOut || outcome.execution_status === "UNKNOWN";
        itemOutcomes.push({
          driver_id: p.driver_id,
          payout_item_id: payoutItemId,
          status: uncertain
            ? ORCHESTRATOR_ITEM_STATUS.SUBMITTING
            : ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE,
          error: outcome.failure_code ?? ORCHESTRATOR_BLOCKER.PROVIDER_STATUS_PENDING,
          provider_payment_id: providerPaymentId,
          reservation_kept_active: true,
          note: uncertain
            ? "Timeout/unknown â reservation kept; no debit until provider truth known"
            : undefined,
        });
        continue;
      }

      // Finalize when provider completed
      const statusResult = await relayApprovedDriverPayoutPaymentStatus({
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
    } catch (driverErr) {
      // One driver's failure never stops the rest. Unknown point of failure →
      // keep any reservation; the next tick reconciles via claim / intent state.
      itemOutcomes.push({
        driver_id: p.driver_id,
        payout_item_id: itemIdsByDriver.get(p.driver_id) ?? null,
        status: ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE,
        error: "DRIVER_ITEM_EXCEPTION",
        message: driverErr instanceof Error ? driverErr.message : String(driverErr),
        reservation_kept_active: true,
      });
    }
  }

  const reversalChecks = await pollCompletedPayoutReversals(supabase);

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
    period_start: occurrencePeriod.period_start,
    period_end: occurrencePeriod.period_end,
    period_timezone: occurrencePeriod.timezone,
    weekly_fee_pence: WEEKLY_PAYOUT_FEE_PENCE,
    money_amount_source: moneyAmounts.source,
    batch_id: batchId,
    batch_status: agg.status,
    funding: fundingGate,
    items: itemOutcomes,
    stale_items: staleItemOutcomes,
    deleted_drivers_held_for_review: deletedDriversHeldForReview,
    running_funding: runningFunding,
    reversal_checks: reversalChecks,
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
}

const REVERSAL_POLL_MAX_ITEMS = 5;
const REVERSAL_POLL_LOOKBACK_DAYS = 14;
const REVERSAL_POLL_RECHECK_HOURS = 6;

/**
 * Read-only: re-reads recently completed payouts at the provider and flags any
 * that came back failed / reversed. Never touches ledgers, reservations or items —
 * a flagged payout needs manual review before any money correction.
 */
async function pollCompletedPayoutReversals(
  supabase: AnySupabase,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  try {
    const since = new Date(Date.now() - REVERSAL_POLL_LOOKBACK_DAYS * 86_400_000).toISOString();
    const recheckBefore = Date.now() - REVERSAL_POLL_RECHECK_HOURS * 3_600_000;
    const { data: candidates } = await supabase
      .from("payout_items")
      .select("id, driver_id, amount_pence, provider_reference, completed_at")
      .eq("status", "COMPLETED")
      .not("provider_reference", "is", null)
      .gte("completed_at", since)
      .order("completed_at", { ascending: false })
      .limit(REVERSAL_POLL_MAX_ITEMS * 5);
    const rows = (candidates ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) return results;

    const { data: checks } = await supabase
      .from("payout_provider_reversal_checks")
      .select("payout_item_id, last_checked_at, reversal_state, check_count")
      .in("payout_item_id", rows.map((r) => String(r.id)));
    const checkByItem = new Map(
      ((checks ?? []) as Array<Record<string, unknown>>).map((c) => [String(c.payout_item_id), c]),
    );
    const due = rows.filter((r) => {
      const prior = checkByItem.get(String(r.id));
      if (!prior) return true;
      if (prior.reversal_state) return false;
      const last = Date.parse(String(prior.last_checked_at ?? ""));
      return !Number.isFinite(last) || last < recheckBefore;
    }).slice(0, REVERSAL_POLL_MAX_ITEMS);
    if (due.length === 0 || !isRevolutBusinessRelayConfigured()) return results;

    const { accessToken } = await ensureFreshRevolutBusinessAccessToken(supabase);
    for (const row of due) {
      const itemId = String(row.id);
      const providerPaymentId = String(row.provider_reference);
      const status = await relayApprovedDriverPayoutPaymentStatus({
        providerPaymentId,
        accessToken,
        payoutItemId: itemId,
      });
      if (!status.provider_state) {
        results.push({ payout_item_id: itemId, checked: false, error: status.error ?? "no_provider_state" });
        continue;
      }
      const reversal = classifyPayoutReversalProviderState(status.provider_state);
      const prior = checkByItem.get(itemId);
      const nowIso = new Date().toISOString();
      await supabase.from("payout_provider_reversal_checks").upsert({
        payout_item_id: itemId,
        driver_id: row.driver_id ?? null,
        provider_payment_id: providerPaymentId,
        last_checked_at: nowIso,
        last_provider_state: status.provider_state,
        check_count: Number(prior?.check_count ?? 0) + 1,
        ...(reversal ? { reversal_state: reversal, reversal_detected_at: nowIso } : {}),
      }, { onConflict: "payout_item_id" });
      if (reversal) {
        await supabase.from("payout_audit_log").insert({
          driver_id: row.driver_id ?? null,
          payout_type: "weekly",
          event_type: "PROVIDER_REVERSAL_DETECTED",
          requested_amount_pence: Number(row.amount_pence ?? 0),
          provider_error_code: reversal,
          metadata: {
            payout_item_id: itemId,
            provider_payment_id: providerPaymentId,
            provider_state: status.provider_state,
            completed_at: row.completed_at ?? null,
            action_required: "MANUAL_REVIEW_NO_AUTO_CORRECTION",
          },
        });
      }
      results.push({
        payout_item_id: itemId,
        checked: true,
        provider_state: status.provider_state,
        reversal_state: reversal,
      });
    }
  } catch (err) {
    results.push({ error: "REVERSAL_POLL_FAILED", message: err instanceof Error ? err.message : String(err) });
  }
  return results;
}
