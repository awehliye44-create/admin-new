/**
 * #91A — Idempotent PSA increment-row reconciliation from provider evidence.
 *
 * Root cause (MK-261125-002): completion increment POST returned processing →
 * PSA stayed ADDITIONAL_AUTHORISATION_PENDING. A later capture path saw the
 * provider authorised total already cover the payable and skipped
 * executeSameOrderIncrement, so the pending row was never flipped to CONFIRMED.
 *
 * This SSOT reconciles PENDING (and prior-attempt) rows from a retrieved order
 * without POSTing a new increment, capturing, refunding, or wallet credit.
 *
 * Never downgrades a captured/completed/released payment session.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildRevolutIncrementBusinessKey,
  isConfirmedIncrementRowStatus,
  isPriorIncrementAttemptStatus,
} from "./revolutIncrementAuthorisationSSOT.ts";
import {
  classifyIncrementCoverage,
  type RevolutOrder,
} from "./revolutOrders.ts";
import {
  buildRevolutIncrementProviderEvidence,
  providerIncrementOutcome,
} from "./revolutIncrementEvidenceSSOT.ts";

const TERMINAL_SESSION_STATUSES = new Set([
  "captured",
  "completed",
  "capture_confirmed",
  "partial_capture_only",
  "released",
  "cancelled",
  "payment_orphaned",
]);

const TERMINAL_PROVIDER_STATES = new Set([
  "COMPLETED",
  "CAPTURED",
  "CANCELLED",
  "FAILED",
  "REFUNDED",
]);

export type PendingIncrementReconcileAction =
  | "already_confirmed"
  | "confirmed"
  | "declined"
  | "failed_terminal"
  | "left_pending"
  | "skipped";

export type PendingIncrementReconcileResult = {
  authorisationId: string;
  requestedTargetTotalPence: number;
  action: PendingIncrementReconcileAction;
  providerConfirmedTotalPence: number | null;
  coverageClass: string | null;
};

function nonNeg(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function sessionIsTerminal(session: {
  status?: string | null;
  provider_state?: string | null;
  captured_amount_pence?: number | null;
}): boolean {
  const status = String(session.status ?? "").toLowerCase();
  const provider = String(session.provider_state ?? "").toUpperCase();
  if (TERMINAL_SESSION_STATUSES.has(status)) return true;
  if (TERMINAL_PROVIDER_STATES.has(provider)) return true;
  if (nonNeg(session.captured_amount_pence) > 0) return true;
  return false;
}

/**
 * Decide the local PSA status from provider coverage for one target total.
 * Pure — no DB / network.
 */
export function decidePendingIncrementReconcile(args: {
  rowStatus: string | null | undefined;
  requestedTargetTotalPence: number;
  order: RevolutOrder;
}): {
  action: Exclude<PendingIncrementReconcileAction, "skipped">;
  confirmedTotalPence: number;
  coverageClass: string;
  providerState: string;
  incrementState: string | null;
} {
  const target = nonNeg(args.requestedTargetTotalPence);
  if (isConfirmedIncrementRowStatus(args.rowStatus)) {
    return {
      action: "already_confirmed",
      confirmedTotalPence: target,
      coverageClass: "confirmed",
      providerState: String(args.order.state ?? "").toUpperCase(),
      incrementState: null,
    };
  }

  const coverage = classifyIncrementCoverage(args.order, target);
  const evidence = buildRevolutIncrementProviderEvidence({
    order: args.order,
    evidenceSource: "retrieve",
    reference: null,
    targetTotalPence: target,
    previousAuthorisedTotalPence: 0,
    providerAuthorisedTotalPence: coverage.authorisedTotalPence,
    providerOrderId: String(args.order.id ?? ""),
  });
  const outcome = providerIncrementOutcome(evidence);
  const providerState = String(args.order.state ?? "").toUpperCase();

  if (coverage.class === "confirmed" && coverage.authorisedTotalPence >= target) {
    return {
      action: "confirmed",
      confirmedTotalPence: coverage.authorisedTotalPence,
      coverageClass: coverage.class,
      providerState,
      incrementState: evidence.increment_state,
    };
  }

  // Order already captured at/above target implies authorisation succeeded even
  // if the incremental_authorisations entry was still processing when first written.
  const captured = nonNeg(
    (args.order as { captured_amount?: number }).captured_amount
      ?? (Array.isArray(args.order.payments)
        ? args.order.payments.reduce(
          (max, p) => Math.max(max, nonNeg(p?.captured_amount ?? p?.amount)),
          0,
        )
        : 0),
  );
  if (
    (providerState === "COMPLETED" || providerState === "CAPTURED")
    && captured >= target
  ) {
    return {
      action: "confirmed",
      confirmedTotalPence: Math.max(captured, coverage.authorisedTotalPence, target),
      coverageClass: "confirmed",
      providerState,
      incrementState: evidence.increment_state,
    };
  }

  if (outcome === "declined" || String(evidence.increment_state ?? "").toLowerCase() === "declined") {
    return {
      action: "declined",
      confirmedTotalPence: coverage.authorisedTotalPence,
      coverageClass: coverage.class,
      providerState,
      incrementState: evidence.increment_state,
    };
  }

  if (outcome === "failed" || String(evidence.increment_state ?? "").toLowerCase() === "failed") {
    return {
      action: "failed_terminal",
      confirmedTotalPence: coverage.authorisedTotalPence,
      coverageClass: coverage.class,
      providerState,
      incrementState: evidence.increment_state,
    };
  }

  return {
    action: "left_pending",
    confirmedTotalPence: coverage.authorisedTotalPence,
    coverageClass: coverage.class,
    providerState,
    incrementState: evidence.increment_state,
  };
}

