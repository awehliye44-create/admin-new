/**
 * Persist durable payable snapshots + financial operations (P0).
 * Lease expiry never authorises POST — callers must check decideProviderPostSafety.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type { PayableFareSnapshot } from "./payableFareSnapshotSSOT.ts";
import {
  buildExecutionId,
  buildLogicalIdempotencyKey,
  decideProviderPostSafety,
  type FinancialOpType,
} from "./paymentFinancialOperationSSOT.ts";
import { recordPaymentFinancialEvent } from "./paymentFinancialDiagnosticsSSOT.ts";

function newUlidLike(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function persistPayableFareSnapshot(
  supabase: SupabaseClient,
  args: { tripId: string; snapshot: PayableFareSnapshot },
): Promise<{ id: string; version: number } | { error: string }> {
  const tripId = String(args.tripId).trim();
  // Durable under concurrency: retry version allocation on unique (trip_id, version).
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: latest } = await supabase
      .from("payment_payable_snapshots")
      .select("version")
      .eq("trip_id", tripId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const version = Math.max(0, Math.round(Number(latest?.version) || 0)) + 1;
    const row = {
      trip_id: tripId,
      version,
      source: args.snapshot.source,
      gross_fare_pence: args.snapshot.gross_fare_pence,
      modification_pence: args.snapshot.modification_pence,
      waiting_pence: args.snapshot.waiting_pence,
      discount_pence: args.snapshot.discount_pence,
      airport_pass_through_pence: args.snapshot.airport_pass_through_pence,
      tip_pence: args.snapshot.tip_pence,
      receivables_pence: args.snapshot.receivables_pence,
      total_payable_pence: args.snapshot.total_payable_pence,
      waiting_basis: args.snapshot.waiting_basis,
      currency: args.snapshot.currency,
    };
    const { data, error } = await supabase
      .from("payment_payable_snapshots")
      .insert(row)
      .select("id, version")
      .maybeSingle();
    if (!error && data?.id) {
      return { id: String(data.id), version: Number(data.version) };
    }
    const msg = error?.message ?? "snapshot_insert_failed";
    if (/duplicate|unique|23505/i.test(msg) && attempt < 4) continue;
    return { error: msg };
  }
  return { error: "snapshot_insert_failed_after_retries" };
}

/** Latest immutable payable snapshot for a trip (null if none — never invent). */
export async function loadLatestPayableSnapshot(
  supabase: SupabaseClient,
  tripId: string,
): Promise<
  | { id: string; version: number; total_payable_pence: number; currency: string }
  | null
  | { error: string; missingMigration: boolean }
> {
  try {
    const { data, error } = await supabase
      .from("payment_payable_snapshots")
      .select("id, version, total_payable_pence, currency")
      .eq("trip_id", String(tripId).trim())
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return {
        error: error.message,
        missingMigration: /relation .* does not exist|payment_payable_snapshots/i
          .test(error.message),
      };
    }
    if (!data?.id) return null;
    return {
      id: String(data.id),
      version: Number(data.version),
      total_payable_pence: Math.round(Number(data.total_payable_pence) || 0),
      currency: String(data.currency ?? "GBP"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: msg,
      missingMigration: /relation .* does not exist|payment_payable_snapshots/i.test(msg),
    };
  }
}

export async function claimFinancialOperationForPost(
  supabase: SupabaseClient,
  args: {
    opType: FinancialOpType;
    tripId: string;
    paymentSessionId: string;
    providerOrderId: string;
    targetAmountPence: number;
    payableSnapshotVersion: number;
    payableSnapshotId?: string | null;
    merchantAccountRef?: string | null;
    currency?: string;
    epoch?: number | null;
    leaseMs?: number;
    purpose?: string | null;
  },
): Promise<
  | {
    ok: true;
    executionId: string;
    fence: string;
    operationId: string;
    logicalKey: string;
  }
  | { ok: false; reason: string; action: "reconcile_only" | "busy" | "error" }
