import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchPerDriverFinancialReconciliation } from "../_shared/perDriverFinancialReconciliation.ts";
import { fetchDriverWalletPayoutSnapshot } from "../_shared/fetchDriverWalletPayoutSnapshot.ts";
import {
  isManualBankPayoutProvider,
  resolveRegionPayoutProvider,
} from "../_shared/manualProviderPayoutSSOT.ts";
import {
  isAdminStripePayoutExecutionEnabled,
  isPayoutVerificationMode,
  PAYOUT_EXECUTION_DISABLED_CODE,
  PAYOUT_EXECUTION_DISABLED_MESSAGE,
  PAYOUT_VERIFICATION_MODE_MESSAGE,
} from "../_shared/payoutExecutionGate.ts";
import {
  applyPayoutControlCentrePolicy,
  loadPayoutControlCentreSettings,
} from "../_shared/payoutControlCentreSettingsSSOT.ts";
import {
  assertAllocationEqualsAmount,
  evaluatePayoutEligibilityGate,
} from "../_shared/payoutAllocationEligibilitySSOT.ts";
import { planEligibleLedgerAllocations } from "../_shared/payoutLedgerHandoffSSOT.ts";
import { resolvePayoutTransferAmountPence } from "../_shared/payoutLedgerConsumeDwlSSOT.ts";
import { toDbBatchStatus, toDbItemStatus } from "../_shared/payoutCanonicalStatusSSOT.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { shouldBlockZeroValuePayoutBatch } from "../_shared/driverPayoutEligibilitySSOT.ts";
import { fetchDriverPayoutEligibility } from "../_shared/fetchDriverPayoutEligibility.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

type DriverResult = {
  driver_id: string;
  driver_name?: string | null;
  status: "READY" | "BLOCKED" | "FAILED";
  failure_reason?: string;
  failure_code?: string;
  net_payable_pence?: number;
  payout_warning_reasons?: string[];
  payout_blocked_reasons?: string[];
  payout_item_id?: string;
};

type AllocationLine = {
  ledger_entry_id: string;
  amount_pence: number;
};

async function allocateEligibleLedgerCredits(args: {
  supabase: ReturnType<typeof createClient>;
  eligibleEntries: Array<{ ledger_entry_id: string; amount_pence: number }>;
  payoutItemId: string;
  amountPence: number;
}): Promise<{ allocations_written: number }> {
  const creditIds = args.eligibleEntries.map((row) => String(row.ledger_entry_id)).filter(Boolean);
  const allocatedByLedger = new Map<string, number>();

  if (creditIds.length > 0) {
    const { data: existing, error: existingError } = await args.supabase
      .from("payout_item_ledger_allocations")
      .select("ledger_entry_id, amount_pence")
      .in("ledger_entry_id", creditIds);
    if (existingError) throw existingError;
    for (const row of existing ?? []) {
      const ledgerId = String(row.ledger_entry_id ?? "");
      if (!ledgerId) continue;
      allocatedByLedger.set(
        ledgerId,
        (allocatedByLedger.get(ledgerId) ?? 0) + Math.max(0, Number(row.amount_pence ?? 0)),
      );
    }
  }

  const lines: AllocationLine[] = planEligibleLedgerAllocations({
    eligible_entries: args.eligibleEntries,
    already_allocated_by_ledger: allocatedByLedger,
    amount_pence: args.amountPence,
  });

  assertAllocationEqualsAmount(lines, args.amountPence);

  const { error: insertError } = await args.supabase
    .from("payout_item_ledger_allocations")
    .insert(lines.map((line) => ({
      payout_item_id: args.payoutItemId,
      ledger_entry_id: line.ledger_entry_id,
      amount_pence: line.amount_pence,
    })));

  if (insertError) throw insertError;
  return { allocations_written: lines.length };
}

