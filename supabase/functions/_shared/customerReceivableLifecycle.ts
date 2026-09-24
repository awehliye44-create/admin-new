/**
 * Customer receivable lifecycle — RPC callers (hard-fail, no soft-swallow).
 *
 * On persistence failure:
 * - return typed RECEIVABLE_PERSISTENCE_UNAVAILABLE
 * - set MANUAL_REVIEW flag
 * - emit audit / operational error
 * - never claim success / never claim debt recorded or cleared
 *
 * Compatibility may preserve booking/trip outcome, but the financial failure
 * must be visible. Schema must be applied before this Edge code is deployed.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  CUSTOMER_RECEIVABLE_STATUS,
  makeReceivablePersistenceUnavailable,
  planCreateReceivableFromDeclinedIncrement,
  planFoldReceivablesIntoPreauth,
  planReleaseOnCancel,
  planReserveBeforeProviderCall,
  planSettleFromProviderEvidence,
  RECEIVABLE_PERSISTENCE_UNAVAILABLE,
  type CreateReceivablePlan,
  type PreauthReceivableFoldPlan,
  type ProviderSettleEvidence,
  type ReceivablePersistenceUnavailableError,
} from "./customerReceivableSSOT.ts";

export type ReceivableLifecycleResult<T> =
  | { ok: true; data: T }
  | {
    ok: false;
    error: ReceivablePersistenceUnavailableError;
    manual_review: true;
  };

async function auditReceivableFailure(
  supabase: SupabaseClient,
  event: string,
  details: Record<string, unknown>,
): Promise<void> {
  console.error(`[customerReceivable] ${event}`, details);
  try {
    await supabase.from("audit_logs").insert({
      event_type: event,
      details: {
        ...details,
        code: RECEIVABLE_PERSISTENCE_UNAVAILABLE,
        manual_review: true,
      },
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[customerReceivable] audit log failed", err);
  }
}

function isRpcUnavailable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? "");
  return (
    msg.includes("does not exist")
    || msg.includes("schema cache")
    || msg.includes("Could not find the function")
    || msg.includes("customer_receivable_")
  );
}

export async function recordReceivableAfterDeclinedIncrement(
  supabase: SupabaseClient,
  args: {
    customer_id?: string | null;
    source_trip_id: string;
    source_payment_session_id?: string | null;
    source_authorisation_id?: string | null;
    final_fare_pence?: number | null;
    captured_pence?: number | null;
    shortfall_pence?: number | null;
    currency?: string | null;
    pickup_waiting_charge_pence?: number | null;
    provider_state?: string | null;
  },
): Promise<ReceivableLifecycleResult<{
  receivable_id: string;
  created: boolean;
  plan: CreateReceivablePlan;
}>> {
  const plan = planCreateReceivableFromDeclinedIncrement(args);
  if (!plan.should_create) {
    return {
      ok: true,
      data: { receivable_id: "", created: false, plan },
    };
  }

  try {
    const { data, error } = await supabase.rpc(
      "customer_receivable_record_declined_increment",
      {
        p_customer_id: plan.customer_id,
        p_source_trip_id: plan.source_trip_id,
        p_source_payment_session_id: plan.source_payment_session_id,
        p_source_authorisation_id: plan.source_authorisation_id,
        p_source_type: plan.source_type,
        p_reason_code: plan.reason_code,
        p_original_amount_pence: plan.original_amount_pence,
        p_currency: plan.currency,
        p_idempotency_key: plan.idempotency_key,
        p_metadata: plan.metadata,
      },
    );

    if (error) {
      const typed = makeReceivablePersistenceUnavailable(error.message);
      await auditReceivableFailure(supabase, "RECEIVABLE_PERSISTENCE_UNAVAILABLE", {
        phase: "record_declined_increment",
        trip_id: plan.source_trip_id,
        shortfall_pence: plan.outstanding_amount_pence,
        rpc_error: error.message,
        decline_evidence: {
          final_fare_pence: args.final_fare_pence ?? null,
          captured_pence: args.captured_pence ?? null,
          shortfall_pence: args.shortfall_pence ?? plan.outstanding_amount_pence,
          provider_state: args.provider_state ?? null,
        },
        flag: CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW,
      });
      return { ok: false, error: typed, manual_review: true };
    }

    const row = data as {
      ok?: boolean;
      receivable_id?: string;
      created?: boolean;
    } | null;

    if (!row?.ok || !row.receivable_id) {
      const typed = makeReceivablePersistenceUnavailable(
        "record_declined_increment returned no receivable_id",
      );
      await auditReceivableFailure(supabase, "RECEIVABLE_PERSISTENCE_UNAVAILABLE", {
        phase: "record_declined_increment_empty",
        trip_id: plan.source_trip_id,
        rpc_data: row,
        flag: CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW,
      });
      return { ok: false, error: typed, manual_review: true };
    }

    return {
      ok: true,
      data: {
        receivable_id: String(row.receivable_id),
        created: Boolean(row.created),
        plan,
      },
    };
  } catch (err) {
    const typed = makeReceivablePersistenceUnavailable(
      err instanceof Error ? err.message : String(err),
    );
    await auditReceivableFailure(supabase, "RECEIVABLE_PERSISTENCE_UNAVAILABLE", {
      phase: "record_declined_increment_exception",
      trip_id: plan.source_trip_id,
      error: String(err),
      rpc_unavailable: isRpcUnavailable(err),
      flag: CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW,
    });
    return { ok: false, error: typed, manual_review: true };
  }
}

/**
 * Read-only sum of OPEN outstanding for consent quote matching.
 * Does not reserve. Fail-open to 0 on read errors (fold still gate-blocked).
 */
