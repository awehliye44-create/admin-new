/**
 * #93C / #94A G2 — Reconcile stale CAPTURE financial_operations from provider GET only.
 *
 * Never POSTs. Never creates a second order.
 * - Provider COMPLETED / captured amount → FULLY_CAPTURED / PARTIALLY_CAPTURED
 * - Provider still AUTHORISED, past lease+grace, no in-flight capture → CAPTURE_FAILED
 *   so the next finalize can claim a fresh logical attempt
 * - PROCESSING / PENDING / unknown → leave alone
 *
 * INCREMENT ops are intentionally out of scope (#96).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { extractConfirmedCaptureAmountPence } from "./paymentHoldProviderTerminalPure.ts";
import { completeFinancialOperationFromProvider } from "./paymentFinancialOperationPersistSSOT.ts";
import { isTerminalFinancialOpState } from "./paymentFinancialOperationSSOT.ts";
import { recordPaymentFinancialEvent } from "./paymentFinancialDiagnosticsSSOT.ts";
import { retrieveRevolutOrder } from "./revolutOrders.ts";

const RECONCILABLE_CAPTURE_STATES = new Set([
  "CAPTURE_REQUESTED",
  "CAPTURE_PENDING",
  "CAPTURE_UNKNOWN",
]);

/** Lease (120s) + grace before marking CAPTURE_FAILED on still-AUTHORISED orders. */
export const STALE_CAPTURE_OP_GRACE_MS = 5 * 60_000;

export type StaleCaptureReconcileResult = {
  operation_id: string;
  payment_session_id: string | null;
  trip_id: string | null;
  prior_state: string;
  action:
    | "FULLY_CAPTURED"
    | "PARTIALLY_CAPTURED"
    | "CAPTURE_FAILED"
    | "LEFT_ALONE"
    | "SKIPPED"
    | "FAILED";
  reason?: string;
  confirmed_amount_pence?: number;
};