> {
  const logicalKey = buildLogicalIdempotencyKey({
    opType: args.opType,
    paymentSessionId: args.paymentSessionId,
    providerOrderId: args.providerOrderId,
    targetAmountPence: args.targetAmountPence,
    payableSnapshotVersion: args.payableSnapshotVersion,
    epoch: args.epoch,
    purpose: args.purpose ?? (args.opType === "CAPTURE" ? "fare" : "fare"),
  });

  const { data: prior } = await supabase
    .from("payment_financial_operations")
    .select(
      "id, state, provider_post_inflight, lease_expires_at, logical_idempotency_key",
    )
    .eq("payment_session_id", args.paymentSessionId)
    .eq("op_type", args.opType)
    .eq("logical_idempotency_key", logicalKey)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const safety = decideProviderPostSafety({
    priorOp: prior
      ? {
        state: String(prior.state),
        provider_post_inflight: prior.provider_post_inflight === true,
        lease_expires_at: prior.lease_expires_at as string | null,
        logical_idempotency_key: String(prior.logical_idempotency_key),
      }
      : null,
    requestedLogicalKey: logicalKey,
    leaseExpired: prior?.lease_expires_at
      ? Date.parse(String(prior.lease_expires_at)) < Date.now()
      : false,
  });
  if (safety.action !== "allow_post") {
    return {
      ok: false,
      reason: safety.reason,
      action: safety.action === "busy" ? "busy" : "reconcile_only",
    };
  }

  const executionId = buildExecutionId({
    opType: args.opType,
    tripId: args.tripId,
    ulid: newUlidLike(),
  });
  const fence = crypto.randomUUID();
  const leaseMs = args.leaseMs ?? 120_000;
  const state = args.opType === "INCREMENT"
    ? "INCREMENT_REQUESTED"
    : args.opType === "CAPTURE"
    ? "CAPTURE_REQUESTED"
    : "RECONCILING";

  const { data: inserted, error } = await supabase
    .from("payment_financial_operations")
    .insert({
      execution_id: executionId,
      fence,
      payment_session_id: args.paymentSessionId,
      trip_id: args.tripId,
      op_type: args.opType,
      logical_idempotency_key: logicalKey,
      state,
      payable_snapshot_id: args.payableSnapshotId ?? null,
      requested_amount_pence: args.targetAmountPence,
      provider_order_id: args.providerOrderId,
      merchant_account_ref: args.merchantAccountRef ?? null,
      currency: args.currency ?? "GBP",
      lease_expires_at: new Date(Date.now() + leaseMs).toISOString(),
      provider_post_inflight: false,
    })
    .select("id")
    .maybeSingle();

  if (error || !inserted?.id) {
    await recordPaymentFinancialEvent(supabase, {
      paymentSessionId: args.paymentSessionId,
      tripId: args.tripId,
      executionId,
      fence,
      opType: args.opType,
      eventType: "claim_failed",
      idempotencyReference: logicalKey,
      detail: { error: error?.message ?? "insert_failed" },
    });
    return { ok: false, reason: error?.message ?? "claim_insert_failed", action: "error" };
  }

  await recordPaymentFinancialEvent(supabase, {
    paymentSessionId: args.paymentSessionId,
    tripId: args.tripId,
    operationId: String(inserted.id),
    executionId,
    fence,
    opType: args.opType,
    eventType: "claimed",
    requestedAmountPence: args.targetAmountPence,
    idempotencyReference: logicalKey,
  });

  return {
    ok: true,
    executionId,
    fence,
    operationId: String(inserted.id),
    logicalKey,
  };
}

/** Mark provider POST dispatched — subsequent workers must reconcile-only. */
export async function markFinancialOperationPostDispatched(
  supabase: SupabaseClient,
  args: {
    operationId: string;
    fence: string;
    opType: FinancialOpType;
    httpStatus?: number | null;
  },
): Promise<void> {
  const pendingState = args.opType === "INCREMENT"
    ? "INCREMENT_PENDING"
    : args.opType === "CAPTURE"
    ? "CAPTURE_PENDING"
    : "RECONCILING";
  await supabase
    .from("payment_financial_operations")
    .update({
      provider_post_dispatched_at: new Date().toISOString(),
      provider_post_inflight: true,
      state: pendingState,
      last_provider_http_status: args.httpStatus ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.operationId)
    .eq("fence", args.fence);
}

export async function completeFinancialOperationFromProvider(
  supabase: SupabaseClient,
  args: {
    operationId: string;
    fence: string;
    state: string;
    confirmedAmountPence?: number | null;
    declineCode?: string | null;
    httpStatus?: number | null;
    correlationId?: string | null;
  },
): Promise<void> {
  await supabase
    .from("payment_financial_operations")
    .update({
      state: args.state,
      provider_confirmed_amount_pence: args.confirmedAmountPence ?? null,
      provider_post_inflight: false,
      decline_code: args.declineCode ?? null,
      last_provider_http_status: args.httpStatus ?? null,
      last_provider_correlation_id: args.correlationId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.operationId)
    .eq("fence", args.fence);
}