export async function sumOpenReceivableOutstandingForCustomer(
  supabase: SupabaseClient,
  args: { customer_id: string; currency?: string | null },
): Promise<number> {
  const currency = String(args.currency ?? "gbp").trim().toLowerCase() || "gbp";
  try {
    const { data, error } = await supabase
      .from("customer_receivables")
      .select("outstanding_amount_pence")
      .eq("customer_id", args.customer_id)
      .eq("status", CUSTOMER_RECEIVABLE_STATUS.OPEN)
      .eq("currency", currency);
    if (error) return 0;
    return (data ?? []).reduce(
      (s, r) => s + Math.max(0, Math.round(Number(r.outstanding_amount_pence) || 0)),
      0,
    );
  } catch {
    return 0;
  }
}

export async function reserveReceivablesBeforeProviderCall(
  supabase: SupabaseClient,
  args: {
    customer_id: string;
    payment_session_id: string;
    recovery_trip_id?: string | null;
    currency?: string | null;
    ride_fare_pence: number;
    buffer_pence: number;
  },
): Promise<ReceivableLifecycleResult<{
  fold: PreauthReceivableFoldPlan;
  reserved_total_pence: number;
  ordering_ok: boolean;
}>> {
  const ordering = planReserveBeforeProviderCall({
    has_pending_payment_session: Boolean(args.payment_session_id),
    open_receivable_count: 0,
  });
  if (!ordering.ok) {
    const typed = makeReceivablePersistenceUnavailable(
      ordering.reject_reason ?? "ordering_blocked",
    );
    return { ok: false, error: typed, manual_review: true };
  }

  try {
    const { data, error } = await supabase.rpc(
      "customer_receivable_reserve_for_preauth",
      {
        p_customer_id: args.customer_id,
        p_payment_session_id: args.payment_session_id,
        p_recovery_trip_id: args.recovery_trip_id ?? null,
        p_currency: (args.currency ?? "gbp").toLowerCase(),
      },
    );

    if (error) {
      const typed = makeReceivablePersistenceUnavailable(error.message);
      await auditReceivableFailure(supabase, "RECEIVABLE_PERSISTENCE_UNAVAILABLE", {
        phase: "reserve_for_preauth",
        payment_session_id: args.payment_session_id,
        rpc_error: error.message,
        flag: CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW,
      });
      return { ok: false, error: typed, manual_review: true };
    }

    const row = data as {
      ok?: boolean;
      reserved_total_pence?: number;
      receivable_ids?: string[];
      allocations?: Array<{
        receivable_id: string;
        allocated_amount_pence: number;
      }>;
    } | null;

    const reserved = Math.max(0, Math.round(Number(row?.reserved_total_pence) || 0));
    const allocations = (row?.allocations ?? []).map((a) => ({
      receivable_id: String(a.receivable_id),
      allocated_amount_pence: Math.max(0, Math.round(Number(a.allocated_amount_pence) || 0)),
    }));

    const fold: PreauthReceivableFoldPlan = {
      ride_fare_pence: Math.max(0, Math.round(args.ride_fare_pence)),
      buffer_pence: Math.max(0, Math.round(args.buffer_pence)),
      receivables_total_pence: reserved,
      authorised_amount_pence:
        Math.max(0, Math.round(args.ride_fare_pence))
        + Math.max(0, Math.round(args.buffer_pence))
        + reserved,
      receivable_ids: (row?.receivable_ids ?? allocations.map((a) => a.receivable_id)).map(
        String,
      ),
      allocations,
    };

    return {
      ok: true,
      data: {
        fold,
        reserved_total_pence: reserved,
        ordering_ok: true,
      },
    };
  } catch (err) {
    const typed = makeReceivablePersistenceUnavailable(
      err instanceof Error ? err.message : String(err),
    );
    await auditReceivableFailure(supabase, "RECEIVABLE_PERSISTENCE_UNAVAILABLE", {
      phase: "reserve_for_preauth_exception",
      payment_session_id: args.payment_session_id,
      error: String(err),
      flag: CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW,
    });
    return { ok: false, error: typed, manual_review: true };
  }
}

