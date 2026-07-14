/**
 * Slice 6 — Reserve driver wallet funds for a weekly payout batch.
 * Calls atomic reserve_driver_payout_item RPC per item.
 * Stops at FUNDS_RESERVED_EXECUTION_DISABLED. Never calls Revolut /pay.
 *
 * POST {
 *   schedule_occurrence_key?: string,
 *   batch_id?: string,
 *   payout_item_ids?: string[],
 *   driver_ids?: string[],
 *   release?: { reservation_id?: string, payout_item_id?: string, release_reason?: string }
 * }
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  ADMIN_FUNDS_RESERVED_LABEL,
  RESERVATION_ERROR,
  SLICE6_BATCH_STATUS,
  SLICE6_PROOF_DRIVERS,
  assertSlice6MoneySafety,
  isLivePayoutExecutionEnabled,
  isRevolutPaymentTransportEnabled,
  reservationIdempotencyKey,
  sumReservationAmounts,
} from "../_shared/driverPayoutReservationSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
  "Content-Type": "application/json",
};

const DEFAULT_OCCURRENCE = SLICE6_PROOF_DRIVERS.OCCURRENCE_KEY;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  const live = isLivePayoutExecutionEnabled();
  const transport = isRevolutPaymentTransportEnabled();

  // Slice 6 keeps execution flags OFF. Refuse if either is enabled (Slices 7+).
  if (live || transport) {
    return new Response(JSON.stringify({
      ok: false,
      error: "slice6_refuses_enabled_execution_flags",
      live_payout_execution_enabled: live,
      revolut_payment_transport_enabled: transport,
      revolut_pay_called: false,
      wallet_debited: false,
      slices_7_to_12_started: false,
    }), { status: 503, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  // Optional release path (for restore tests) — not used for successful Slice 6 leave-ACTIVE.
  if (body.release && typeof body.release === "object") {
    const rel = body.release as Record<string, unknown>;
    const { data, error } = await supabase.rpc("release_driver_payout_reservation", {
      p_reservation_id: rel.reservation_id ?? null,
      p_payout_item_id: rel.payout_item_id ?? null,
      p_release_reason: rel.release_reason ?? "SYSTEM_ROLLBACK",
    });
    if (error) {
      return new Response(JSON.stringify({
        ok: false,
        error: error.message,
        revolut_pay_called: false,
      }), { status: 500, headers: corsHeaders });
    }
    assertSlice6MoneySafety({
      wallet_debited: false,
      revolut_pay_called: false,
      provider_payment_id_created: false,
      slices_7_to_12_started: false,
    });
    return new Response(JSON.stringify({
      ok: true,
      action: "release",
      result: data,
      revolut_pay_called: false,
      wallet_debited: false,
      live_payout_execution_enabled: false,
      revolut_payment_transport_enabled: false,
      slices_7_to_12_started: false,
    }), { headers: corsHeaders });
  }

  const occurrenceKey = String(
    body.schedule_occurrence_key ?? DEFAULT_OCCURRENCE,
  ).trim();
  const batchIdHint = body.batch_id ? String(body.batch_id).trim() : null;
  const filterItemIds = Array.isArray(body.payout_item_ids)
    ? body.payout_item_ids.map((x) => String(x))
    : null;
  const filterDriverIds = Array.isArray(body.driver_ids)
    ? body.driver_ids.map((x) => String(x))
    : [
      SLICE6_PROOF_DRIVERS.AHMED_ID,
      SLICE6_PROOF_DRIVERS.BOSTEYO_ID,
    ];

  let batchQuery = supabase
    .from("payout_batches")
    .select(
      "id, status, kind, schedule_occurrence_key, total_amount_pence, eligible_driver_count, failure_code",
    )
    .limit(1);

  if (batchIdHint) {
    batchQuery = batchQuery.eq("id", batchIdHint);
  } else {
    batchQuery = batchQuery.eq("schedule_occurrence_key", occurrenceKey);
  }

  const { data: batch, error: batchErr } = await batchQuery.maybeSingle();
  if (batchErr || !batch) {
    return new Response(JSON.stringify({
      ok: false,
      error: RESERVATION_ERROR.BATCH_NOT_ELIGIBLE,
      detail: batchErr?.message ?? "batch_not_found",
      schedule_occurrence_key: occurrenceKey,
      revolut_pay_called: false,
    }), { status: 404, headers: corsHeaders });
  }

  if (String(batch.kind) === "WEEKLY_MONDAY") {
    return new Response(JSON.stringify({
      ok: false,
      error: RESERVATION_ERROR.BATCH_NOT_ELIGIBLE,
      detail: "legacy_weekly_monday_not_altered",
      revolut_pay_called: false,
    }), { status: 400, headers: corsHeaders });
  }

  let itemsQuery = supabase
    .from("payout_items")
    .select(
      "id, driver_id, amount_pence, status, execution_status, payout_destination_id, currency, batch_id",
    )
    .eq("batch_id", batch.id);

  if (filterItemIds?.length) {
    itemsQuery = itemsQuery.in("id", filterItemIds);
  } else if (filterDriverIds?.length) {
    itemsQuery = itemsQuery.in("driver_id", filterDriverIds);
  }

  const { data: items, error: itemsErr } = await itemsQuery;
  if (itemsErr) {
    return new Response(JSON.stringify({
      ok: false,
      error: itemsErr.message,
      revolut_pay_called: false,
    }), { status: 500, headers: corsHeaders });
  }

  const beforeWallets: Record<string, unknown> = {};
  for (const driverId of filterDriverIds) {
    const [liveRes, availRes, reservedRes] = await Promise.all([
      supabase.rpc("driver_wallet_live_balance_pence", { p_driver_id: driverId }),
      supabase.rpc("driver_wallet_available_for_payout_pence", { p_driver_id: driverId }),
      supabase.rpc("driver_wallet_active_reservation_pence", { p_driver_id: driverId }),
    ]);
    beforeWallets[driverId] = {
      live_balance_pence: Number(liveRes.data ?? 0),
      available_pence: Number(availRes.data ?? 0),
      reserved_pence: Number(reservedRes.data ?? 0),
    };
  }

  const results: Array<Record<string, unknown>> = [];
  for (const item of items ?? []) {
    const { data: rpcResult, error: rpcErr } = await supabase.rpc(
      "reserve_driver_payout_item",
      { p_payout_item_id: item.id },
    );
    if (rpcErr) {
      results.push({
        payout_item_id: item.id,
        driver_id: item.driver_id,
        ok: false,
        error: rpcErr.message,
      });
      continue;
    }
    const row = (rpcResult ?? {}) as Record<string, unknown>;
    results.push({
      payout_item_id: item.id,
      driver_id: item.driver_id,
      amount_pence: item.amount_pence,
      idempotency_key: reservationIdempotencyKey(String(item.id)),
      ...row,
    });
  }

  const afterWallets: Record<string, unknown> = {};
  for (const driverId of filterDriverIds) {
    const [liveRes, availRes, reservedRes] = await Promise.all([
      supabase.rpc("driver_wallet_live_balance_pence", { p_driver_id: driverId }),
      supabase.rpc("driver_wallet_available_for_payout_pence", { p_driver_id: driverId }),
      supabase.rpc("driver_wallet_active_reservation_pence", { p_driver_id: driverId }),
    ]);
    afterWallets[driverId] = {
      live_balance_pence: Number(liveRes.data ?? 0),
      available_pence: Number(availRes.data ?? 0),
      reserved_pence: Number(reservedRes.data ?? 0),
    };
  }

  const { data: reservations } = await supabase
    .from("driver_payout_reservations")
    .select("id, payout_item_id, driver_id, amount_pence, status, idempotency_key")
    .eq("payout_batch_id", batch.id)
    .eq("status", "ACTIVE");

  const itemIds = (items ?? []).map((i) => i.id);
  let providerPaymentIds: unknown[] = [];
  if (itemIds.length > 0) {
    const { data: intents } = await supabase
      .from("driver_payout_payment_intents")
      .select("id, payout_item_id, provider_payment_id, execution_status")
      .in("payout_item_id", itemIds);
    providerPaymentIds = (intents ?? [])
      .map((i) => i.provider_payment_id)
      .filter((x) => x != null);
  }

  const { data: batchAfter } = await supabase
    .from("payout_batches")
    .select("id, status, failure_code, total_amount_pence, schedule_occurrence_key, kind")
    .eq("id", batch.id)
    .maybeSingle();

  const fleetReserved = sumReservationAmounts(
    (reservations ?? []).map((r) => ({
      amount_pence: Number(r.amount_pence ?? 0),
      status: String(r.status),
    })),
  );

  const fleetLive = filterDriverIds.reduce((s, id) => {
    const w = afterWallets[id] as { live_balance_pence?: number } | undefined;
    return s + Number(w?.live_balance_pence ?? 0);
  }, 0);
  const fleetAvailable = filterDriverIds.reduce((s, id) => {
    const w = afterWallets[id] as { available_pence?: number } | undefined;
    return s + Number(w?.available_pence ?? 0);
  }, 0);

  // Slice 6 must not create provider payment IDs. Pre-existing Slice 4 dry-run
  // intents may exist with null provider_payment_id — that is fine.
  try {
    assertSlice6MoneySafety({
      wallet_debited: false,
      revolut_pay_called: false,
      relay_payment_called: false,
      provider_payment_id_created: providerPaymentIds.length > 0,
      slices_7_to_12_started: false,
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: String(e instanceof Error ? e.message : e),
      provider_payment_ids: providerPaymentIds,
      revolut_pay_called: false,
      wallet_debited: false,
      slices_7_to_12_started: false,
    }), { status: 500, headers: corsHeaders });
  }

  const allOk = results.every((r) => r.ok === true);

  return new Response(JSON.stringify({
    ok: allOk,
    action: "reserve",
    batch_id: batch.id,
    schedule_occurrence_key: batch.schedule_occurrence_key ?? occurrenceKey,
    batch_status: batchAfter?.status ?? SLICE6_BATCH_STATUS.FUNDS_RESERVED_EXECUTION_DISABLED,
    batch_status_label: ADMIN_FUNDS_RESERVED_LABEL,
    results,
    reservations: reservations ?? [],
    before_wallets: beforeWallets,
    after_wallets: afterWallets,
    fleet: {
      live_balance_pence: fleetLive,
      available_pence: fleetAvailable,
      reserved_pence: fleetReserved,
      paid_pence: 0,
    },
    provider_payment_ids: providerPaymentIds,
    revolut_pay_called: false,
    relay_payment_called: false,
    wallet_debited: false,
    live_payout_execution_enabled: false,
    revolut_payment_transport_enabled: false,
    slices_7_to_12_started: false,
  }), {
    status: allOk ? 200 : 422,
    headers: corsHeaders,
  });
});
