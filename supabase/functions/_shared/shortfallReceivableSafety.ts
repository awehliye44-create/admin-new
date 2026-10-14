/**
 * Partial-capture shortfall safety net.
 *
 * After a declined increment the customer receivable SSOT owns the shortfall
 * (recovered on the next booking). If that receivable cannot be saved, the
 * shortfall must still be durable and visible to finance:
 *
 *   receivable (idempotent, retried once)
 *     → finance_shortfall_exceptions row (separate RPC / transaction)
 *       → ops_alerts escalation (separate table) + structured log
 *
 * The payment session `metadata.shortfall_pence` marker written before this
 * runs is the last-resort evidence Financial Reconciliation detects.
 *
 * Never touches TEN, commission, payout, Revolut increment or capture.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { recordReceivableAfterDeclinedIncrement } from "./customerReceivableLifecycle.ts";
import { planCreateReceivableFromDeclinedIncrement } from "./customerReceivableSSOT.ts";

export const SHORTFALL_EXCEPTION_STATUS = {
  OPEN: "OPEN",
  RESOLVED_RECEIVABLE_RECORDED: "RESOLVED_RECEIVABLE_RECORDED",
  WRITTEN_OFF: "WRITTEN_OFF",
} as const;

export const SHORTFALL_SAFETY_STATE = {
  NOT_REQUIRED: "NOT_REQUIRED",
  RECEIVABLE_RECORDED: "RECEIVABLE_RECORDED",
  EXCEPTION_RECORDED: "EXCEPTION_RECORDED",
  ESCALATED_UNRECORDED: "ESCALATED_UNRECORDED",
} as const;

export type ShortfallSafetyState =
  (typeof SHORTFALL_SAFETY_STATE)[keyof typeof SHORTFALL_SAFETY_STATE];

/** Structured log tag operators can alert on when every durable write failed. */
export const SHORTFALL_ESCALATION_LOG_TAG = "FINANCE_ESCALATION_SHORTFALL_UNRECORDED";

export const MAX_RECEIVABLE_ATTEMPTS = 2;

export function buildShortfallExceptionIdempotencyKey(tripId: string): string {
  return `shortfall_exception:trip:${tripId}:declined_waiting_v1`;
}

export function buildShortfallEscalationFingerprint(tripId: string): string {
  return `finance:shortfall_unrecorded:${tripId}`;
}

/**
 * First trips covered by the customer receivables ledger (MK-260923-012/017 backfill).
 * Earlier shortfalls were settled by driver adjustments and must never become new customer debt.
 */
export const CUSTOMER_RECEIVABLES_LEDGER_START_ISO = "2026-09-23T00:00:00.000Z";

export function isWithinReceivablesLedger(createdAt: unknown): boolean {
  const ms = Date.parse(String(createdAt ?? ""));
  return Number.isFinite(ms) && ms >= Date.parse(CUSTOMER_RECEIVABLES_LEDGER_START_ISO);
}

/** Shortfall persisted on the payment session by the partial-capture path (0 when absent). */
export function shortfallPenceFromSessionMarker(
  session: { metadata?: unknown } | null | undefined,
): number {
  const meta = session?.metadata;
  if (!meta || typeof meta !== "object") return 0;
  return pence((meta as Record<string, unknown>).shortfall_pence);
}

export type ShortfallSafetyInput = {
  trip_id: string;
  trip_code?: string | null;
  payment_session_id?: string | null;
  provider_order_id?: string | null;
  customer_id?: string | null;
  expected_fare_pence: number;
  captured_pence: number;
  shortfall_pence: number;
  currency?: string | null;
  pickup_waiting_charge_pence?: number | null;
  provider_state?: string | null;
  /** Which caller path detected the shortfall (partial_capture, zero_capture, already_captured_retry). */
  source: string;
};

export type ShortfallSafetyOutcome = {
  state: ShortfallSafetyState;
  manual_review: boolean;
  shortfall_pence: number;
  receivable_id: string | null;
  receivable_created: boolean;
  exception_id: string | null;
  exception_created: boolean;
  escalated: boolean;
  receivable_attempts: number;
  errors: string[];
};

type RecordReceivable = typeof recordReceivableAfterDeclinedIncrement;

export type ShortfallSafetyDeps = {
  recordReceivable?: RecordReceivable;
  log?: (tag: string, payload: Record<string, unknown>) => void;
};