/** Read-only fold preview (no reserve). Prefer reserveReceivablesBeforeProviderCall on live path. */
export function previewFoldReceivables(args: {
  ride_fare_pence: number;
  buffer_pence: number;
  open_receivables: Parameters<typeof planFoldReceivablesIntoPreauth>[0]["open_receivables"];
}): PreauthReceivableFoldPlan {
  return planFoldReceivablesIntoPreauth(args);
}

export async function settleReceivablesFromProviderEvidence(
  supabase: SupabaseClient,
  args: {
    payment_session_id: string;
    evidence: ProviderSettleEvidence;
    current_trip_fare_pence?: number | null;
  },
): Promise<ReceivableLifecycleResult<{ settled: boolean; rpc: unknown }>> {
  const gate = planSettleFromProviderEvidence({
    evidence: args.evidence,
    payment_session_id: args.payment_session_id,
  });
  if (!gate.ok) {
    return {
      ok: true,
      data: { settled: false, rpc: { skipped: true, reason: gate.reject_reason } },
    };
  }

  try {
    const { data, error } = await supabase.rpc(
      "customer_receivable_settle_from_provider_capture",
      {
        p_payment_session_id: args.payment_session_id,
        p_provider_order_id: gate.provider_order_id,
        p_terminal_state: gate.terminal_state,
        p_confirmed_captured_pence: gate.confirmed_captured_pence,
        p_current_trip_fare_pence: args.current_trip_fare_pence ?? 0,
      },
    );
    if (error) {
      const typed = makeReceivablePersistenceUnavailable(error.message);
      await auditReceivableFailure(supabase, "RECEIVABLE_PERSISTENCE_UNAVAILABLE", {
        phase: "settle_from_provider_capture",
        payment_session_id: args.payment_session_id,
        rpc_error: error.message,
        flag: CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW,
      });
      return { ok: false, error: typed, manual_review: true };
    }
    return { ok: true, data: { settled: true, rpc: data } };
  } catch (err) {
    const typed = makeReceivablePersistenceUnavailable(
      err instanceof Error ? err.message : String(err),
    );
    await auditReceivableFailure(supabase, "RECEIVABLE_PERSISTENCE_UNAVAILABLE", {
      phase: "settle_from_provider_capture_exception",
      payment_session_id: args.payment_session_id,
      error: String(err),
      flag: CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW,
    });
    return { ok: false, error: typed, manual_review: true };
  }
}

