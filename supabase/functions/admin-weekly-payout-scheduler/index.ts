/**
 * Slice 5 — Canonical weekly payout scheduler.
 * Reads Payout Ledger Settings SSOT every run; creates deterministic batch+items;
 * stops at BLOCKED_EXECUTION_DISABLED. Never reserves/debits wallets or calls Revolut.
 *
 * POST body:
 *   scheduled?: true          — pg_cron path
 *   force?: true              — bypass day/time gate (admin create)
 *   force_schedule_occurrence_key?: string — explicit occurrence (dry-run / ops)
 *   force_local_iso?: string
 *   service_area_id?: string
 *   region_id?: string
 *   dry_run?: true            — compute eligibility without DB writes
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { loadPayoutControlCentreSettings } from "../_shared/payoutControlCentreSettingsSSOT.ts";
import { computeLedgerWalletBalancePence } from "../_shared/onecabFinanceLedger.ts";
import {
  ADMIN_EXECUTION_DISABLED_LABEL,
  CONFLICTING_ACTIVE_ITEM_STATUSES,
  SLICE5_BATCH_STATUS,
  SLICE5_ITEM_STATUS,
  WEEKLY_PAYOUT_BATCH_KIND,
  assertSlice5MoneySafety,
  evaluateDriverBatchEligibility,
  isLivePayoutExecutionEnabled,
  isRevolutPaymentTransportEnabled,
  itemIdempotencyKey,
  itemProviderRequestId,
  resolveMostRecentDueOccurrence,
  resolveScheduleOccurrence,
  shouldBlockExecutionDisabled,
  slugifyServiceAreaName,
  type ScheduleOccurrence,
  type ScheduleSettingsSnapshot,
} from "../_shared/weeklyDriverPayoutBatchWorkflowSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

type AnySupabase = ReturnType<typeof createClient>;

async function assertAdmin(req: Request, supabase: AnySupabase): Promise<
  { ok: true; userId: string } | { ok: false; response: Response }
> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }
  const { data: roleData } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleData) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }
  return { ok: true, userId: user.id };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const live = isLivePayoutExecutionEnabled();
  const transport = isRevolutPaymentTransportEnabled();
  const executionBlocked = shouldBlockExecutionDisabled();

  // Slice 5 must never run when execution flags are on — that is Slice 6+.
  if (live && transport) {
    return new Response(JSON.stringify({
      ok: false,
      error: "slice5_refuses_enabled_execution_flags",
      message: "LIVE + TRANSPORT enabled — stop; do not start Slice 6+ from Slice 5 entry",
      live_payout_execution_enabled: live,
      revolut_payment_transport_enabled: transport,
      slices_6_to_12_started: false,
    }), {
      status: 409,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const scheduledRun = body.scheduled === true || body.source === "pg_cron";
    const dryRun = body.dry_run === true;
    const force = body.force === true
      || Boolean(body.force_schedule_occurrence_key)
      || Boolean(body.force_local_iso);
    let actorUserId: string | null = null;

    if (scheduledRun) {
      const cronAuth = await assertCronOrServiceRoleAuth(req, body as Record<string, unknown>);
      if (!cronAuth.ok) return cronAuth.response;
    } else {
      // Admin JWT or service-role (ops force / dry-run occurrence).
      const cronAuth = await assertCronOrServiceRoleAuth(req, body as Record<string, unknown>);
      if (cronAuth.ok) {
        actorUserId = null;
      } else {
        const adminAuth = await assertAdmin(req, supabase);
        if (!adminAuth.ok) return adminAuth.response;
        actorUserId = adminAuth.userId;
      }
    }

    const serviceAreaId = (body.service_area_id as string | undefined) ?? null;
    const regionId = (body.region_id as string | undefined) ?? null;

    const controlCentre = await loadPayoutControlCentreSettings(supabase, {
      serviceAreaId,
    });

    const settings: ScheduleSettingsSnapshot = {
      payouts_enabled: controlCentre.payouts_enabled,
      payout_frequency: controlCentre.payout_frequency,
      weekly_payout_day: controlCentre.weekly_payout_day,
      payout_processing_time: controlCentre.payout_processing_time,
      payout_timezone: controlCentre.payout_timezone || "Europe/London",
    };

    let serviceAreaSlug = "global";
    let serviceAreaCurrency = "GBP";
    if (serviceAreaId) {
      const { data: sa } = await supabase
        .from("service_areas")
        .select("id, name, currency_code")
        .eq("id", serviceAreaId)
        .maybeSingle();
      if (sa) {
        serviceAreaSlug = slugifyServiceAreaName(sa.name as string);
        serviceAreaCurrency = String(sa.currency_code ?? "GBP").toUpperCase() || "GBP";
      }
    } else {
      // Default UK fleet area for unscoped runs.
      const { data: sa } = await supabase
        .from("service_areas")
        .select("id, name, currency_code")
        .ilike("name", "%milton%keynes%")
        .limit(1)
        .maybeSingle();
      if (sa) {
        serviceAreaSlug = slugifyServiceAreaName(sa.name as string);
        serviceAreaCurrency = String(sa.currency_code ?? "GBP").toUpperCase() || "GBP";
      }
    }

    let occurrence: ScheduleOccurrence | { not_due: true; reason: string; next_run_at_utc: string | null };

    if (body.force_schedule_occurrence_key || body.force_local_iso) {
      occurrence = resolveScheduleOccurrence({
        settings,
        service_area_id: serviceAreaId,
        service_area_slug: serviceAreaSlug,
        currency: serviceAreaCurrency,
        now: new Date(),
        force_local_iso: (body.force_local_iso as string | undefined) ?? null,
        force_schedule_occurrence_key:
          (body.force_schedule_occurrence_key as string | undefined) ?? null,
      });
    } else if (force && !scheduledRun) {
      // Admin "Create weekly batch" — most recent due occurrence for settings day/time.
      occurrence = resolveMostRecentDueOccurrence({
        settings,
        service_area_id: serviceAreaId,
        service_area_slug: serviceAreaSlug,
        currency: serviceAreaCurrency,
        now: new Date(),
      });
    } else {
      occurrence = resolveScheduleOccurrence({
        settings,
        service_area_id: serviceAreaId,
        service_area_slug: serviceAreaSlug,
        currency: serviceAreaCurrency,
        now: new Date(),
      });
    }

    // Scheduled path soft-skips when not due (unless force_* provided).
    if ("not_due" in occurrence && occurrence.not_due) {
      if (scheduledRun && !force) {
        return new Response(JSON.stringify({
          success: true,
          skipped: true,
          error_code: occurrence.reason,
          message: `Scheduler idle — ${occurrence.reason}`,
          next_run_at_utc: occurrence.next_run_at_utc,
          settings: {
            weekly_payout_day: settings.weekly_payout_day,
            payout_processing_time: settings.payout_processing_time,
            payout_timezone: settings.payout_timezone,
            payout_frequency: settings.payout_frequency,
          },
          live_payout_execution_enabled: live,
          revolut_payment_transport_enabled: transport,
          slices_6_to_12_started: false,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        success: false,
        error_code: occurrence.reason,
        message: `Schedule not due (${occurrence.reason}). Pass force_schedule_occurrence_key or force_local_iso to create an occurrence.`,
        next_run_at_utc: occurrence.next_run_at_utc,
        settings,
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotent reuse
    const { data: existingBatch } = await supabase
      .from("payout_batches")
      .select("*")
      .eq("schedule_occurrence_key", occurrence.schedule_occurrence_key)
      .maybeSingle();

    if (existingBatch?.id && !dryRun) {
      const { data: existingItems } = await supabase
        .from("payout_items")
        .select(
          "id, driver_id, amount_pence, execution_status, status, payout_destination_id, provider_request_id, idempotency_key, currency",
        )
        .eq("batch_id", existingBatch.id);

      assertSlice5MoneySafety({
        wallet_reserved: false,
        wallet_debited: false,
        revolut_pay_called: false,
        relay_payment_called: false,
        slices_6_to_12_started: false,
      });

      return new Response(JSON.stringify({
        success: true,
        reused: true,
        dry_run: false,
        batch_id: existingBatch.id,
        batch_status: existingBatch.status,
        batch_status_label: adminLabel(existingBatch.status),
        schedule_occurrence_key: existingBatch.schedule_occurrence_key,
        schedule_id: existingBatch.schedule_id,
        scheduled_local_at: existingBatch.scheduled_local_at,
        scheduled_utc_at: existingBatch.scheduled_utc_at,
        timezone: existingBatch.timezone,
        currency: existingBatch.currency ?? "GBP",
        eligible_driver_count: existingBatch.eligible_driver_count
          ?? existingBatch.total_drivers
          ?? 0,
        total_amount_pence: existingBatch.total_amount_pence ?? 0,
        items: existingItems ?? [],
        settings,
        live_payout_execution_enabled: live,
        revolut_payment_transport_enabled: transport,
        execution_blocked: executionBlocked,
        admin_status_label: ADMIN_EXECUTION_DISABLED_LABEL,
        revolut_pay_called: false,
        relay_payment_called: false,
        wallet_reserved: false,
        wallet_debited: false,
        slices_6_to_12_started: false,
        message: "Reused existing batch for schedule occurrence — amounts unchanged",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Load drivers
    let driverQuery = supabase
      .from("drivers")
      .select(
        "id, region_id, service_area_id, first_name, last_name, payouts_enabled, approval_status, driver_status",
      )
      .eq("approval_status", "approved");
    if (regionId) driverQuery = driverQuery.eq("region_id", regionId);
    if (serviceAreaId) driverQuery = driverQuery.eq("service_area_id", serviceAreaId);
    const { data: drivers, error: driversError } = await driverQuery;
    if (driversError) throw driversError;

    const driverIds = (drivers ?? []).map((d) => String(d.id));

    // DWL balances (ledger only — no payment sessions / Revolut / company).
    const ledgerByDriver = new Map<string, Array<{ type: string; amount_pence: number }>>();
    if (driverIds.length > 0) {
      const { data: ledgerRows, error: ledgerError } = await supabase
        .from("driver_wallet_ledger")
        .select("driver_id, type, amount_pence")
        .in("driver_id", driverIds);
      if (ledgerError) throw ledgerError;
      for (const row of ledgerRows ?? []) {
        const id = String(row.driver_id);
        const list = ledgerByDriver.get(id) ?? [];
        list.push({ type: String(row.type ?? ""), amount_pence: Number(row.amount_pence ?? 0) });
        ledgerByDriver.set(id, list);
      }
    }

    // Active destinations (provider-linked).
    const destByDriver = new Map<string, Record<string, unknown>>();
    if (driverIds.length > 0) {
      const { data: dests, error: destError } = await supabase
        .from("driver_payout_destinations")
        .select(
          "id, driver_id, is_active, archived_at, provider_link_status, provider_counterparty_id, provider_recipient_account_id, currency_code",
        )
        .in("driver_id", driverIds)
        .eq("is_active", true)
        .is("archived_at", null);
      if (destError) throw destError;
      for (const d of dests ?? []) {
        const did = String(d.driver_id);
        // Prefer PROVIDER_VERIFIED; otherwise first active.
        const existing = destByDriver.get(did);
        const link = String(d.provider_link_status ?? "").toUpperCase();
        if (!existing || link === "PROVIDER_VERIFIED") {
          destByDriver.set(did, d as Record<string, unknown>);
        }
      }
    }

    // Conflicting active items.
    const conflictDrivers = new Set<string>();
    if (driverIds.length > 0) {
      const { data: activeItems } = await supabase
        .from("payout_items")
        .select("driver_id, status, execution_status, batch_id")
        .in("driver_id", driverIds);
      for (const item of activeItems ?? []) {
        const st = String(item.execution_status ?? item.status ?? "");
        if (CONFLICTING_ACTIVE_ITEM_STATUSES.has(st)) {
          conflictDrivers.add(String(item.driver_id));
        }
      }
    }

    type PlannedItem = {
      driver_id: string;
      driver_name: string | null;
      amount_pence: number;
      payout_destination_id: string;
      provider_counterparty_id: string;
      provider_recipient_account_id: string;
      wallet_snapshot_balance_pence: number;
      wallet_snapshot_available_pence: number;
      eligibility_snapshot: Record<string, unknown>;
      currency: string;
    };

    const planned: PlannedItem[] = [];
    const ineligible: Array<{ driver_id: string; reasons: string[] }> = [];

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

      if (!decision.eligible) {
        ineligible.push({ driver_id: driverId, reasons: decision.reasons });
        continue;
      }

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
        currency: serviceAreaCurrency,
      });
    }

    const totalAmount = planned.reduce((s, p) => s + p.amount_pence, 0);
    const runDate = occurrence.scheduled_utc_at.slice(0, 10);

    if (dryRun) {
      assertSlice5MoneySafety({
        wallet_reserved: false,
        wallet_debited: false,
        revolut_pay_called: false,
        relay_payment_called: false,
        slices_6_to_12_started: false,
      });
      return new Response(JSON.stringify({
        success: true,
        dry_run: true,
        reused: false,
        batch_id: null,
        batch_status: SLICE5_BATCH_STATUS.BLOCKED_EXECUTION_DISABLED,
        batch_status_label: ADMIN_EXECUTION_DISABLED_LABEL,
        schedule_occurrence_key: occurrence.schedule_occurrence_key,
        schedule_id: occurrence.schedule_id,
        scheduled_local_at: occurrence.scheduled_local_at,
        scheduled_utc_at: occurrence.scheduled_utc_at,
        timezone: occurrence.timezone,
        currency: occurrence.currency,
        eligible_driver_count: planned.length,
        total_amount_pence: totalAmount,
        items: planned.map((p) => ({
          ...p,
          execution_status: SLICE5_ITEM_STATUS.BLOCKED_EXECUTION_DISABLED,
        })),
        ineligible,
        settings,
        live_payout_execution_enabled: live,
        revolut_payment_transport_enabled: transport,
        execution_blocked: true,
        revolut_pay_called: false,
        relay_payment_called: false,
        wallet_reserved: false,
        wallet_debited: false,
        slices_6_to_12_started: false,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Create batch DRAFT → ELIGIBILITY_SNAPSHOTTED → ITEMS_CREATED → BLOCKED_EXECUTION_DISABLED
    const { data: batch, error: batchError } = await supabase
      .from("payout_batches")
      .insert({
        kind: WEEKLY_PAYOUT_BATCH_KIND,
        run_date: runDate,
        status: SLICE5_BATCH_STATUS.DRAFT,
        total_drivers: 0,
        total_amount_pence: 0,
        eligible_driver_count: 0,
        created_by: actorUserId,
        service_area_id: occurrence.service_area_id ?? serviceAreaId,
        schedule_id: occurrence.schedule_id,
        schedule_occurrence_key: occurrence.schedule_occurrence_key,
        frequency: occurrence.frequency,
        scheduled_local_at: occurrence.scheduled_local_at,
        scheduled_utc_at: occurrence.scheduled_utc_at,
        timezone: occurrence.timezone,
        currency: occurrence.currency,
        notes: scheduledRun
          ? "created_by=pg_cron_scheduler slice5"
          : "created_by=admin slice5",
      })
      .select()
      .single();

    if (batchError) {
      // Race: another worker inserted the same occurrence key.
      if (String(batchError.message ?? "").includes("schedule_occurrence_key")
        || String(batchError.code) === "23505") {
        const { data: raced } = await supabase
          .from("payout_batches")
          .select("*")
          .eq("schedule_occurrence_key", occurrence.schedule_occurrence_key)
          .maybeSingle();
        if (raced?.id) {
          return new Response(JSON.stringify({
            success: true,
            reused: true,
            batch_id: raced.id,
            batch_status: raced.status,
            schedule_occurrence_key: raced.schedule_occurrence_key,
            total_amount_pence: raced.total_amount_pence ?? 0,
            eligible_driver_count: raced.eligible_driver_count ?? 0,
            message: "Race: reused occurrence batch",
            revolut_pay_called: false,
            relay_payment_called: false,
            wallet_reserved: false,
            wallet_debited: false,
            slices_6_to_12_started: false,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }
      throw batchError;
    }

    const batchId = String(batch.id);

    await supabase
      .from("payout_batches")
      .update({
        status: SLICE5_BATCH_STATUS.ELIGIBILITY_SNAPSHOTTED,
        eligible_driver_count: planned.length,
        total_amount_pence: totalAmount,
        total_drivers: planned.length,
      })
      .eq("id", batchId);

    const itemRows = planned.map((p) => ({
      batch_id: batchId,
      driver_id: p.driver_id,
      amount_pence: p.amount_pence,
      net_driver_payout_pence: p.amount_pence,
      status: SLICE5_ITEM_STATUS.CREATED,
      execution_status: SLICE5_ITEM_STATUS.CREATED,
      payout_destination_id: p.payout_destination_id,
      provider_counterparty_id: p.provider_counterparty_id,
      provider_recipient_account_id: p.provider_recipient_account_id,
      currency: p.currency,
      wallet_snapshot_balance_pence: p.wallet_snapshot_balance_pence,
      wallet_snapshot_available_pence: p.wallet_snapshot_available_pence,
      eligibility_snapshot: p.eligibility_snapshot,
      provider_request_id: itemProviderRequestId(batchId, p.driver_id),
      idempotency_key: itemIdempotencyKey(occurrence.schedule_occurrence_key, p.driver_id),
    }));

    if (itemRows.length > 0) {
      const { error: itemsError } = await supabase.from("payout_items").insert(itemRows);
      if (itemsError) {
        await supabase
          .from("payout_batches")
          .update({
            status: SLICE5_BATCH_STATUS.FAILED,
            failure_code: "ITEMS_INSERT_FAILED",
            failure_reason: itemsError.message,
          })
          .eq("id", batchId);
        throw itemsError;
      }
    }

    // Lifecycle: ITEMS_CREATED → validate → BLOCKED_EXECUTION_DISABLED (Slice 5 gate).
    await supabase
      .from("payout_batches")
      .update({
        status: SLICE5_BATCH_STATUS.ITEMS_CREATED,
        eligible_driver_count: planned.length,
        total_amount_pence: totalAmount,
        total_drivers: planned.length,
      })
      .eq("id", batchId);

    await supabase
      .from("payout_items")
      .update({
        status: SLICE5_ITEM_STATUS.VALIDATED,
        execution_status: SLICE5_ITEM_STATUS.VALIDATED,
      })
      .eq("batch_id", batchId)
      .eq("status", SLICE5_ITEM_STATUS.CREATED);

    await supabase
      .from("payout_items")
      .update({
        status: SLICE5_ITEM_STATUS.BLOCKED_EXECUTION_DISABLED,
        execution_status: SLICE5_ITEM_STATUS.BLOCKED_EXECUTION_DISABLED,
      })
      .eq("batch_id", batchId)
      .eq("status", SLICE5_ITEM_STATUS.VALIDATED);

    await supabase
      .from("payout_batches")
      .update({
        status: SLICE5_BATCH_STATUS.BLOCKED_EXECUTION_DISABLED,
        eligible_driver_count: planned.length,
        total_amount_pence: totalAmount,
        total_drivers: planned.length,
        failure_code: executionBlocked ? "BLOCKED_EXECUTION_DISABLED" : null,
        failure_reason: executionBlocked
          ? "LIVE_PAYOUT_EXECUTION_ENABLED=false and/or REVOLUT_PAYMENT_TRANSPORT_ENABLED=false"
          : null,
      })
      .eq("id", batchId);

    const { data: savedItems } = await supabase
      .from("payout_items")
      .select(
        "id, driver_id, amount_pence, execution_status, status, payout_destination_id, provider_request_id, idempotency_key, currency, wallet_snapshot_available_pence",
      )
      .eq("batch_id", batchId);

    assertSlice5MoneySafety({
      wallet_reserved: false,
      wallet_debited: false,
      revolut_pay_called: false,
      relay_payment_called: false,
      slices_6_to_12_started: false,
    });

    return new Response(JSON.stringify({
      success: true,
      reused: false,
      dry_run: false,
      batch_id: batchId,
      batch_status: SLICE5_BATCH_STATUS.BLOCKED_EXECUTION_DISABLED,
      batch_status_label: ADMIN_EXECUTION_DISABLED_LABEL,
      schedule_occurrence_key: occurrence.schedule_occurrence_key,
      schedule_id: occurrence.schedule_id,
      scheduled_local_at: occurrence.scheduled_local_at,
      scheduled_utc_at: occurrence.scheduled_utc_at,
      timezone: occurrence.timezone,
      currency: occurrence.currency,
      eligible_driver_count: planned.length,
      total_amount_pence: totalAmount,
      items: savedItems ?? [],
      ineligible,
      settings,
      live_payout_execution_enabled: live,
      revolut_payment_transport_enabled: transport,
      execution_blocked: true,
      admin_status_label: ADMIN_EXECUTION_DISABLED_LABEL,
      revolut_pay_called: false,
      relay_payment_called: false,
      wallet_reserved: false,
      wallet_debited: false,
      slices_6_to_12_started: false,
      message: "Batch created and stopped at BLOCKED_EXECUTION_DISABLED",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[admin-weekly-payout-scheduler]", err);
    return new Response(JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      revolut_pay_called: false,
      relay_payment_called: false,
      wallet_reserved: false,
      wallet_debited: false,
      slices_6_to_12_started: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function adminLabel(status: unknown): string {
  if (String(status) === SLICE5_BATCH_STATUS.BLOCKED_EXECUTION_DISABLED) {
    return ADMIN_EXECUTION_DISABLED_LABEL;
  }
  return String(status ?? "");
}