function nonNeg(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function decideStaleCaptureReconcileAction(args: {
  priorState: string;
  orderState: string;
  confirmedCapturePence: number | null;
  requestedAmountPence: number;
  ageMs: number;
  graceMs?: number;
}): {
  action: "FULLY_CAPTURED" | "PARTIALLY_CAPTURED" | "CAPTURE_FAILED" | "LEFT_ALONE";
  reason: string;
  confirmedAmountPence?: number;
} {
  const state = String(args.priorState ?? "");
  if (!RECONCILABLE_CAPTURE_STATES.has(state)) {
    return { action: "LEFT_ALONE", reason: "not_reconcilable_state" };
  }
  const orderState = String(args.orderState ?? "").trim().toUpperCase();
  const confirmed = args.confirmedCapturePence != null && args.confirmedCapturePence > 0
    ? Math.round(args.confirmedCapturePence)
    : 0;
  const requested = nonNeg(args.requestedAmountPence);
  const grace = args.graceMs ?? STALE_CAPTURE_OP_GRACE_MS;

  if (confirmed > 0 && (orderState === "COMPLETED" || orderState === "CAPTURED")) {
    if (requested > 0 && confirmed < requested) {
      return {
        action: "PARTIALLY_CAPTURED",
        reason: "provider_partial_capture",
        confirmedAmountPence: confirmed,
      };
    }
    return {
      action: "FULLY_CAPTURED",
      reason: "provider_completed_capture",
      confirmedAmountPence: confirmed,
    };
  }

  if (
    (orderState === "AUTHORISED" || orderState === "AUTHORIZED")
    && confirmed <= 0
    && args.ageMs >= grace
  ) {
    return {
      action: "CAPTURE_FAILED",
      reason: "authorised_past_grace_no_capture",
    };
  }

  if (
    orderState === "PROCESSING"
    || orderState === "PENDING"
    || orderState === "IN_PROGRESS"
  ) {
    return { action: "LEFT_ALONE", reason: `provider_${orderState.toLowerCase()}` };
  }

  return { action: "LEFT_ALONE", reason: `provider_${orderState || "unknown"}` };
}

export async function reconcileStaleCaptureOperationsBatch(
  supabase: SupabaseClient,
  args: {
    limit?: number;
    environment: string;
    secretKey: string;
    dryRun?: boolean;
    nowMs?: number;
  },
): Promise<{ scanned: number; results: StaleCaptureReconcileResult[] }> {
  const limit = Math.min(30, Math.max(1, Number(args.limit ?? 15)));
  const dryRun = args.dryRun === true;
  const now = args.nowMs ?? Date.now();
  const staleBefore = new Date(now - STALE_CAPTURE_OP_GRACE_MS).toISOString();

  const { data: rows } = await supabase
    .from("payment_financial_operations")
    .select(
      "id, fence, state, execution_id, payment_session_id, trip_id, provider_order_id, "
        + "requested_amount_pence, logical_idempotency_key, created_at, updated_at, lease_expires_at",
    )
    .eq("op_type", "CAPTURE")
    .in("state", [...RECONCILABLE_CAPTURE_STATES])
    .lt("updated_at", staleBefore)
    .order("updated_at", { ascending: true })
    .limit(limit);

  const results: StaleCaptureReconcileResult[] = [];
  let scanned = 0;

  for (const row of rows ?? []) {
    scanned += 1;
    const opId = String(row.id);
    const prior = String(row.state ?? "");
    const orderId = String(row.provider_order_id ?? "").trim();
    const sessionId = row.payment_session_id ? String(row.payment_session_id) : null;
    const tripId = row.trip_id ? String(row.trip_id) : null;
    const requested = nonNeg(row.requested_amount_pence);
    const updatedMs = Date.parse(String(row.updated_at ?? row.created_at ?? ""));
    const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : STALE_CAPTURE_OP_GRACE_MS;

    if (!orderId) {
      results.push({
        operation_id: opId,
        payment_session_id: sessionId,
        trip_id: tripId,
        prior_state: prior,
        action: "SKIPPED",
        reason: "missing_provider_order",
      });
      continue;
    }
    if (isTerminalFinancialOpState(prior)) {
      results.push({
        operation_id: opId,
        payment_session_id: sessionId,
        trip_id: tripId,
        prior_state: prior,
        action: "LEFT_ALONE",
        reason: "already_terminal",
      });
      continue;
    }

    try {
      const order = await retrieveRevolutOrder(
        args.environment,
        args.secretKey,
        orderId,
      );
      const orderRec = (order ?? {}) as Record<string, unknown>;
      const orderState = String(orderRec.state ?? "");
      const confirmed = extractConfirmedCaptureAmountPence(orderRec, orderState);
      const decision = decideStaleCaptureReconcileAction({
        priorState: prior,
        orderState,
        confirmedCapturePence: confirmed,
        requestedAmountPence: requested,
        ageMs,
      });

      if (decision.action === "LEFT_ALONE") {
        results.push({
          operation_id: opId,
          payment_session_id: sessionId,
          trip_id: tripId,
          prior_state: prior,
          action: "LEFT_ALONE",
          reason: decision.reason,
        });
        continue;
      }

      if (dryRun) {
        results.push({
          operation_id: opId,
          payment_session_id: sessionId,
          trip_id: tripId,
          prior_state: prior,
          action: decision.action,
          reason: `dry_run:${decision.reason}`,
          confirmed_amount_pence: decision.confirmedAmountPence,
        });
        continue;
      }

      await completeFinancialOperationFromProvider(supabase, {
        operationId: opId,
        fence: String(row.fence),
        state: decision.action,
        confirmedAmountPence: decision.confirmedAmountPence ?? null,
      });
      await recordPaymentFinancialEvent(supabase, {
        paymentSessionId: sessionId ?? "",
        tripId: tripId ?? "",
        operationId: opId,
        executionId: String(row.execution_id ?? ""),
        fence: String(row.fence),
        opType: "CAPTURE",
        eventType: "evidence_reconciled",
        requestedAmountPence: requested,
        providerConfirmedAmountPence: decision.confirmedAmountPence ?? null,
        providerResponseState: decision.action,
        idempotencyReference: String(row.logical_idempotency_key ?? ""),
        detail: { reason: decision.reason, prior_state: prior, order_state: orderState },
      }).catch(() => undefined);

      results.push({
        operation_id: opId,
        payment_session_id: sessionId,
        trip_id: tripId,
        prior_state: prior,
        action: decision.action,
        reason: decision.reason,
        confirmed_amount_pence: decision.confirmedAmountPence,
      });
    } catch (e) {
      results.push({
        operation_id: opId,
        payment_session_id: sessionId,
        trip_id: tripId,
        prior_state: prior,
        action: "FAILED",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { scanned, results };
}