/**
 * WEEKLY_MONDAY settlement — creates batch + payout_items per eligible driver.
 * Skips hard-blocked drivers only; soft warnings are included.
 * dry_run: simulate without DB writes. Never executes Stripe transfers.
 * scheduled=true (pg_cron): service-role/cron auth; soft-skips wrong day/time; idempotent per run_date.
 * Zero-batch hard rule: never create batch/item/allocation when nobody is eligible.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const scheduledRun = body.scheduled === true || body.source === "pg_cron";
    let actorUserId: string | null = null;

    if (scheduledRun) {
      const cronAuth = await assertCronOrServiceRoleAuth(req, body as Record<string, unknown>);
      if (!cronAuth.ok) return cronAuth.response;
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: roleData } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();

      if (!roleData) {
        return new Response(JSON.stringify({ error: "Admin access required" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      actorUserId = user.id;
    }

    const verificationMode = isPayoutVerificationMode(body as Record<string, unknown>);
    const stripeExecutionEnabled = isAdminStripePayoutExecutionEnabled();

    if (verificationMode) {
      const regionIdPreview = body.region_id as string | undefined;
      let driverQueryPreview = supabase
        .from("drivers")
        .select("id, region_id, first_name, last_name")
        .eq("approval_status", "approved");
      if (regionIdPreview) driverQueryPreview = driverQueryPreview.eq("region_id", regionIdPreview);
      const { data: driversPreview } = await driverQueryPreview;
      const resultsPreview = (driversPreview ?? []).map((driver) => ({
        driver_id: driver.id,
        driver_name: `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim() || null,
        status: "SIMULATED" as const,
      }));
      return new Response(JSON.stringify({
        success: true,
        dry_run: true,
        verification_mode: true,
        payout_safety_version: "3d.1",
        stripe_execution_disabled: !stripeExecutionEnabled,
        message: PAYOUT_VERIFICATION_MODE_MESSAGE,
        batch_id: null,
        batch_status: "SIMULATED",
        total_amount_pence: 0,
        ready_count: resultsPreview.length,
        blocked_count: 0,
        failed_count: 0,
        warning_count: 0,
        results: resultsPreview,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const regionId = body.region_id as string | undefined;
    const regionPayoutProvider = await resolveRegionPayoutProvider(supabase, regionId ?? null);
    const manualProviderPayout = isManualBankPayoutProvider(regionPayoutProvider);
    const controlCentre = await loadPayoutControlCentreSettings(supabase, {
      serviceAreaId: (body.service_area_id as string | undefined) ?? null,
    });

    if (!controlCentre.payouts_enabled) {
      if (scheduledRun) {
        return new Response(JSON.stringify({
          success: true,
          skipped: true,
          error_code: "PAYOUTS_DISABLED",
          message: "Automatic payouts paused — scheduler idle",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        error: "Automatic payouts are disabled in Payout Ledger settings",
        error_code: "PAYOUTS_DISABLED",
        settings: {
          payout_frequency: controlCentre.payout_frequency,
          weekly_payout_day: controlCentre.weekly_payout_day,
          payout_processing_time: controlCentre.payout_processing_time,
        },
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (controlCentre.payout_frequency === "manual_only") {
      if (scheduledRun) {
        return new Response(JSON.stringify({
          success: true,
          skipped: true,
          error_code: "MANUAL_ONLY_SCHEDULE",
          message: "Frequency is manual_only — scheduler idle",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        error: "Payout frequency is Manual Only — create batches from Payout Ledger actions",
        error_code: "MANUAL_ONLY_SCHEDULE",
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Enforce configured weekly payout day + processing time for scheduler only.
    // Manual "Create weekly batch" from Payout Ledger is not day/time gated.
    // body.force=true also bypasses for ops.
    if (
      scheduledRun &&
      controlCentre.payout_frequency === "weekly" &&
      body.force !== true
    ) {
      const payoutTz = String(controlCentre.payout_timezone ?? "Europe/London").trim() || "Europe/London";
      const now = new Date();
      const londonWeekday = new Intl.DateTimeFormat("en-GB", {
        timeZone: payoutTz,
        weekday: "long",
      }).format(now).toLowerCase();
      const configuredDay = String(controlCentre.weekly_payout_day ?? "monday").toLowerCase();
      if (londonWeekday !== configuredDay) {
        return new Response(JSON.stringify({
          success: true,
          skipped: true,
          error_code: "WRONG_PAYOUT_DAY",
          message: `Scheduler idle — payout day is ${configuredDay}, today is ${londonWeekday} (${payoutTz})`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const configuredTime = String(controlCentre.payout_processing_time ?? "10:00").trim();
      const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(configuredTime);
      if (timeMatch) {
        const configuredMinutes = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
        const londonParts = new Intl.DateTimeFormat("en-GB", {
          timeZone: payoutTz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(now);
        const hour = Number(londonParts.find((p) => p.type === "hour")?.value ?? "0");
        const minute = Number(londonParts.find((p) => p.type === "minute")?.value ?? "0");
        const nowMinutes = hour * 60 + minute;
        if (nowMinutes < configuredMinutes) {
          return new Response(JSON.stringify({
            success: true,
            skipped: true,
            error_code: "WRONG_PAYOUT_TIME",
            message: `Scheduler idle until ${configuredTime} ${payoutTz}`,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }
    }

    if (!stripeExecutionEnabled && !manualProviderPayout) {
      if (scheduledRun) {
        return new Response(JSON.stringify({
          success: true,
          skipped: true,
          error_code: PAYOUT_EXECUTION_DISABLED_CODE,
          message: PAYOUT_EXECUTION_DISABLED_MESSAGE,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        error: PAYOUT_EXECUTION_DISABLED_MESSAGE,
        error_code: PAYOUT_EXECUTION_DISABLED_CODE,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let stripeAvailablePence = 0;
    let stripePendingPence = 0;
    // P0 Slice 8: Stripe platform balance never retrieved for weekly settlement (always 0).

    let driverQuery = supabase
      .from("drivers")
      .select("id, region_id, service_area_id, stripe_account_id, payouts_enabled, onboarding_complete, first_name, last_name, approval_status, driver_status, documents_approved")
      .eq("approval_status", "approved");

    if (regionId) driverQuery = driverQuery.eq("region_id", regionId);
    const serviceAreaId = (body.service_area_id as string | undefined) ?? null;
    if (serviceAreaId) driverQuery = driverQuery.eq("service_area_id", serviceAreaId);

    const { data: drivers, error: driversError } = await driverQuery;
    if (driversError) throw driversError;

    const runDate = new Date().toISOString().slice(0, 10);
    let batchId: string | null = null;

    // Idempotent scheduler: one WEEKLY_MONDAY batch per London calendar day.
    // Manual Create weekly batch is allowed to create additional batches.
    if (!verificationMode && scheduledRun) {
      const { data: existingBatch } = await supabase
        .from("payout_batches")
        .select("id, status, total_amount_pence, total_drivers")
        .eq("kind", "WEEKLY_MONDAY")
        .eq("run_date", runDate)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingBatch?.id) {
        return new Response(JSON.stringify({
          success: true,
          skipped: true,
          error_code: "BATCH_ALREADY_EXISTS",
          message: "Weekly batch already exists for this run_date",
          batch_id: existingBatch.id,
          batch_status: existingBatch.status,
          total_amount_pence: existingBatch.total_amount_pence ?? 0,
          ready_count: existingBatch.total_drivers ?? 0,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    async function ensureBatchId(): Promise<string> {
      if (batchId) return batchId;
      if (verificationMode) {
        throw new Error("ensureBatchId called in verification mode");
      }
      const { data: batch, error: batchError } = await supabase
        .from("payout_batches")
        .insert({
          kind: "WEEKLY_MONDAY",
          run_date: runDate,
          status: toDbBatchStatus("DRAFT"),
          total_drivers: 0,
          total_amount_pence: 0,
          created_by: actorUserId,
          notes: scheduledRun ? "created_by=pg_cron_scheduler" : null,
        })
        .select()
        .single();

      if (batchError) throw batchError;
      batchId = batch.id;
      return batchId;
    }

    const results: DriverResult[] = [];
    let totalAmount = 0;
    let successCount = 0;
    let failedCount = 0;
    let blockedCount = 0;
    let warningCount = 0;

    for (const driver of drivers ?? []) {
      const driverName = `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim() || null;

      if (driver.payouts_enabled === false) {
        blockedCount += 1;
        results.push({
          driver_id: driver.id,
          driver_name: driverName,
          status: "BLOCKED",
          failure_reason: "DRIVER_PAYOUTS_DISABLED",
          net_payable_pence: 0,
          payout_blocked_reasons: ["DRIVER_PAYOUTS_DISABLED"],
          payout_warning_reasons: [],
        });
        continue;
      }

      const idempotencyKey = `weekly:${serviceAreaId ?? regionId ?? driver.service_area_id ?? driver.region_id ?? "global"}:${runDate}:${driver.id}`;
      const [walletSnap, payoutEligibility] = await Promise.all([
        fetchDriverWalletPayoutSnapshot(supabase, {
          driverId: driver.id,
          currency: "gbp",
        }),
        fetchDriverPayoutEligibility(supabase, { driver_id: driver.id }),
      ]);
      let ssot: Awaited<ReturnType<typeof fetchPerDriverFinancialReconciliation>> | null = null;
      try {
        ssot = await fetchPerDriverFinancialReconciliation(supabase, {
          driverId: driver.id,
          regionId: driver.region_id,
          providerAvailableBalancePence: manualProviderPayout ? Number.MAX_SAFE_INTEGER : stripeAvailablePence,
          providerPendingBalancePence: stripePendingPence,
          sourceTier: "LIVE",
          manualProviderPayout,
        });
      } catch (frError) {
        console.warn("[admin-weekly-monday-settlement] FR metadata read failed", {
          driver_id: driver.id,
          error: frError instanceof Error ? frError.message : String(frError),
        });
      }

      // PL consumes DWL available — never recalculate availability here.
      const availableBalancePence = Math.max(0, Number(payoutEligibility.available_balance_pence ?? 0));
      const payoutAmountRaw = resolvePayoutTransferAmountPence({
        available_balance_pence: availableBalancePence,
        min_payout_pence: controlCentre.payout_min_pence,
        max_automatic_pence: controlCentre.payout_max_pence,
      });
      const driverStatus = String((driver as { driver_status?: string }).driver_status ?? "").toLowerCase();
      const documentsApproved = (driver as { documents_approved?: boolean }).documents_approved;
      const policy = applyPayoutControlCentrePolicy(payoutAmountRaw, controlCentre, {
        wallet_balance_pence: walletSnap.wallet_balance_pence,
        is_suspended: driverStatus === "suspended" || driverStatus === "blocked" || driverStatus === "banned",
        has_expired_documents: documentsApproved === false,
        manual_review_required: (ssot?.payout_blocked_reasons ?? []).some((r) =>
          String(r).toUpperCase().includes("MANUAL") || String(r).toUpperCase().includes("REVIEW")
        ),
        has_pending_disputes: (ssot?.payout_blocked_reasons ?? []).some((r) =>
          String(r).toUpperCase().includes("DISPUTE")
        ),
        has_pending_chargebacks: (ssot?.payout_blocked_reasons ?? []).some((r) =>
          String(r).toUpperCase().includes("CHARGEBACK")
        ),
      });
      const payoutAmount = policy.amount_pence;
      // Revolut/manual: destination ready when payouts enabled (bank mark-paid path).
      // Legacy Connect ID is evidence only — never required for active Revolut payouts.
      const destinationReady = manualProviderPayout
        ? driver.payouts_enabled !== false
        : Boolean(walletSnap.connected_account_id);
      const eligibility = evaluatePayoutEligibilityGate({
        amount_pence: payoutAmount,
        available_balance_pence: availableBalancePence,
        connected_account: destinationReady,
        payout_destination_ready: destinationReady,
        payouts_paused: driver.payouts_enabled === false,
        min_threshold_pence: controlCentre.payout_min_pence,
        currency: "GBP",
        expected_currency: "GBP",
        idempotency_key: idempotencyKey,
      });
      const frWarningReasons = ssot?.payout_warning_reasons ?? [];
      const frBlockedReasons = ssot?.payout_blocked_reasons ?? [];
      const hasWarnings = frWarningReasons.length > 0 || frBlockedReasons.length > 0 || policy.hold;

      if (!policy.allowed || !eligibility.ok || payoutAmount <= 0) {
        blockedCount += 1;
        results.push({
          driver_id: driver.id,
          driver_name: driverName,
          status: "BLOCKED",
          failure_reason: [
            ...policy.reasons,
            ...eligibility.reasons,
            ...(payoutAmount <= 0 && policy.allowed ? ["No payable balance"] : []),
          ].filter(Boolean).join("; ") || "Hard payout block",
          net_payable_pence: payoutAmount,
          payout_blocked_reasons: [...policy.reasons, ...eligibility.reasons],
          payout_warning_reasons: [...frWarningReasons, ...frBlockedReasons],
        });
        continue;
      }

      if (hasWarnings) warningCount += 1;

      if (verificationMode) {
        successCount += 1;
        totalAmount += payoutAmount;
        results.push({
          driver_id: driver.id,
          driver_name: driverName,
          status: "READY",
          net_payable_pence: payoutAmount,
          payout_warning_reasons: frWarningReasons,
          payout_blocked_reasons: frBlockedReasons,
        });
        continue;
      }

      const ensuredBatchId = await ensureBatchId();
      const { data: item, error: itemError } = await supabase
        .from("payout_items")
        .insert({
          batch_id: ensuredBatchId,
          driver_id: driver.id,
          amount_pence: payoutAmount,
          net_driver_payout_pence: payoutAmount,
          status: toDbItemStatus("PENDING"),
          settlement_status: "READY",
          driver_stripe_account_id: driver.stripe_account_id,
          provider_response: {
            payout_provider: regionPayoutProvider,
            manual_provider_payout: manualProviderPayout,
            idempotency_key: idempotencyKey,
            available_balance_source: "driver_wallet_ledger.available_balance_pence",
            available_balance_pence: availableBalancePence,
            eligible_entry_count: payoutEligibility.eligible_entries.length,
            dwl_wallet_balance_pence: walletSnap.wallet_balance_pence,
            payout_warning_reasons: frWarningReasons,
            payout_blocked_reasons: frBlockedReasons,
            fr_metadata_only: true,
            wallet_reconciliation_status: walletSnap.reconciliation_status,
            wallet_reconciliation_reasons: walletSnap.reconciliation_reasons,
          },
        })
        .select()
        .single();

      if (itemError || !item) {
        failedCount += 1;
        results.push({
          driver_id: driver.id,
          driver_name: driverName,
          status: "FAILED",
          failure_code: "PAYOUT_ITEM_CREATE_FAILED",
          failure_reason: itemError?.message ?? "payout_item insert failed",
          payout_warning_reasons: frWarningReasons,
        });
        continue;
      }

      try {
        await allocateEligibleLedgerCredits({
          supabase,
          eligibleEntries: payoutEligibility.eligible_entries,
          payoutItemId: item.id,
          amountPence: payoutAmount,
        });
      } catch (allocationError) {
        await supabase
          .from("payout_items")
          .update({
            status: toDbItemStatus("ELIGIBILITY_HOLD"),
            failure_reason: allocationError instanceof Error
              ? allocationError.message
              : "Payout allocation failed",
            provider_response: {
              ...(item.provider_response ?? {}),
              allocation_status: "ELIGIBILITY_HOLD",
              allocation_error: allocationError instanceof Error
                ? allocationError.message
                : String(allocationError),
            },
          })
          .eq("id", item.id);
      }

      totalAmount += payoutAmount;
      successCount += 1;
      results.push({
        driver_id: driver.id,
        driver_name: driverName,
        payout_item_id: item.id,
        status: "READY",
        net_payable_pence: payoutAmount,
        payout_warning_reasons: frWarningReasons,
        payout_blocked_reasons: frBlockedReasons,
      });
    }

    let batchStatus = successCount > 0 ? toDbBatchStatus("SCHEDULED") : toDbBatchStatus("FAILED");
    if (totalAmount > 0 && successCount === 0 && !verificationMode) {
      batchStatus = toDbBatchStatus("FAILED");
    }

    // Hard rule: never create/leave a £0 batch when nobody was eligible.
    const zeroGuard = shouldBlockZeroValuePayoutBatch({
      eligible_driver_count: successCount,
      total_available_pence: totalAmount,
    });
    if (!verificationMode && zeroGuard.block) {
      if (batchId) {
        await supabase.from("payout_batches").delete().eq("id", batchId);
      }
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        error_code: zeroGuard.error_code,
        zero_batch_guard: zeroGuard.error_code,
        message: "No eligible payouts — batch not created",
        batch_id: null,
        batch_status: null,
        total_amount_pence: 0,
        ready_count: 0,
        blocked_count: blockedCount,
        failed_count: failedCount,
        warning_count: warningCount,
        results,
        payout_provider: regionPayoutProvider,
        manual_provider_payout: manualProviderPayout,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!verificationMode && batchId) {
      await supabase.from("payout_batches").update({
        status: batchStatus,
        total_drivers: successCount + blockedCount + failedCount,
        total_amount_pence: totalAmount,
        successful_payouts: 0,
        failed_payouts: failedCount,
        failure_reason: successCount === 0 ? "No eligible drivers for Monday settlement" : null,
        failure_code: null,
        updated_at: new Date().toISOString(),
      }).eq("id", batchId);
    }

    return new Response(JSON.stringify({
      success: true,
      dry_run: verificationMode,
      verification_mode: verificationMode,
      payout_safety_version: '3d.1',
      payout_provider: regionPayoutProvider,
      manual_provider_payout: manualProviderPayout,
      stripe_execution_disabled: !stripeExecutionEnabled && !manualProviderPayout,
      zero_batch_guard: null,
      message: verificationMode ? PAYOUT_VERIFICATION_MODE_MESSAGE : undefined,
      batch_id: batchId,
      batch_status: batchStatus,
      total_amount_pence: totalAmount,
      ready_count: successCount,
      blocked_count: blockedCount,
      failed_count: failedCount,
      warning_count: warningCount,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-weekly-monday-settlement]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