function pence(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message ?? "");
  }
  return String(err ?? "");
}

function outcome(
  state: ShortfallSafetyState,
  shortfall: number,
  patch: Partial<ShortfallSafetyOutcome>,
): ShortfallSafetyOutcome {
  return {
    state,
    manual_review: state === SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED
      || state === SHORTFALL_SAFETY_STATE.ESCALATED_UNRECORDED,
    shortfall_pence: shortfall,
    receivable_id: null,
    receivable_created: false,
    exception_id: null,
    exception_created: false,
    escalated: false,
    receivable_attempts: 0,
    errors: [],
    ...patch,
  };
}

async function resolveOpenException(
  supabase: SupabaseClient,
  tripId: string,
  receivableId: string,
): Promise<string | null> {
  try {
    const { error } = await supabase.rpc("finance_resolve_shortfall_exception_receivable", {
      p_trip_id: tripId,
      p_receivable_id: receivableId,
    });
    return error ? errText(error) : null;
  } catch (err) {
    return errText(err);
  }
}

async function recordException(
  supabase: SupabaseClient,
  input: ShortfallSafetyInput,
  shortfall: number,
  failurePhase: string,
  failureMessage: string,
): Promise<{ ok: true; id: string; created: boolean } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase.rpc("finance_record_shortfall_exception", {
      p_idempotency_key: buildShortfallExceptionIdempotencyKey(input.trip_id),
      p_trip_id: input.trip_id,
      p_payment_session_id: input.payment_session_id ?? null,
      p_provider_order_id: input.provider_order_id ?? null,
      p_customer_id: input.customer_id ?? null,
      p_currency: (input.currency ?? "gbp").toLowerCase(),
      p_expected_fare_pence: pence(input.expected_fare_pence),
      p_captured_pence: Math.max(0, Math.round(Number(input.captured_pence) || 0)),
      p_shortfall_pence: shortfall,
      p_failure_phase: failurePhase,
      p_failure_message: failureMessage,
      p_metadata: {
        source: input.source,
        trip_code: input.trip_code ?? null,
        provider_state: input.provider_state ?? null,
        pickup_waiting_charge_pence: pence(input.pickup_waiting_charge_pence),
        money_moved: false,
        ten_repair_forbidden: true,
      },
    });
    if (error) return { ok: false, error: errText(error) };
    const row = data as { ok?: boolean; exception_id?: string; created?: boolean } | null;
    if (!row?.ok || !row.exception_id) {
      return { ok: false, error: "finance_record_shortfall_exception returned no exception_id" };
    }
    return { ok: true, id: String(row.exception_id), created: row.created === true };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

async function raiseOpsAlert(
  supabase: SupabaseClient,
  input: ShortfallSafetyInput,
  shortfall: number,
  severity: "warning" | "critical",
  errors: string[],
): Promise<boolean> {
  const unrecorded = severity === "critical";
  try {
    const { error } = await supabase.from("ops_alerts").insert({
      fingerprint: buildShortfallEscalationFingerprint(input.trip_id),
      category: "payment",
      severity,
      status: "open",
      source: "system",
      app: "backend",
      title: unrecorded
        ? `Unrecorded customer shortfall ${shortfall}p — finance action required`
        : `Customer shortfall ${shortfall}p held as finance exception`,
      description: unrecorded
        ? "Partial capture shortfall has no customer receivable and no finance exception. Payment session marker is the only record."
        : "Customer receivable could not be saved. A finance shortfall exception was recorded instead.",
      related_trip_id: input.trip_id,
      related_entity_type: "payment_session",
      related_entity_id: input.payment_session_id ?? null,
      metadata: {
        trip_code: input.trip_code ?? null,
        payment_session_id: input.payment_session_id ?? null,
        provider_order_id: input.provider_order_id ?? null,
        expected_fare_pence: pence(input.expected_fare_pence),
        captured_pence: Math.max(0, Math.round(Number(input.captured_pence) || 0)),
        shortfall_pence: shortfall,
        source: input.source,
        errors,
        money_moved: false,
      },
    });
    // 23505: an open alert with this fingerprint already exists — still escalated.
    return !error || error.code === "23505";
  } catch {
    return false;
  }
}

/**
 * Idempotent: every write is keyed per trip, so retries and duplicate
 * callbacks converge on one receivable, one exception and one open alert.
 */