export async function releaseReceivablesOnCancelIfAllowed(
  supabase: SupabaseClient,
  args: {
    payment_session_id: string;
    provider_order_id?: string | null;
    provider_state?: string | null;
    has_capture?: boolean | null;
    hold_safely_released?: boolean | null;
    reason?: string;
    /** Required when planner returns SETTLE (COMPLETED/CAPTURED). */
    settle_evidence?: ProviderSettleEvidence | null;
    current_trip_fare_pence?: number | null;
  },
): Promise<ReceivableLifecycleResult<{
  action: string;
  released: number;
  settled: boolean;
  reason: string;
}>> {
  const decision = planReleaseOnCancel({
    provider_order_id: args.provider_order_id,
    provider_state: args.provider_state,
    has_capture: args.has_capture,
    hold_safely_released: args.hold_safely_released,
  });

  if (decision.action === "KEEP_RESERVED") {
    return {
      ok: true,
      data: {
        action: decision.action,
        released: 0,
        settled: false,
        reason: decision.reason,
      },
    };
  }

  if (decision.action === "SETTLE") {
    if (!args.settle_evidence) {
      // No evidence — keep reserved; never invent settlement from abandon alone.
      return {
        ok: true,
        data: {
          action: "KEEP_RESERVED",
          released: 0,
          settled: false,
          reason: "settle_requires_provider_evidence",
        },
      };
    }
    const settled = await settleReceivablesFromProviderEvidence(supabase, {
      payment_session_id: args.payment_session_id,
      evidence: args.settle_evidence,
      current_trip_fare_pence: args.current_trip_fare_pence ?? 0,
    });
    if (!settled.ok) return settled as Extract<ReceivableLifecycleResult<never>, { ok: false }>;
    return {
      ok: true,
      data: {
        action: "SETTLE",
        released: 0,
        settled: settled.data.settled === true,
        reason: decision.reason,
      },
    };
  }

  try {
    const { data, error } = await supabase.rpc(
      "customer_receivable_release_reservations",
      {
        p_payment_session_id: args.payment_session_id,
        p_reason: args.reason ?? decision.reason,
      },
    );
    if (error) {
      const typed = makeReceivablePersistenceUnavailable(error.message);
      await auditReceivableFailure(supabase, "RECEIVABLE_PERSISTENCE_UNAVAILABLE", {
        phase: "release_reservations",
        payment_session_id: args.payment_session_id,
        rpc_error: error.message,
        flag: CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW,
      });
      return { ok: false, error: typed, manual_review: true };
    }
    const released = Math.max(
      0,
      Math.round(Number((data as { released?: number } | null)?.released) || 0),
    );
    return {
      ok: true,
      data: {
        action: "RELEASE",
        released,
        settled: false,
        reason: decision.reason,
      },
    };
  } catch (err) {
    const typed = makeReceivablePersistenceUnavailable(
      err instanceof Error ? err.message : String(err),
    );
    await auditReceivableFailure(supabase, "RECEIVABLE_PERSISTENCE_UNAVAILABLE", {
      phase: "release_reservations_exception",
      payment_session_id: args.payment_session_id,
      error: String(err),
      flag: CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW,
    });
    return { ok: false, error: typed, manual_review: true };
  }
}

/**
 * Abandon / cancel race helper — same planner, idempotent RPCs.
 * Safe to call from abandon-payment-session and cancel-payment-session.
 */
export async function reconcileReceivablesOnAbandonOrCancel(
  supabase: SupabaseClient,
  args: Parameters<typeof releaseReceivablesOnCancelIfAllowed>[1],
): Promise<ReceivableLifecycleResult<{
  action: string;
  released: number;
  settled: boolean;
  reason: string;
}>> {
  return releaseReceivablesOnCancelIfAllowed(supabase, args);
}