/**
 * Reconcile all non-confirmed increment rows for a session/order from a retrieved
 * Revolut order. Idempotent. Never POSTs increment or capture.
 */
export async function reconcilePendingIncrementAuthorisationsFromProvider(
  supabase: SupabaseClient,
  args: {
    paymentSessionId: string;
    providerOrderId: string;
    order: RevolutOrder;
    verifiedBy: string;
    /** Limit to one target (optional). */
    requestedTargetTotalPence?: number | null;
  },
): Promise<{ results: PendingIncrementReconcileResult[] }> {
  const sessionId = String(args.paymentSessionId).trim();
  const orderId = String(args.providerOrderId).trim();
  if (!sessionId || !orderId) return { results: [] };

  const { data: session } = await supabase
    .from("payment_sessions")
    .select(
      "id, status, provider_state, captured_amount_pence, authorised_amount_pence, "
        + "total_authorised_amount_pence, metadata",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return { results: [] };

  let query = supabase
    .from("payment_session_authorisations")
    .select(
      "id, status, requested_target_total_pence, provider_confirmed_total_pence, "
        + "idempotency_key, metadata, sequence_number",
    )
    .eq("payment_session_id", sessionId)
    .eq("provider_order_id", orderId)
    .order("created_at", { ascending: true });

  if (args.requestedTargetTotalPence != null) {
    query = query.eq(
      "requested_target_total_pence",
      Math.round(Number(args.requestedTargetTotalPence)),
    );
  }

  const { data: rows } = await query;
  const results: PendingIncrementReconcileResult[] = [];
  const terminalSession = sessionIsTerminal(session);
  const sessionMetadata = session.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};

  for (const row of rows ?? []) {
    const status = String(row.status ?? "");
    const target = nonNeg(row.requested_target_total_pence);
    if (target <= 0) {
      results.push({
        authorisationId: String(row.id),
        requestedTargetTotalPence: target,
        action: "skipped",
        providerConfirmedTotalPence: null,
        coverageClass: null,
      });
      continue;
    }
    if (isConfirmedIncrementRowStatus(status)) {
      results.push({
        authorisationId: String(row.id),
        requestedTargetTotalPence: target,
        action: "already_confirmed",
        providerConfirmedTotalPence: nonNeg(row.provider_confirmed_total_pence) || target,
        coverageClass: "confirmed",
      });
      continue;
    }
    if (!isPriorIncrementAttemptStatus(status) && status !== "ADDITIONAL_AUTHORISATION_PENDING") {
      results.push({
        authorisationId: String(row.id),
        requestedTargetTotalPence: target,
        action: "skipped",
        providerConfirmedTotalPence: null,
        coverageClass: null,
      });
      continue;
    }

    const decision = decidePendingIncrementReconcile({
      rowStatus: status,
      requestedTargetTotalPence: target,
      order: args.order,
    });

    if (decision.action === "already_confirmed" || decision.action === "left_pending") {
      results.push({
        authorisationId: String(row.id),
        requestedTargetTotalPence: target,
        action: decision.action,
        providerConfirmedTotalPence: decision.confirmedTotalPence || null,
        coverageClass: decision.coverageClass,
      });
      continue;
    }

    const nowIso = new Date().toISOString();
    const businessKey = String(row.idempotency_key ?? "").trim()
      || buildRevolutIncrementBusinessKey({
        paymentSessionId: sessionId,
        providerOrderId: orderId,
        targetTotalAuthorisedPence: target,
      });

    const evidence = buildRevolutIncrementProviderEvidence({
      order: args.order,
      evidenceSource: "retrieve",
      reference: businessKey.slice(0, 100),
      targetTotalPence: target,
      previousAuthorisedTotalPence: 0,
      providerAuthorisedTotalPence: decision.confirmedTotalPence,
      providerOrderId: orderId,
    });

    const metaBase = row.metadata && typeof row.metadata === "object"
      ? { ...(row.metadata as Record<string, unknown>) }
      : {};
    const nextMeta = {
      ...metaBase,
      coverage_class: decision.coverageClass,
      provider_increment_state: decision.incrementState,
      provider_confirmed_total_pence: decision.confirmedTotalPence,
      reconciled_at: nowIso,
      reconciled_by: args.verifiedBy,
      reconcile_action: decision.action,
      provider_evidence: evidence,
    };

    if (decision.action === "confirmed") {
      await supabase
        .from("payment_session_authorisations")
        .update({
          status: "ADDITIONAL_AUTHORISATION_CONFIRMED",
          provider_confirmed_total_pence: decision.confirmedTotalPence,
          cumulative_total_authorised_pence: decision.confirmedTotalPence,
          provider_operation_reference: businessKey,
          provider_state: decision.providerState || null,
          error_classification: null,
          failed_at: null,
          verified_at: nowIso,
          authorised_at: nowIso,
          metadata: nextMeta,
        })
        .eq("id", row.id)
        .neq("status", "ADDITIONAL_AUTHORISATION_CONFIRMED");

      // Never downgrade captured/completed sessions back to authorised_hold.
      if (!terminalSession) {
        // #103: advance total coverage mirror only — never overwrite original hold
        // (authorised_amount_pence / original_authorised_pence).
        const existingTotal = nonNeg(session.total_authorised_amount_pence);
        const nextTotal = Math.max(existingTotal, nonNeg(decision.confirmedTotalPence));
        await supabase
          .from("payment_sessions")
          .update({
            total_authorised_amount_pence: nextTotal,
            provider_state: decision.providerState || "AUTHORISED",
            status: "authorised_hold",
            provider_state_verified_at: nowIso,
            provider_state_verified_by: args.verifiedBy,
            updated_at: nowIso,
            metadata: {
              ...sessionMetadata,
              last_increment_business_key: businessKey,
              last_increment_confirmed_total_pence: decision.confirmedTotalPence,
              last_increment_at: nowIso,
              last_increment_status: "ADDITIONAL_AUTHORISATION_CONFIRMED",
            },
          })
          .eq("id", sessionId);
      } else {
        await supabase
          .from("payment_sessions")
          .update({
            metadata: {
              ...sessionMetadata,
              last_increment_business_key: businessKey,
              last_increment_confirmed_total_pence: decision.confirmedTotalPence,
              last_increment_at: nowIso,
              last_increment_status: "ADDITIONAL_AUTHORISATION_CONFIRMED",
              pending_increment_reconciled_at: nowIso,
              pending_increment_reconciled_by: args.verifiedBy,
            },
            updated_at: nowIso,
          })
          .eq("id", sessionId);
      }

      results.push({
        authorisationId: String(row.id),
        requestedTargetTotalPence: target,
        action: "confirmed",
        providerConfirmedTotalPence: decision.confirmedTotalPence,
        coverageClass: decision.coverageClass,
      });
      continue;
    }

    if (decision.action === "declined") {
      await supabase
        .from("payment_session_authorisations")
        .update({
          status: "ADDITIONAL_AUTHORISATION_DECLINED",
          provider_confirmed_total_pence: decision.confirmedTotalPence > 0
            ? decision.confirmedTotalPence
            : null,
          provider_state: decision.providerState || null,
          error_classification: "AUTHORISED_TOTAL_BELOW_TARGET",
          failed_at: nowIso,
          metadata: nextMeta,
        })
        .eq("id", row.id);
      results.push({
        authorisationId: String(row.id),
        requestedTargetTotalPence: target,
        action: "declined",
        providerConfirmedTotalPence: decision.confirmedTotalPence || null,
        coverageClass: decision.coverageClass,
      });
      continue;
    }

    if (decision.action === "failed_terminal") {
      await supabase
        .from("payment_session_authorisations")
        .update({
          status: "ADDITIONAL_AUTHORISATION_FAILED_TERMINAL",
          provider_confirmed_total_pence: decision.confirmedTotalPence > 0
            ? decision.confirmedTotalPence
            : null,
          provider_state: decision.providerState || null,
          error_classification: "PROVIDER_INCREMENT_FAILED",
          failed_at: nowIso,
          metadata: nextMeta,
        })
        .eq("id", row.id);
      results.push({
        authorisationId: String(row.id),
        requestedTargetTotalPence: target,
        action: "failed_terminal",
        providerConfirmedTotalPence: decision.confirmedTotalPence || null,
        coverageClass: decision.coverageClass,
      });
    }
  }

  return { results };
}