export async function ensureShortfallReceivableOrException(
  supabase: SupabaseClient,
  input: ShortfallSafetyInput,
  deps: ShortfallSafetyDeps = {},
): Promise<ShortfallSafetyOutcome> {
  const recordReceivable = deps.recordReceivable ?? recordReceivableAfterDeclinedIncrement;
  const log = deps.log ?? ((tag, payload) => console.error(`[shortfallSafety] ${tag}`, JSON.stringify(payload)));

  const receivableArgs = {
    customer_id: input.customer_id ?? null,
    source_trip_id: input.trip_id,
    source_payment_session_id: input.payment_session_id ?? null,
    final_fare_pence: input.expected_fare_pence,
    captured_pence: input.captured_pence,
    shortfall_pence: input.shortfall_pence,
    currency: input.currency ?? "gbp",
    pickup_waiting_charge_pence: input.pickup_waiting_charge_pence ?? null,
    provider_state: input.provider_state ?? null,
  };
  const plan = planCreateReceivableFromDeclinedIncrement(receivableArgs);
  const shortfall = plan.outstanding_amount_pence;

  if (!plan.should_create && plan.reject_reason !== "missing_customer_or_trip") {
    return outcome(SHORTFALL_SAFETY_STATE.NOT_REQUIRED, shortfall, {
      errors: plan.reject_reason ? [plan.reject_reason] : [],
    });
  }
  if (!input.trip_id || shortfall <= 0) {
    return outcome(SHORTFALL_SAFETY_STATE.NOT_REQUIRED, shortfall, {
      errors: ["missing_trip_or_shortfall"],
    });
  }

  const errors: string[] = [];
  let attempts = 0;
  let failurePhase = "RECEIVABLE_PERSISTENCE_UNAVAILABLE";

  if (plan.should_create) {
    while (attempts < MAX_RECEIVABLE_ATTEMPTS) {
      attempts += 1;
      let recv: Awaited<ReturnType<RecordReceivable>>;
      try {
        recv = await recordReceivable(supabase, receivableArgs);
      } catch (err) {
        errors.push(errText(err));
        continue;
      }
      if (recv.ok && recv.data.receivable_id) {
        const resolveErr = await resolveOpenException(supabase, input.trip_id, recv.data.receivable_id);
        if (resolveErr) errors.push(`resolve_exception: ${resolveErr}`);
        return outcome(SHORTFALL_SAFETY_STATE.RECEIVABLE_RECORDED, shortfall, {
          receivable_id: recv.data.receivable_id,
          receivable_created: recv.data.created,
          receivable_attempts: attempts,
          errors,
        });
      }
      errors.push(recv.ok ? "receivable_not_created" : recv.error.message);
    }
  } else {
    failurePhase = "MISSING_CUSTOMER";
    errors.push("missing_customer_or_trip");
  }

  const exception = await recordException(
    supabase,
    input,
    shortfall,
    failurePhase,
    errors.join(" | ").slice(0, 1000),
  );
  if (exception.ok) {
    const escalated = await raiseOpsAlert(supabase, input, shortfall, "warning", errors);
    log("SHORTFALL_EXCEPTION_RECORDED", {
      trip_id: input.trip_id,
      exception_id: exception.id,
      shortfall_pence: shortfall,
      escalated,
    });
    return outcome(SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED, shortfall, {
      exception_id: exception.id,
      exception_created: exception.created,
      escalated,
      receivable_attempts: attempts,
      errors,
    });
  }

  errors.push(`exception: ${exception.error}`);
  const escalated = await raiseOpsAlert(supabase, input, shortfall, "critical", errors);
  log(SHORTFALL_ESCALATION_LOG_TAG, {
    trip_id: input.trip_id,
    trip_code: input.trip_code ?? null,
    payment_session_id: input.payment_session_id ?? null,
    provider_order_id: input.provider_order_id ?? null,
    expected_fare_pence: pence(input.expected_fare_pence),
    captured_pence: Math.max(0, Math.round(Number(input.captured_pence) || 0)),
    shortfall_pence: shortfall,
    ops_alert_written: escalated,
    errors,
  });
  return outcome(SHORTFALL_SAFETY_STATE.ESCALATED_UNRECORDED, shortfall, {
    escalated,
    receivable_attempts: attempts,
    errors,
  });
}
